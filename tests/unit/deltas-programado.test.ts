/**
 * `pnpm job deltas`: guardas, códigos de salida y una ejecución completa.
 * **Sin red y sin base de datos.**
 *
 * La ejecución completa corre `ejecutarDeltasProgramado` con el presupuesto
 * **del repositorio** —sin inyectar nada—, así que también prueba que el tope
 * aprobado (4) es el que de verdad gobierna el job.
 */
import { describe, expect, it } from "vitest";

import type { Conexion } from "../../jobs/ops/conexion.ts";
import type { EjecutorSql, MuestraDeError } from "../../jobs/ops/contratos.ts";
import { crearLibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import type { LibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import { TECHO_MENSUAL_POR_DEFECTO } from "../../jobs/ops/presupuesto.ts";
import type { FuenteDeCuota, Transporte } from "../../jobs/ops/transporte.ts";
import type { CheckpointDeDeltas } from "../../jobs/pipelines/deltas/checkpoint.ts";
import { checkpointInicial } from "../../jobs/pipelines/deltas/checkpoint.ts";
import type { ResultadoDelJobDeDeltas } from "../../jobs/pipelines/deltas/job.ts";
import type { DestinoVerificado } from "../../jobs/pipelines/deltas/programado.ts";
import {
  UMBRAL_DE_RETRASO_MS,
  VARIABLES_DE_PRESUPUESTO,
  configuracionDeLaApi,
  ejecutarDeltasProgramado,
  exigirDestino,
  presupuestoDelJob,
  veredicto,
} from "../../jobs/pipelines/deltas/programado.ts";
import { conexionDeDatos } from "./ayudas-checkpoint.ts";
import type { BaseEnMemoria } from "./base-en-memoria.ts";
import { crearBaseEnMemoria } from "./base-en-memoria.ts";
import { respuestaCruda, showCrudo } from "./ayudas-deltas.ts";

const T = new Date("2026-09-23T10:00:00.000Z");
const S = Math.floor(T.getTime() / 1000);
const HORA = 3600;

const HOST = "ep-validacion.test";
const ENTORNO = {
  NEON_VALIDATION_HOST: HOST,
  STREAMING_AVAILABILITY_API_KEY: "clave-de-prueba",
};
const DESTINO: DestinoVerificado = {
  url: "postgres://usuario:secreto@ep-validacion.test/db",
  hostname: HOST,
  esConexionDirecta: true,
  rama: "drizzle-schema-v1-test",
};

// ── 1 · Códigos de salida: el veredicto, puro ────────────────────────────────

function cp(
  ventana: { from: number; to: number },
  pendiente: boolean,
): CheckpointDeDeltas {
  return {
    ...checkpointInicial({ ventana, tipos: ["removed", "new"] }),
    pendiente: pendiente ? { changeType: "new", cursorDeEntrada: "c" } : null,
  };
}

function salida(entrada: {
  estado?: "succeeded" | "failed" | "budget_stopped";
  muestras?: readonly MuestraDeError[];
  checkpoint?: CheckpointDeDeltas | null;
  ejecutado?: boolean;
}): ResultadoDelJobDeDeltas {
  return {
    resultado:
      entrada.ejecutado === false
        ? { ejecutado: false, motivo: "ya_hay_una_viva" }
        : {
            ejecutado: true,
            runId: 7,
            estado: entrada.estado ?? "succeeded",
            huerfanasCerradas: [],
            metricas: {
              rowsAffected: null,
              multiLinkOffers: 0,
              farFutureExpiries: 0,
              errorCount: entrada.muestras?.length ?? 0,
              errorSamples: entrada.muestras ?? [],
            },
          },
    informe: null,
    contadores: { reservasConcedidas: 0, respuestas: 0, respuestasOk: 0 },
    cuotaDelProveedor: [],
    reanudacion: null,
    checkpoint:
      entrada.checkpoint === undefined
        ? cp({ from: S - 24 * HORA, to: S }, false)
        : entrada.checkpoint,
  };
}

describe("códigos de salida", () => {
  it("succeeded → 0", () => {
    expect(veredicto(salida({}), T)).toMatchObject({ codigo: 0, nivel: "ok" });
  });

  it("lock ya ocupado → 0 con aviso", () => {
    expect(veredicto(salida({ ejecutado: false }), T)).toMatchObject({
      codigo: 0,
      nivel: "aviso",
      motivo: "ya_hay_una_viva",
    });
  });

  it("catálogo ocupado por otro escritor → 0 con aviso, sin retraso que medir", () => {
    const s = salida({ ejecutado: false });
    const v = veredicto(
      { ...s, resultado: { ejecutado: false, motivo: "catalogo_ocupado" } },
      T,
    );
    expect(v).toEqual({
      codigo: 0,
      nivel: "aviso",
      motivo: "catalogo_ocupado",
      retrasoMs: null,
    });
  });

  it("budget_stopped por tope de ejecución → 0 con aviso: sigue en el próximo run", () => {
    const v = veredicto(
      salida({
        estado: "budget_stopped",
        muestras: [{ motivo: "tope_por_ejecucion", consumido: 4, techo: 4 }],
        checkpoint: cp({ from: S - 24 * HORA, to: S }, true),
      }),
      T,
    );
    expect(v).toMatchObject({
      codigo: 0,
      nivel: "aviso",
      motivo: "tope_por_ejecucion",
    });
  });

  it.each(["mensual_del_pipeline", "global", "cuota_del_proveedor"])(
    "budget_stopped por %s → 2",
    (motivo) => {
      const v = veredicto(
        salida({ estado: "budget_stopped", muestras: [{ motivo }] }),
        T,
      );
      expect(v).toMatchObject({ codigo: 2, nivel: "atencion", motivo });
    },
  );

  it("budget_stopped sin un motivo reconocible → 2: no se da por bueno", () => {
    const v = veredicto(salida({ estado: "budget_stopped", muestras: [] }), T);
    expect(v).toMatchObject({ codigo: 2, motivo: "corte_sin_motivo" });
  });

  it("failed → 1, con el motivo de su muestra", () => {
    const v = veredicto(
      salida({
        estado: "failed",
        muestras: [{ motivo: "hueco_irrecuperable" }],
        checkpoint: null,
      }),
      T,
    );
    expect(v).toMatchObject({
      codigo: 1,
      nivel: "error",
      motivo: "hueco_irrecuperable",
    });
  });

  it("checkpoint atascado: la misma ventana pendiente, días después → 2", () => {
    // Un tope que corta día tras día deja el `from` quieto mientras `ahora`
    // avanza. Aunque cada corte sea «normal», el conjunto no lo es.
    const v = veredicto(
      salida({
        estado: "budget_stopped",
        muestras: [{ motivo: "tope_por_ejecucion" }],
        checkpoint: cp({ from: S - 4 * 24 * HORA, to: S - 3 * 24 * HORA }, true),
      }),
      T,
    );
    expect(v).toMatchObject({ codigo: 2, motivo: "retraso_excesivo" });
  });

  it("una reanudación que termina una ventana vieja también avisa del retraso → 2", () => {
    const v = veredicto(
      salida({ checkpoint: cp({ from: S - 5 * 86_400, to: S - 4 * 86_400 }, false) }),
      T,
    );
    expect(v).toMatchObject({ codigo: 2, motivo: "retraso_excesivo" });
  });

  it("el borde del retraso: 72 h justas pasan; un segundo más, no", () => {
    const limite = S - UMBRAL_DE_RETRASO_MS / 1000;
    const con = (to: number) =>
      veredicto(salida({ checkpoint: cp({ from: to - 86_400, to }, false) }), T).codigo;
    expect(con(limite)).toBe(0);
    expect(con(limite - 1)).toBe(2);
  });

  it("failed gana a todo: un fallo nunca sale con 0 ni con 2", () => {
    const v = veredicto(
      salida({
        estado: "failed",
        muestras: [{ motivo: "excepcion" }],
        checkpoint: cp({ from: S - 9 * 86_400, to: S - 8 * 86_400 }, true),
      }),
      T,
    );
    expect(v.codigo).toBe(1);
  });
});

// ── 2 · Guardas ──────────────────────────────────────────────────────────────

describe("el job se niega a arrancar", () => {
  it("con otra rama, aunque las credenciales funcionen", () => {
    expect(() => exigirDestino({ ...DESTINO, rama: "production" }, ENTORNO)).toThrow(
      /drizzle-schema-v1-test/,
    );
  });

  it("por el pooler", () => {
    expect(() =>
      exigirDestino({ ...DESTINO, hostname: "ep-x-pooler.test" }, ENTORNO),
    ).toThrow(/directa/);
    expect(() =>
      exigirDestino({ ...DESTINO, esConexionDirecta: false }, ENTORNO),
    ).toThrow(/directa/);
  });

  it("si el host no coincide EXACTAMENTE con NEON_VALIDATION_HOST, o falta", () => {
    expect(() =>
      exigirDestino({ ...DESTINO, hostname: "ep-otra.test" }, ENTORNO),
    ).toThrow(/NEON_VALIDATION_HOST/);
    expect(() => exigirDestino(DESTINO, {})).toThrow(/NEON_VALIDATION_HOST/);
  });

  it("acepta el destino de validación con su host exacto", () => {
    expect(() => exigirDestino(DESTINO, ENTORNO)).not.toThrow();
  });

  it.each(VARIABLES_DE_PRESUPUESTO)(
    "en GitHub Actions, con %s definida",
    (variable) => {
      expect(() =>
        presupuestoDelJob({ GITHUB_ACTIONS: "true", [variable]: "1" }),
      ).toThrow(/no admite overrides/);
    },
  );

  it("fuera de Actions, los overrides siguen funcionando (harness y ensayos)", () => {
    expect(
      presupuestoDelJob({ STREAMING_API_PER_RUN_CAPS: "deltas=2" }).topePorEjecucion
        .deltas,
    ).toBe(2);
  });

  it("en Actions, sin overrides, el presupuesto es el del repositorio", () => {
    const p = presupuestoDelJob({ GITHUB_ACTIONS: "true" });
    expect(p.topePorEjecucion.deltas).toBe(4);
    expect(p.umbralGlobal).toBe(900);
  });

  it("sin clave de la API, y con la base de la API cambiada en Actions", () => {
    expect(() => configuracionDeLaApi({})).toThrow(/STREAMING_AVAILABILITY_API_KEY/);
    expect(() =>
      configuracionDeLaApi({
        ...ENTORNO,
        GITHUB_ACTIONS: "true",
        STREAMING_API_BASE_URL: "https://otro.test",
      }),
    ).toThrow(/STREAMING_API_BASE_URL/);
    expect(
      configuracionDeLaApi({ ...ENTORNO, STREAMING_API_BASE_URL: "https://local.test" })
        .base,
    ).toBe("https://local.test");
  });
});

// ── 3 · Una ejecución completa, con dobles ───────────────────────────────────

const CUOTA = {
  "x-quota-used": "120",
  "x-quota-granted": "1000",
  "x-quota-reset": "2026-10-01T00:00:00Z",
};

function paginaNew(id: string, nextCursor?: string) {
  return respuestaCruda({
    cambios: [
      {
        changeType: "new",
        showId: id,
        service: "netflix",
        type: "subscription",
        link: `https://netflix.test/${id}`,
        timestamp: S - HORA,
      },
    ],
    shows: [
      showCrudo({
        id,
        imdbId: `tt${id.padStart(7, "0")}`,
        opciones: [
          {
            service: "netflix",
            type: "subscription",
            link: `https://netflix.test/${id}`,
          },
        ],
      }),
    ],
    hasMore: nextCursor !== undefined,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  });
}

/** `removed` vacía + `new` en `n` páginas encadenadas por cursor. */
function listas(paginasDeNew: number): ReadonlyMap<string, Record<string, unknown>> {
  const m = new Map<string, Record<string, unknown>>([
    ["removed|", respuestaCruda({ cambios: [], shows: [] })],
  ]);
  for (let i = 0; i < paginasDeNew; i++) {
    const entrada = i === 0 ? "" : `c${String(i)}`;
    const salida = i === paginasDeNew - 1 ? undefined : `c${String(i + 1)}`;
    m.set(`new|${entrada}`, paginaNew(String(30 + i), salida));
  }
  return m;
}

interface Mundo {
  readonly libro: LibroEnMemoria;
  readonly base: BaseEnMemoria;
}

async function correr(
  mundo: Mundo,
  entrada: {
    readonly paginas?: ReadonlyMap<string, Record<string, unknown>>;
    readonly lockOcupado?: boolean;
    readonly entorno?: Readonly<Record<string, string>>;
    readonly destino?: DestinoVerificado;
    /** Se apunta aquí cada conexión abierta, aunque la ejecución lance. */
    readonly aperturas?: string[];
  } = {},
) {
  const urls: URL[] = [];
  const cerradas: string[] = [];
  let abiertas = 0;
  const paginas = entrada.paginas ?? listas(1);

  const ops: EjecutorSql = {
    ejecutar<T>(texto: string, valores?: readonly unknown[]) {
      if (entrada.lockOcupado === true && texto.includes("pg_try_advisory_lock")) {
        return Promise.resolve([{ tomado: false }] as unknown as readonly T[]);
      }
      return mundo.libro.ejecutor.ejecutar<T>(texto, valores);
    },
  };
  const conectar = (url: string): Promise<Conexion> => {
    expect(url).toBe(DESTINO.url);
    abiertas++;
    entrada.aperturas?.push(url);
    const nombre = abiertas === 1 ? "ops" : "datos";
    const ejecutor =
      abiertas === 1 ? ops : conexionDeDatos(mundo.base, mundo.libro).ejecutor;
    return Promise.resolve({
      ejecutor,
      cerrar: () => {
        cerradas.push(nombre);
        return Promise.resolve();
      },
    });
  };
  const crearLlamada =
    (fuente: FuenteDeCuota): Transporte =>
    async (url) => {
      await fuente.pedirCuota();
      const u = new URL(url);
      urls.push(u);
      const clave = `${u.searchParams.get("change_type") ?? "?"}|${u.searchParams.get("cursor") ?? ""}`;
      const cuerpo = paginas.get(clave);
      if (cuerpo === undefined) throw new Error(`sin página para ${clave}`);
      return new Response(JSON.stringify(cuerpo), {
        status: 200,
        headers: { "content-type": "application/json", ...CUOTA },
      });
    };

  const r = await ejecutarDeltasProgramado({
    entorno: entrada.entorno ?? ENTORNO,
    destino: entrada.destino ?? DESTINO,
    conectar,
    crearLlamada,
    ahora: T,
    directorioDeRegistros: null,
  });
  return { ...r, urls, cerradas, abiertas };
}

const crearMundo = (): Mundo => ({
  libro: crearLibroEnMemoria(),
  base: crearBaseEnMemoria(),
});

describe("ejecutarDeltasProgramado", () => {
  it("un día normal: 2 requests, exit 0, resumen y conexiones cerradas", async () => {
    const r = await correr(crearMundo());
    expect(r.veredicto).toMatchObject({ codigo: 0, nivel: "ok" });
    expect(r.urls).toHaveLength(2);
    expect(r.cerradas.sort()).toEqual(["datos", "ops"]);
    expect(r.resumen[0]).toBe("deltas · exit 0 · ok · succeeded");
    expect(r.resumen.join("\n")).toMatch(/páginas confirmadas: 2 · pendiente: ninguna/);
    // El resumen no filtra la clave ni la cadena de conexión.
    expect(r.resumen.join("\n")).not.toMatch(/clave-de-prueba|secreto|postgres:/);
  });

  it("gobierna el tope del REPOSITORIO: 4, y la quinta página queda pendiente", async () => {
    const mundo = crearMundo();
    const primera = await correr(mundo, { paginas: listas(5) });
    expect(primera.urls).toHaveLength(4); // removed + new 1-3
    expect(primera.veredicto).toMatchObject({
      codigo: 0,
      motivo: "tope_por_ejecucion",
    });
    expect(primera.salida.checkpoint?.pendiente).toEqual({
      changeType: "new",
      cursorDeEntrada: "c3",
    });

    // El run siguiente reanuda y termina.
    const segunda = await correr(mundo, { paginas: listas(5) });
    expect(segunda.urls.map((u) => u.searchParams.get("cursor"))).toEqual(["c3", "c4"]);
    expect(segunda.veredicto).toMatchObject({ codigo: 0, nivel: "ok" });
  });

  it("techo mensual agotado → exit 2, sin una sola request", async () => {
    const mundo = crearMundo();
    mundo.libro.sembrar("deltas", TECHO_MENSUAL_POR_DEFECTO.deltas);
    const r = await correr(mundo);
    expect(r.urls).toHaveLength(0);
    expect(r.veredicto).toMatchObject({ codigo: 2, motivo: "mensual_del_pipeline" });
  });

  it("lock ocupado → exit 0 con aviso, sin fila y sin requests", async () => {
    const mundo = crearMundo();
    const r = await correr(mundo, { lockOcupado: true });
    expect(r.veredicto).toMatchObject({
      codigo: 0,
      nivel: "aviso",
      motivo: "ya_hay_una_viva",
    });
    expect(r.urls).toHaveLength(0);
    expect(mundo.libro.filas).toHaveLength(0);
    expect(r.cerradas.sort()).toEqual(["datos", "ops"]);
  });

  it("checkpoint ilegible → exit 1, sin requests", async () => {
    const mundo = crearMundo();
    mundo.libro.sembrarFila({
      pipeline: "deltas",
      status: "succeeded",
      checkpoint: { v: 9 },
    });
    const r = await correr(mundo);
    expect(r.urls).toHaveLength(0);
    expect(r.veredicto).toMatchObject({
      codigo: 1,
      motivo: "checkpoint_version_desconocida",
    });
  });

  it("con las guardas en contra no abre ni una conexión", async () => {
    const mundo = crearMundo();
    const aperturas: string[] = [];
    await expect(
      correr(mundo, { destino: { ...DESTINO, rama: "production" }, aperturas }),
    ).rejects.toThrow(/se niega a arrancar/);
    await expect(
      correr(mundo, {
        entorno: {
          ...ENTORNO,
          GITHUB_ACTIONS: "true",
          STREAMING_API_PER_RUN_CAPS: "deltas=99",
        },
        aperturas,
      }),
    ).rejects.toThrow(/no admite overrides/);
    await expect(
      correr(mundo, { entorno: { NEON_VALIDATION_HOST: HOST }, aperturas }),
    ).rejects.toThrow(/STREAMING_AVAILABILITY_API_KEY/);
    expect(aperturas).toEqual([]);
    expect(mundo.libro.filas).toHaveLength(0);
  });
});
