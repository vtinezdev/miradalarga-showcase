/**
 * El SQL que `jobs/ops/` **emite**, y en qué orden.
 *
 * Misma técnica que `migracion-inicial.test.ts`: no se comprueba lo que el
 * diseño declara, sino lo que de verdad saldría por el cable. Sin red y sin
 * base de datos — un `EjecutorSql` falso que apunta todo lo que le piden.
 *
 * Lo que vigila aquí es exactamente lo que, si se rompiera, no fallaría:
 *
 *  · si el `UPDATE` de la reserva saliera fuera de la transacción del lock,
 *    dos jobs volverían a poder pasarse del techo, y **nada daría error**;
 *  · si el `INSERT` de la fila nueva se emitiera antes de reconciliar
 *    huérfanas, la ejecución se mataría a sí misma al nacer;
 *  · si una denegación de cuota se mapeara a `failed`, el corte de presupuesto
 *    dejaría de verse en `ops_sync_runs`, que es el único sitio donde vive.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { escribirCheckpoint, leerUltimoCheckpoint } from "../../jobs/ops/checkpoint.ts";
import {
  ArranqueDenegado,
  PresupuestoAgotado,
  type EjecutorSql,
} from "../../jobs/ops/contratos.ts";
import {
  MUESTRA_DE_CORTE_POR_UMBRAL,
  buscarCorteVigente,
} from "../../jobs/ops/cuota-proveedor.ts";
import { crearMedidor, ejecutarJob } from "../../jobs/ops/ejecucion.ts";
import {
  calcularCiclo,
  leerPresupuesto,
  reservar,
} from "../../jobs/ops/presupuesto.ts";
import {
  TIEMPO_MAXIMO_POR_REQUEST_MS,
  crearTransporte,
} from "../../jobs/ops/transporte.ts";

interface Llamada {
  readonly texto: string;
  readonly valores: readonly unknown[];
}

interface Consumos {
  readonly total: number;
  readonly del_pipeline: number;
  readonly de_esta: number;
}

/** Un ejecutor que apunta todo y contesta lo que se le diga. */
function crearEspia(opciones?: {
  readonly consumos?: Consumos;
  readonly lockConcedido?: boolean;
  readonly huerfanas?: readonly unknown[];
}) {
  const llamadas: Llamada[] = [];

  const responder = (texto: string): readonly unknown[] => {
    if (texto.includes("pg_try_advisory_lock")) {
      return [{ tomado: opciones?.lockConcedido ?? true }];
    }
    if (texto.includes("FROM ops_sync_runs")) {
      return [opciones?.consumos ?? { total: 0, del_pipeline: 0, de_esta: 0 }];
    }
    if (texto.includes("INSERT INTO ops_sync_runs")) return [{ id: 7 }];
    if (texto.includes("RETURNING id, requests_made")) return opciones?.huerfanas ?? [];
    return [];
  };

  const ejecutor: EjecutorSql = {
    ejecutar<T>(
      texto: string,
      valores: readonly unknown[] = [],
    ): Promise<readonly T[]> {
      llamadas.push({ texto, valores });
      return Promise.resolve(responder(texto) as readonly T[]);
    },
  };

  return {
    ejecutor,
    llamadas,
    /** Índice de la primera llamada que contiene ese texto, o -1. */
    indiceDe(fragmento: string): number {
      return llamadas.findIndex((l) => l.texto.includes(fragmento));
    },
    hay(fragmento: string): boolean {
      return llamadas.some((l) => l.texto.includes(fragmento));
    },
  };
}

/**
 * Configuración **inyectada** para probar el mecanismo.
 *
 * ⚠️ Los valores por defecto del repositorio tienen `seed` a 0 en los dos
 * mapas, porque ningún job está aprobado para gastar API. Un test que quiera
 * ver una reserva concedida **inyecta su propia configuración**; no se habilita
 * un pipeline real para que una prueba pase.
 */
const PRESUPUESTO = leerPresupuesto({
  STREAMING_API_MONTHLY_BUDGET: "1000",
  STREAMING_API_MONTHLY_PIPELINE_BUDGETS: "seed=900,deltas=900",
  STREAMING_API_PER_RUN_CAPS: "seed=900,deltas=900",
});
const AHORA = new Date("2026-09-22T10:00:00.000Z");
const CICLO = calcularCiclo(AHORA, PRESUPUESTO.diaDeCiclo);

describe("la reserva es una transacción serializada", () => {
  it("emite BEGIN, el lock de ciclo, el SELECT, el UPDATE y el COMMIT, en ese orden", async () => {
    const espia = crearEspia({ consumos: { total: 10, del_pipeline: 5, de_esta: 5 } });

    const decision = await reservar(espia.ejecutor, {
      runId: 7,
      pipeline: "seed",
      presupuesto: PRESUPUESTO,
      cicloDeLaEjecucion: CICLO.clave,
      ahora: AHORA,
    });

    expect(decision.concedida).toBe(true);
    const orden = [
      espia.indiceDe("BEGIN"),
      espia.indiceDe("pg_advisory_xact_lock"),
      espia.indiceDe("FROM ops_sync_runs"),
      espia.indiceDe("UPDATE ops_sync_runs SET requests_made"),
      espia.indiceDe("COMMIT"),
    ];
    expect(orden).not.toContain(-1);
    expect(orden).toEqual([...orden].sort((a, b) => a - b));
  });

  it("toma el lock ANTES de leer el consumo: leer primero no serializa nada", async () => {
    const espia = crearEspia();
    await reservar(espia.ejecutor, {
      runId: 7,
      pipeline: "seed",
      presupuesto: PRESUPUESTO,
      cicloDeLaEjecucion: CICLO.clave,
      ahora: AHORA,
    });
    expect(espia.indiceDe("pg_advisory_xact_lock")).toBeLessThan(
      espia.indiceDe("FROM ops_sync_runs"),
    );
  });

  it("usa la variante _xact_, que se suelta sola en el COMMIT", async () => {
    const espia = crearEspia();
    await reservar(espia.ejecutor, {
      runId: 7,
      pipeline: "seed",
      presupuesto: PRESUPUESTO,
      cicloDeLaEjecucion: CICLO.clave,
      ahora: AHORA,
    });
    expect(espia.hay("pg_advisory_xact_lock")).toBe(true);
    expect(espia.hay("pg_advisory_lock(")).toBe(false);
  });

  it("acota el consumo a la ventana del ciclo y al pipeline pedido", async () => {
    const espia = crearEspia();
    await reservar(espia.ejecutor, {
      runId: 7,
      pipeline: "deltas",
      presupuesto: PRESUPUESTO,
      cicloDeLaEjecucion: CICLO.clave,
      ahora: AHORA,
    });
    const consulta = espia.llamadas[espia.indiceDe("FROM ops_sync_runs")];
    expect(consulta).toBeDefined();
    expect(consulta?.texto).toMatch(/started_at >= \$1 AND started_at < \$2/);
    expect(consulta?.valores[0]).toEqual(CICLO.inicio);
    expect(consulta?.valores[1]).toEqual(CICLO.fin);
    expect(consulta?.valores[2]).toBe("deltas");
    expect(consulta?.valores[3]).toBe(7);
  });

  it("al denegar, cierra la transacción y NO escribe nada", async () => {
    const espia = crearEspia({ consumos: { total: 900, del_pipeline: 0, de_esta: 0 } });
    const decision = await reservar(espia.ejecutor, {
      runId: 7,
      pipeline: "seed",
      presupuesto: PRESUPUESTO,
      cicloDeLaEjecucion: CICLO.clave,
      ahora: AHORA,
    });

    expect(decision.concedida).toBe(false);
    expect(espia.hay("UPDATE ops_sync_runs SET requests_made")).toBe(false);
    expect(espia.hay("ROLLBACK")).toBe(true);
    expect(espia.hay("COMMIT")).toBe(false);
  });

  it("si el ciclo cambió a mitad de ejecución no abre ni una transacción", async () => {
    const espia = crearEspia();
    const decision = await reservar(espia.ejecutor, {
      runId: 7,
      pipeline: "seed",
      presupuesto: PRESUPUESTO,
      cicloDeLaEjecucion: 202608,
      ahora: AHORA,
    });
    expect(decision.concedida).toBe(false);
    if (!decision.concedida) expect(decision.motivo).toBe("frontera_de_ciclo");
    expect(espia.llamadas).toHaveLength(0);
  });
});

describe("el ciclo de vida de la fila", () => {
  const abrirJob = (
    espia: ReturnType<typeof crearEspia>,
    cuerpo = () => Promise.resolve(),
  ) =>
    ejecutarJob(
      espia.ejecutor,
      { pipeline: "seed", presupuesto: PRESUPUESTO, ahora: AHORA, commitSha: "abc123" },
      cuerpo,
    );

  it("reconcilia huérfanas ANTES de insertar la fila nueva", async () => {
    const espia = crearEspia();
    await abrirJob(espia);
    // Invertido, el UPDATE de huérfanas alcanzaría a la fila recién creada.
    expect(espia.indiceDe("RETURNING id, requests_made")).toBeLessThan(
      espia.indiceDe("INSERT INTO ops_sync_runs"),
    );
  });

  it("toma el lock del pipeline antes de reconciliar: sin él no hay prueba de muerte", async () => {
    const espia = crearEspia();
    await abrirJob(espia);
    expect(espia.indiceDe("pg_try_advisory_lock")).toBe(0);
    expect(espia.indiceDe("pg_try_advisory_lock")).toBeLessThan(
      espia.indiceDe("RETURNING id, requests_made"),
    );
  });

  it("solo alcanza a las filas que siguen en running", async () => {
    const espia = crearEspia();
    await abrirJob(espia);
    const huerfanas = espia.llamadas[espia.indiceDe("RETURNING id, requests_made")];
    expect(huerfanas?.texto).toMatch(/status = 'running' AND finished_at IS NULL/);
    expect(huerfanas?.texto).toMatch(/error_count\s*=\s*error_count \+ 1/);
    expect(huerfanas?.texto).toMatch(/finished_at\s*=\s*now\(\)/);
  });

  it("deja la huérfana en failed y con una muestra que dice por qué", async () => {
    const espia = crearEspia();
    await abrirJob(espia);
    const huerfanas = espia.llamadas[espia.indiceDe("RETURNING id, requests_made")];
    expect(huerfanas?.texto).toMatch(/status\s*=\s*'failed'/);
    const muestra = JSON.stringify(huerfanas?.valores[1]);
    expect(muestra).toContain("ejecucion_huerfana");
    // El instante de la muerte nadie lo observó, y la muestra no lo finge.
    expect(muestra).toContain("DETECCI");
  });

  it("no toca requests_made de la huérfana: esa cuota se gastó de verdad", async () => {
    const espia = crearEspia();
    await abrirJob(espia);
    const huerfanas = espia.llamadas[espia.indiceDe("RETURNING id, requests_made")];
    expect(huerfanas?.texto).not.toMatch(/SET[\s\S]*requests_made\s*=/);
  });

  it("graba en budget_limit el umbral operativo (900), no el bruto (1000)", async () => {
    const espia = crearEspia();
    await abrirJob(espia);
    const alta = espia.llamadas[espia.indiceDe("INSERT INTO ops_sync_runs")];
    expect(alta?.valores[0]).toBe("seed");
    expect(alta?.valores[1]).toEqual(AHORA);
    expect(alta?.valores[2]).toBe(900);
    expect(alta?.valores[3]).toBe("abc123");
  });

  it("si otra ejecución está viva, no crea fila ni toca nada", async () => {
    const espia = crearEspia({ lockConcedido: false });
    const resultado = await abrirJob(espia);
    expect(resultado.ejecutado).toBe(false);
    expect(espia.hay("INSERT INTO ops_sync_runs")).toBe(false);
    expect(espia.hay("RETURNING id, requests_made")).toBe(false);
  });

  it("suelta el lock aunque el cuerpo reviente", async () => {
    const espia = crearEspia();
    const resultado = await abrirJob(espia, () => Promise.reject(new Error("boom")));
    expect(resultado.ejecutado).toBe(true);
    if (resultado.ejecutado) expect(resultado.estado).toBe("failed");
    expect(espia.hay("pg_advisory_unlock")).toBe(true);
  });
});

describe("el estado final dice la verdad", () => {
  const CIERRE = "SET status              = $2";

  const correr = (
    espia: ReturnType<typeof crearEspia>,
    cuerpo: Parameters<typeof ejecutarJob>[2],
  ) =>
    ejecutarJob(
      espia.ejecutor,
      { pipeline: "seed", presupuesto: PRESUPUESTO, ahora: AHORA, commitSha: null },
      cuerpo,
    );

  it("una denegación de cuota es budget_stopped, nunca failed", async () => {
    const espia = crearEspia({ consumos: { total: 900, del_pipeline: 0, de_esta: 0 } });
    const resultado = await correr(espia, (ctx) => ctx.pedirCuota());
    expect(resultado.ejecutado).toBe(true);
    if (resultado.ejecutado) expect(resultado.estado).toBe("budget_stopped");
  });

  it("un cruce de ciclo es failed: no fue la cuota quien paró esto", async () => {
    const espia = crearEspia();
    const resultado = await ejecutarJob(
      espia.ejecutor,
      { pipeline: "seed", presupuesto: PRESUPUESTO, ahora: AHORA, commitSha: null },
      async (ctx) => {
        // Se fuerza el desfase para provocar la frontera sin esperar un mes.
        await reservarFueraDeCiclo(espia.ejecutor, ctx.runId);
      },
    );
    expect(resultado.ejecutado).toBe(true);
    if (resultado.ejecutado) expect(resultado.estado).toBe("failed");
  });

  it("una ejecución limpia es succeeded y cierra con finished_at", async () => {
    const espia = crearEspia();
    const resultado = await correr(espia, () => Promise.resolve());
    if (resultado.ejecutado) expect(resultado.estado).toBe("succeeded");
    const cierre = espia.llamadas[espia.indiceDe(CIERRE)];
    expect(cierre?.texto).toMatch(/finished_at\s*=\s*now\(\)/);
    expect(cierre?.valores[1]).toBe("succeeded");
  });

  it("rows_affected es null si nadie declaró filas confirmadas", async () => {
    const espia = crearEspia();
    await correr(espia, () => Promise.resolve());
    expect(espia.llamadas[espia.indiceDe(CIERRE)]?.valores[2]).toBeNull();
  });

  it("rows_affected lleva el recuento por tabla cuando sí lo hubo", async () => {
    const espia = crearEspia();
    await correr(espia, (ctx) => {
      ctx.medidor.filasTocadas("external_titles", 412);
      ctx.medidor.filasTocadas("external_titles", 1);
      ctx.medidor.observar({ multiLinkOffers: 340, farFutureExpiries: 3 });
      return Promise.resolve();
    });
    const cierre = espia.llamadas[espia.indiceDe(CIERRE)];
    expect(cierre?.valores[2]).toBe(JSON.stringify({ external_titles: 413 }));
    expect(cierre?.valores[3]).toBe(340);
    expect(cierre?.valores[4]).toBe(3);
  });
});

/** Pide cuota declarando un ciclo que no es el vigente. */
function reservarFueraDeCiclo(ejecutor: EjecutorSql, runId: number): Promise<void> {
  return reservar(ejecutor, {
    runId,
    pipeline: "seed",
    presupuesto: PRESUPUESTO,
    cicloDeLaEjecucion: 200001,
    ahora: AHORA,
  }).then((decision) => {
    if (!decision.concedida) {
      throw new PresupuestoAgotado({
        motivo: decision.motivo,
        pipeline: "seed",
        consumido: decision.consumido,
        techo: decision.techo,
      });
    }
  });
}

describe("la muestra de errores está acotada y el recuento no", () => {
  it("error_count es el total real, mayor que la muestra guardada", () => {
    const medidor = crearMedidor(2);
    for (let i = 0; i < 7; i++) medidor.registrarError({ i });
    const metricas = medidor.instantanea();
    expect(metricas.errorCount).toBe(7);
    expect(metricas.errorSamples).toHaveLength(2);
    // Que la muestra está truncada se ve comparándola con el total: por eso no
    // hace falta ninguna columna `errors_truncated`.
    expect(metricas.errorSamples.length).toBeLessThan(metricas.errorCount);
  });
});

describe("el checkpoint en la fila (ADR 0006)", () => {
  it("nace en el INSERT, serializado para ::jsonb, antes de cualquier reserva", async () => {
    const espia = crearEspia();
    await ejecutarJob(
      espia.ejecutor,
      {
        pipeline: "seed",
        presupuesto: PRESUPUESTO,
        ahora: AHORA,
        commitSha: null,
        checkpointInicial: () => Promise.resolve({ v: 1, marca: "x" }),
      },
      async (ctx) => {
        await ctx.pedirCuota();
      },
    );
    const insert = espia.llamadas[espia.indiceDe("INSERT INTO ops_sync_runs")];
    expect(insert?.texto).toMatch(/checkpoint\)/);
    expect(insert?.texto).toMatch(/\$5::jsonb/);
    expect(JSON.parse(String(insert?.valores[4]))).toEqual({ v: 1, marca: "x" });
    expect(espia.indiceDe("INSERT INTO ops_sync_runs")).toBeLessThan(
      espia.indiceDe("SET requests_made"),
    );
  });

  it("se calcula DESPUÉS de reconciliar huérfanas: con el lock y sin vivas", async () => {
    const espia = crearEspia();
    let llamadasAlPlanificar = -1;
    await ejecutarJob(
      espia.ejecutor,
      {
        pipeline: "seed",
        presupuesto: PRESUPUESTO,
        ahora: AHORA,
        commitSha: null,
        checkpointInicial: () => {
          llamadasAlPlanificar = espia.llamadas.length;
          return Promise.resolve({ v: 1 });
        },
      },
      () => Promise.resolve(),
    );
    expect(espia.indiceDe("RETURNING id, requests_made")).toBeLessThan(
      llamadasAlPlanificar,
    );
    expect(llamadasAlPlanificar).toBeLessThanOrEqual(
      espia.indiceDe("INSERT INTO ops_sync_runs"),
    );
  });

  it("si el plan es imposible: fila SIN checkpoint, failed, y el cuerpo no corre", async () => {
    const espia = crearEspia();
    let corrio = false;
    const r = await ejecutarJob(
      espia.ejecutor,
      {
        pipeline: "seed",
        presupuesto: PRESUPUESTO,
        ahora: AHORA,
        commitSha: null,
        checkpointInicial: () =>
          Promise.reject(
            new ArranqueDenegado("hueco_irrecuperable", "demasiado viejo"),
          ),
      },
      () => {
        corrio = true;
        return Promise.resolve();
      },
    );
    expect(corrio).toBe(false);
    expect(r.ejecutado && r.estado).toBe("failed");
    expect(espia.hay("SET requests_made")).toBe(false);
    const insert = espia.llamadas[espia.indiceDe("INSERT INTO ops_sync_runs")];
    expect(insert?.valores[4]).toBeNull();
    expect(r.ejecutado && r.metricas.errorSamples[0]).toMatchObject({
      motivo: "hueco_irrecuperable",
    });
  });

  it("avanzar exige una fila VIVA y lanza si no afecta a exactamente una", async () => {
    const espia = crearEspia();
    await expect(escribirCheckpoint(espia.ejecutor, 7, { v: 1 })).rejects.toThrow(
      /no se escribió/,
    );
    const update = espia.llamadas[0];
    expect(update?.texto).toMatch(/SET checkpoint = \$2::jsonb/);
    expect(update?.texto).toMatch(
      /WHERE id = \$1 AND status = 'running' AND finished_at IS NULL/,
    );
    expect(update?.texto).toMatch(/RETURNING id/);
    // No toca requests_made: eso es de la otra conexión.
    expect(update?.texto).not.toMatch(/requests_made/);
  });

  it("leer el último: por pipeline, con checkpoint, el de id más alto", async () => {
    // Sin filas: aquí se mira la consulta, no la conversión del id. (El espía
    // genérico contesta a todo `FROM ops_sync_runs` con una fila de consumos
    // sin `id`, que `idDeEjecucion` rechaza, y con razón.)
    const llamadas: Llamada[] = [];
    const ejecutor: EjecutorSql = {
      ejecutar<T>(texto: string, valores: readonly unknown[] = []) {
        llamadas.push({ texto, valores });
        return Promise.resolve([] as readonly T[]);
      },
    };
    expect(await leerUltimoCheckpoint(ejecutor, "deltas")).toBeNull();
    const consulta = llamadas[0];
    expect(consulta?.texto).toMatch(/WHERE pipeline = \$1 AND checkpoint IS NOT NULL/);
    expect(consulta?.texto).toMatch(/ORDER BY id DESC\s+LIMIT 1/);
    expect(consulta?.valores).toEqual(["deltas"]);
  });
});

describe("la búsqueda de un corte del proveedor ya registrado", () => {
  it("es de solo lectura, desde el inicio del ciclo y por contención de la muestra", async () => {
    const llamadas: Llamada[] = [];
    const ejecutor: EjecutorSql = {
      ejecutar<T>(texto: string, valores: readonly unknown[] = []) {
        llamadas.push({ texto, valores });
        return Promise.resolve([] as readonly T[]);
      },
    };
    await buscarCorteVigente(ejecutor, { ciclo: CICLO, ahora: AHORA });

    expect(llamadas).toHaveLength(1);
    const [consulta] = llamadas;
    expect(consulta?.texto.trim()).toMatch(/^SELECT/);
    expect(consulta?.texto).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    // Sin filtro por pipeline: la cuota del proveedor es una sola.
    expect(consulta?.texto).not.toMatch(/pipeline\s*=/);
    expect(consulta?.texto).toMatch(/started_at >= \$1/);
    expect(consulta?.texto).toMatch(/@> \$2::jsonb/);
    expect(consulta?.valores[0]).toEqual(CICLO.inicio);
    expect(JSON.parse(String(consulta?.valores[1]))).toEqual(
      MUESTRA_DE_CORTE_POR_UMBRAL,
    );
  });
});

describe("el transporte no puede llamar sin reserva", () => {
  it("no toca fetch si la cuota se deniega", async () => {
    const espiaFetch = vi.fn();
    vi.stubGlobal("fetch", espiaFetch);
    try {
      const transporte = crearTransporte({
        pipeline: "seed",
        pedirCuota: () => Promise.reject(new Error("sin cuota")),
      });
      await expect(transporte("https://ejemplo.test/shows")).rejects.toThrow(
        /sin cuota/,
      );
      expect(espiaFetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reserva primero y llama después", async () => {
    const orden: string[] = [];
    const espiaFetch = vi.fn(() => {
      orden.push("fetch");
      return Promise.resolve(new Response("{}"));
    });
    vi.stubGlobal("fetch", espiaFetch);
    try {
      const transporte = crearTransporte({
        pipeline: "seed",
        pedirCuota: () => {
          orden.push("reserva");
          return Promise.resolve();
        },
      });
      await transporte("https://ejemplo.test/shows");
      expect(orden).toEqual(["reserva", "fetch"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("una request colgada se corta por tiempo y SIGUE CONTADA", async () => {
    // Un fetch que solo termina si le abortan la señal: una conexión colgada.
    const colgado = vi.fn(
      (_url: URL, init?: RequestInit) =>
        new Promise<Response>((_, rechazar) => {
          init?.signal?.addEventListener("abort", () => {
            // `reason` de un `AbortSignal.timeout` es un DOMException
            // TimeoutError, que ES un Error: lo que haría fetch de verdad.
            rechazar(init.signal?.reason as Error);
          });
        }),
    );
    vi.stubGlobal("fetch", colgado);
    try {
      const pedirCuota = vi.fn(() => Promise.resolve());
      const transporte = crearTransporte(
        { pipeline: "deltas", pedirCuota },
        { tiempoMaximoMs: 20 },
      );
      await expect(transporte("https://ejemplo.test/changes")).rejects.toMatchObject({
        name: "TimeoutError",
      });
      // La reserva ya se hizo y no se devuelve: pudo llegar al proveedor.
      expect(pedirCuota).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("toda request lleva señal de tiempo, y respeta la del llamador", async () => {
    const senales: (AbortSignal | null | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: URL, init?: RequestInit) => {
        senales.push(init?.signal);
        return Promise.resolve(new Response("{}"));
      }),
    );
    try {
      const transporte = crearTransporte({
        pipeline: "deltas",
        pedirCuota: () => Promise.resolve(),
      });
      await transporte("https://ejemplo.test/a");
      const delLlamador = new AbortController();
      await transporte("https://ejemplo.test/b", { signal: delLlamador.signal });
      expect(senales[0]).toBeInstanceOf(AbortSignal);
      // Combinada: abortar la del llamador aborta la que recibió fetch.
      expect(senales[1]?.aborted).toBe(false);
      delLlamador.abort();
      expect(senales[1]?.aborted).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("el tiempo máximo por defecto es 30 s, y no admite valores absurdos", () => {
    expect(TIEMPO_MAXIMO_POR_REQUEST_MS).toBe(30_000);
    const fuente = { pipeline: "deltas" as const, pedirCuota: () => Promise.resolve() };
    expect(() => crearTransporte(fuente, { tiempoMaximoMs: 0 })).toThrow(
      /entero positivo/,
    );
    expect(() => crearTransporte(fuente, { tiempoMaximoMs: 1.5 })).toThrow(
      /entero positivo/,
    );
  });

  it("rechaza http y las URLs relativas antes de gastar cuota", async () => {
    const pedirCuota = vi.fn(() => Promise.resolve());
    const transporte = crearTransporte({ pipeline: "seed", pedirCuota });
    await expect(transporte("http://ejemplo.test/x")).rejects.toThrow(/https/);
    await expect(transporte("/shows/search")).rejects.toThrow(/URL absoluta/);
    expect(pedirCuota).not.toHaveBeenCalled();
  });
});

describe("la regla de ESLint que cierra la red existe de verdad", () => {
  // Comprobado a mano el 2026-09-22: un fichero de jobs/ con `fetch`,
  // `globalThis.fetch` y `node:https` produce 3 errores, y `transporte.ts`
  // ninguno. Este test vigila que la regla no desaparezca en un refactor:
  // si se borrara, nada fallaría — solo volvería a poder gastarse cuota sin
  // contarla, que es exactamente el fallo silencioso que se quiere evitar.
  const config = readFileSync(
    join(import.meta.dirname, "..", "..", "eslint.config.mjs"),
    "utf8",
  );

  it("prohíbe fetch en jobs/ y exime solo al transporte", () => {
    expect(config).toMatch(/"no-restricted-globals"/);
    expect(config).toMatch(/name: "fetch"/);
    expect(config).toMatch(/ignores: \["jobs\/ops\/transporte\.ts"\]/);
  });

  it("cierra también la puerta de atrás de los clientes HTTP", () => {
    for (const modulo of ["node:http", "node:https", "undici", "axios"]) {
      expect(config).toContain(`name: "${modulo}"`);
    }
  });
});
