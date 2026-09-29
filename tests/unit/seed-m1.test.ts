/**
 * M1 (ADR 0009 §1, §3) sin red: la evaluación de una página, la decisión por
 * plataforma, la sonda con sus ≤ 10 requests y sus guardias, la verificación
 * offline de `m1.json`, el plan que se fija desde ella, la fuente real con un
 * transporte falso y la autorización del seed ligada a su ciclo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AutorizacionDelSeed } from "../../jobs/ops/autorizacion-del-seed.ts";
import {
  AUTORIZACIONES_DEL_SEED,
  MAXIMO_POR_FASE,
  autorizacionVigente,
  presupuestoDelSeed,
  validarAutorizaciones,
} from "../../jobs/ops/autorizacion-del-seed.ts";
import { crearLibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import { leerPresupuesto } from "../../jobs/ops/presupuesto.ts";
import type { FuenteDePaginas } from "../../jobs/pipelines/seed/captura.ts";
import { crearAlmacenEnMemoria } from "../../jobs/pipelines/seed/crudo/almacen.ts";
import { ESTRATOS_DEL_MVP, planV1 } from "../../jobs/pipelines/seed/crudo/formato.ts";
import { sha256 } from "../../jobs/pipelines/seed/crudo/huella.ts";
import { crearFuenteReal, urlDePagina } from "../../jobs/pipelines/seed/fuente-real.ts";
import type { SondaDelSeed } from "../../jobs/pipelines/seed/m1.ts";
import {
  ESTRATOS_DE_M1,
  FORMATO_DE_LA_SONDA,
  MAXIMO_DE_REQUESTS_M1,
  decidirOrdenes,
  evaluarEstratoDeM1,
  formaDelCursor,
  queryDeM1,
  verificarM1,
} from "../../jobs/pipelines/seed/m1.ts";
import { construirPlanDesdeM1 } from "../../jobs/pipelines/seed/plan.ts";
import { ejecutarSonda } from "../../jobs/pipelines/seed/sonda.ts";
import { INICIO, crearReloj, fijarReloj, show } from "./ayudas-seed.ts";

beforeEach(() => fijarReloj());
afterEach(() => vi.useRealTimers());

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const estrato = (nombre: string) => {
  const e = ESTRATOS_DEL_MVP.find((x) => x.estrato === nombre);
  if (e === undefined) throw new Error(nombre);
  return e;
};

/** 20 shows con ids `base..base+19` y títulos NO alfabéticos. */
function veinte(base: number, tipo: "movie" | "series" = "movie") {
  return Array.from({ length: 20 }, (_, i) =>
    show(`tt${String(base + i).padStart(7, "0")}`, {
      tipo,
      titulo: `${String.fromCharCode(90 - (i % 26))} título ${String(i)}`,
    }),
  );
}
const paginaPopular = (base: number, tipo: "movie" | "series" = "movie") => ({
  shows: veinte(base, tipo),
  hasMore: true,
  nextCursor: `${String(base)}:${String(base * 7)}`,
});

/** Las páginas por defecto del Spike 1, simuladas: otros ids. */
const REFERENCIAS = new Map(
  ESTRATOS_DEL_MVP.map((e, i) => [e.estrato, veinte(9_000_000 + i * 100, e.showType)]),
);

describe("evaluarEstratoDeM1", () => {
  const e = estrato("prime-movie");
  const ref = {
    nombre: "spike-1/raw/005-B-prime-movie.json",
    shows: REFERENCIAS.get("prime-movie") ?? [],
  };
  const evaluar = (cuerpo: unknown, http = 200) =>
    evaluarEstratoDeM1({
      estrato: e,
      fuente: "medido",
      pagina: "p",
      http,
      cuerpo: bytes(cuerpo),
      referencia: ref,
    });

  it("válida: 200, schema, cursor de popularidad, distinta del orden por defecto, no alfabética", () => {
    expect(evaluar(paginaPopular(100))).toMatchObject({
      resultado: "valida",
      motivos: [],
      formaDelCursor: "popularidad",
      coincidenciaConDefecto: 0,
    });
  });

  it("un 400 o un cuerpo roto se rechazan, sin concluir que la capacidad no exista", () => {
    expect(evaluar({ message: "bad" }, 400).motivos).toEqual(["http_no_2xx"]);
    expect(evaluar({ nada: true }).motivos).toEqual(["cuerpo_invalido"]);
    const malo = paginaPopular(100);
    delete malo.shows[3]!.title;
    expect(evaluar(malo).motivos).toEqual(["cuerpo_invalido"]);
  });

  it("sin respuesta (timeout): rechazada; la request sigue contada fuera de aquí", () => {
    expect(
      evaluarEstratoDeM1({
        estrato: e,
        fuente: "medido",
        pagina: null,
        http: null,
        cuerpo: null,
        referencia: ref,
      }).motivos,
    ).toEqual(["sin_respuesta"]);
  });

  it("señales de que el orden se ignoró: cursor <id>:<título>, misma secuencia, orden alfabético", () => {
    expect(
      evaluar({ ...paginaPopular(100), nextCursor: "21129524:A House of Dynamite" })
        .motivos,
    ).toContain("cursor_de_orden_por_defecto");
    expect(
      evaluar({ shows: ref.shows, hasMore: true, nextCursor: "1:2" }).motivos,
    ).toContain("igual_al_orden_por_defecto");
    const alfabetica = Array.from({ length: 6 }, (_, i) =>
      show(`tt100000${String(i)}`, { titulo: `${String.fromCharCode(65 + i)} peli` }),
    );
    expect(evaluar({ shows: alfabetica, hasMore: false }).motivos).toEqual([
      "orden_alfabetico",
    ]);
  });

  it("hasMore sin cursor, página vacía, o agotada con página llena: rechazada", () => {
    expect(evaluar({ shows: veinte(1), hasMore: true }).motivos).toContain(
      "sin_cursor",
    );
    expect(evaluar({ shows: [], hasMore: false }).motivos).toContain("sin_shows");
    expect(evaluar({ shows: veinte(1), hasMore: false }).motivos).toContain(
      "agotada_con_pagina_llena",
    );
    // Un estrato pequeño que cabe entero en la página 1 sí vale.
    expect(evaluar({ shows: veinte(1).slice(0, 7), hasMore: false }).resultado).toBe(
      "valida",
    );
  });

  it("formaDelCursor sobre lo medido en los spikes", () => {
    expect(formaDelCursor("6218:117630")).toBe("popularidad");
    expect(formaDelCursor("23192730:사마귀")).toBe("por_defecto");
    expect(formaDelCursor("21129524:A House of Dynamite")).toBe("por_defecto");
  });
});

describe("decidirOrdenes", () => {
  it("popularity_alltime solo si los DOS estratos pasan; si no, rating para toda la plataforma", () => {
    const ok = (nombre: string) =>
      evaluarEstratoDeM1({
        estrato: estrato(nombre),
        fuente: nombre.startsWith("netflix") ? "evidencia_historica" : "medido",
        pagina: "p",
        http: 200,
        cuerpo: bytes(paginaPopular(100, estrato(nombre).showType)),
        referencia: { nombre: "r", shows: REFERENCIAS.get(nombre) ?? [] },
      });
    const todas = ESTRATOS_DEL_MVP.map((e) =>
      e.estrato === "disney-series"
        ? evaluarEstratoDeM1({
            estrato: e,
            fuente: "medido",
            pagina: null,
            http: 400,
            cuerpo: bytes({}),
            referencia: null,
          })
        : ok(e.estrato),
    );
    const d = decidirOrdenes(todas);
    expect(d.map((x) => `${x.plataforma}:${x.orderBy}`)).toEqual([
      "netflix:popularity_alltime",
      "prime:popularity_alltime",
      "disney:rating",
      "max:popularity_alltime",
      "apple:popularity_alltime",
      "skyshowtime:popularity_alltime",
    ]);
    expect(d[0]?.fuente).toBe("evidencia_historica");
    expect(d[2]?.motivo).toMatch(/disney-series \(http_no_2xx\)/);
  });
});

// ── La sonda ────────────────────────────────────────────────────────────────

const AUTORIZACION_M1: AutorizacionDelSeed = {
  ciclo: 202611,
  fase: "sonda",
  tope: 10,
  techo: 10,
  aprobadaEl: "2026-11-01",
  referencia: "test",
};

function planDeSonda(): SondaDelSeed {
  return {
    formato: FORMATO_DE_LA_SONDA,
    v: 1,
    sondaId: "m1-prueba",
    commit: null,
    estratos: ESTRATOS_DE_M1.map((e) => ({
      estrato: e.estrato,
      query: { ...queryDeM1(e) },
    })),
    referencias: ESTRATOS_DEL_MVP.map((e) => ({
      estrato: e.estrato,
      ruta: `ref/${e.estrato}.json`,
      sha256: sha256(
        bytes({ meta: { status: 200 }, body: { shows: REFERENCIAS.get(e.estrato) } }),
      ),
    })),
    evidencia: ["netflix-movie", "netflix-series"].map((n) => ({
      estrato: n,
      ruta: `evidencia/${n}.json`,
      sha256: sha256(
        bytes({ meta: { status: 200 }, body: paginaPopular(500, estrato(n).showType) }),
      ),
    })),
  };
}

function externos(): Map<string, Uint8Array> {
  const m = new Map<string, Uint8Array>();
  for (const e of ESTRATOS_DEL_MVP) {
    m.set(
      `ref/${e.estrato}.json`,
      bytes({ meta: { status: 200 }, body: { shows: REFERENCIAS.get(e.estrato) } }),
    );
  }
  for (const n of ["netflix-movie", "netflix-series"]) {
    m.set(
      `evidencia/${n}.json`,
      bytes({ meta: { status: 200 }, body: paginaPopular(500, estrato(n).showType) }),
    );
  }
  return m;
}

function evidenciaNetflix() {
  return ["netflix-movie", "netflix-series"].map((n) =>
    evaluarEstratoDeM1({
      estrato: estrato(n),
      fuente: "evidencia_historica",
      pagina: `evidencia/${n}.json`,
      http: 200,
      cuerpo: bytes(paginaPopular(500, estrato(n).showType)),
      referencia: { nombre: `ref/${n}.json`, shows: REFERENCIAS.get(n) ?? [] },
    }),
  );
}

function proveedorDeM1(
  especial: (
    estrato: string,
    n: number,
  ) => {
    status?: number;
    cuerpo?: unknown;
    cabeceras?: Record<string, string>;
    lanzar?: boolean;
  } = () => ({}),
) {
  const llamadas: string[] = [];
  const fuente: FuenteDePaginas = async (p, cuota) => {
    await cuota.pedirCuota();
    llamadas.push(p.estrato.estrato);
    const x = especial(p.estrato.estrato, llamadas.length);
    if (x.lanzar === true) throw new Error("timeout simulado");
    return {
      status: x.status ?? 200,
      cuerpo: bytes(
        x.cuerpo ?? paginaPopular(100 * llamadas.length, p.estrato.showType),
      ),
      cabeceras: x.cabeceras ?? {
        "x-quota-used": String(140 + llamadas.length),
        "x-quota-granted": "1000",
        "x-quota-reset": "2026-12-01T00:00:00Z",
      },
    };
  };
  return { fuente, llamadas };
}

async function sondear(
  opciones: {
    readonly autorizaciones?: readonly AutorizacionDelSeed[];
    readonly proveedor?: ReturnType<typeof proveedorDeM1>;
  } = {},
) {
  const libro = crearLibroEnMemoria();
  const almacen = crearAlmacenEnMemoria();
  const proveedor = opciones.proveedor ?? proveedorDeM1();
  const salida = await ejecutarSonda({
    ejecutorOps: libro.ejecutor,
    presupuesto: presupuestoDelSeed(
      leerPresupuesto({}),
      "sonda",
      INICIO,
      opciones.autorizaciones ?? [AUTORIZACION_M1],
    ),
    sonda: planDeSonda(),
    fuente: proveedor.fuente,
    almacen,
    reloj: crearReloj(),
    referencias: REFERENCIAS,
    evidencia: evidenciaNetflix(),
    destino: "drizzle-schema-v1-test",
    comprobarCuotaDelProveedor: true,
  });
  return { ...salida, libro, almacen, proveedor };
}

describe("la sonda", () => {
  it("mide los 10 estratos sin medir, una página cada uno, y nunca Netflix", async () => {
    expect(MAXIMO_DE_REQUESTS_M1).toBe(10);
    const s = await sondear();
    expect(s.resultado).toMatchObject({ ejecutado: true, estado: "succeeded" });
    expect(s.proveedor.llamadas).toEqual(ESTRATOS_DE_M1.map((e) => e.estrato));
    expect(s.proveedor.llamadas.some((e) => e.startsWith("netflix"))).toBe(false);
    expect(s.libro.filas[0]?.requestsMade).toBe(10);
    expect(s.m1).toMatchObject({
      runId: "1",
      cicloClave: 202611,
      estado: "succeeded",
      requestsReservadas: 10,
    });
    expect(s.m1?.decisiones.every((d) => d.orderBy === "popularity_alltime")).toBe(
      true,
    );
    expect(s.m1?.evaluaciones).toHaveLength(12);
  });

  it("sin autorización del ciclo (el repositorio hoy): 0 requests", async () => {
    // La del repositorio es de 202609 y de la fase sonda: en 202611 no vale.
    const s = await sondear({ autorizaciones: AUTORIZACIONES_DEL_SEED });
    expect(s.resultado).toMatchObject({ ejecutado: true, estado: "budget_stopped" });
    expect(s.proveedor.llamadas).toHaveLength(0);
    expect(s.libro.filas[0]?.requestsMade).toBe(0);
  });

  it("un tope de 10 nunca permite la 11.ª: el techo de la fase es 10", () => {
    expect(MAXIMO_POR_FASE.sonda).toBe(10);
    expect(() =>
      validarAutorizaciones([{ ...AUTORIZACION_M1, tope: 11, techo: 11 }]),
    ).toThrow(/máximo/);
  });

  it("un timeout en un estrato no para la sonda: su plataforma va por rating", async () => {
    const s = await sondear({
      proveedor: proveedorDeM1((e) => (e === "max-series" ? { lanzar: true } : {})),
    });
    expect(s.resultado).toMatchObject({ estado: "succeeded" });
    expect(s.proveedor.llamadas).toHaveLength(10);
    expect(s.libro.filas[0]?.requestsMade).toBe(10);
    expect(s.m1?.paginas.find((p) => p.estrato === "max-series")).toMatchObject({
      http: null,
      fichero: null,
    });
    expect(s.m1?.decisiones.find((d) => d.plataforma === "max")?.orderBy).toBe(
      "rating",
    );
  });

  it("guardia del proveedor al 90 %: budget_stopped, y el resultado no sirve para un plan", async () => {
    const s = await sondear({
      proveedor: proveedorDeM1((_, n) =>
        n === 3
          ? {
              cabeceras: {
                "x-quota-used": "900",
                "x-quota-granted": "1000",
                "x-quota-reset": "2026-12-01T00:00:00Z",
              },
            }
          : {},
      ),
    });
    expect(s.resultado).toMatchObject({ estado: "budget_stopped" });
    expect(s.proveedor.llamadas).toHaveLength(3);
    const v = verificarM1(s.almacen.contenido, externos());
    expect(v.ok).toBe(true);
    expect(v.utilizable).toBe(false);
    expect(() => construirPlanDesdeM1(v, { capturaId: "x", commit: null })).toThrow(
      /no es utilizable/,
    );
  });

  it("verificarM1 reproduce las evaluaciones desde los cuerpos, y detecta un cuerpo cambiado", async () => {
    const s = await sondear();
    const v = verificarM1(s.almacen.contenido, externos());
    expect(v.problemas).toEqual([]);
    expect(v.utilizable).toBe(true);
    expect(v.huella).toBe(s.huella);

    const roto = new Map(s.almacen.contenido);
    roto.set("paginas/01-prime-movie.json", bytes({ shows: [] }));
    expect(verificarM1(roto as never, externos()).ok).toBe(false);
    const otraReferencia = externos();
    otraReferencia.set("ref/prime-movie.json", bytes({ otra: 1 }));
    expect(verificarM1(s.almacen.contenido as never, otraReferencia).ok).toBe(false);
  });
});

describe("el plan desde M1", () => {
  it("lleva el orden decidido, la fila, el ciclo y la huella de m1.json", async () => {
    const s = await sondear({
      proveedor: proveedorDeM1((e) =>
        e === "apple-movie" ? { status: 400, cuerpo: {} } : {},
      ),
    });
    const v = verificarM1(s.almacen.contenido, externos());
    const plan = construirPlanDesdeM1(v, { capturaId: "seed-es-202612", commit: null });
    expect(plan.m1).toMatchObject({
      runId: "1",
      cicloClave: 202611,
      huellaDelResultado: s.huella,
    });
    expect(
      plan.estratos.filter((e) => e.orderBy === "rating").map((e) => e.estrato),
    ).toEqual(["apple-movie", "apple-series"]);
    expect(plan.tope).toBe(450);
    expect(plan.objetivoUnicos).toBe(5000);
    // Un plan cuyo estrato contradice la decisión de M1 no es v1.
    const mal = {
      ...plan,
      estratos: plan.estratos.map((e) => ({
        ...e,
        orderBy: "popularity_alltime" as const,
      })),
    };
    expect(planV1.safeParse(mal).success).toBe(false);
  });
});

// ── La fuente real, sin red ─────────────────────────────────────────────────

describe("fuente real", () => {
  it("sale por el transporte con la reserva, la clave en cabecera y nunca en la URL", async () => {
    const vistas: { url: string; clave: string | null }[] = [];
    let reservas = 0;
    const fuente = crearFuenteReal({
      apiKey: "CLAVE-SECRETA",
      crearLlamada: (cuota) => async (url, init) => {
        await cuota.pedirCuota();
        vistas.push({ url, clave: new Headers(init?.headers).get("X-API-Key") });
        return new Response('{"shows":[]}', {
          status: 200,
          headers: { "X-Quota-Used": "5" },
        });
      },
    });
    const e = {
      ...estrato("prime-movie"),
      orderBy: "popularity_alltime" as const,
      orderDirection: "desc" as const,
    };
    const r = await fuente(
      {
        estrato: e,
        ronda: 1,
        cursorDeEntrada: null,
        query: queryDeM1(estrato("prime-movie")),
      },
      { pipeline: "seed", pedirCuota: () => Promise.resolve(void reservas++) },
    );
    expect(reservas).toBe(1);
    expect(vistas[0]?.clave).toBe("CLAVE-SECRETA");
    expect(vistas[0]?.url).not.toContain("CLAVE");
    expect(vistas[0]?.url).toBe(
      "https://api.movieofthenight.com/v4/shows/search/filters?country=es&series_granularity=show&output_language=es&catalogs=prime&show_type=movie&order_by=popularity_alltime&order_direction=desc",
    );
    expect(r.cabeceras["x-quota-used"]).toBe("5");
    expect(new TextDecoder().decode(r.cuerpo)).toBe('{"shows":[]}');
    expect(urlDePagina("https://x.test/v4/", { cursor: "1:2" })).toBe(
      "https://x.test/v4/shows/search/filters?cursor=1%3A2",
    );
  });
});

// ── La autorización del seed, ligada a un ciclo ─────────────────────────────

describe("autorización del seed", () => {
  const base = leerPresupuesto({});
  const captura: AutorizacionDelSeed = {
    ...AUTORIZACION_M1,
    ciclo: 202612,
    fase: "captura",
    tope: 450,
    techo: 450,
  };

  it("el repositorio autoriza M1 de 202609 (10/10) y la captura de 202610 (450/450), nada más", () => {
    expect(AUTORIZACIONES_DEL_SEED).toEqual([
      {
        ciclo: 202609,
        fase: "sonda",
        tope: 10,
        techo: 10,
        aprobadaEl: "2026-09-27",
        referencia: "aprobacion-m1-seed",
      },
      {
        ciclo: 202610,
        fase: "captura",
        tope: 450,
        techo: 450,
        aprobadaEl: "2026-09-27",
        referencia: "aprobacion-captura-seed-202610",
      },
    ]);
    const septiembre = new Date("2026-09-27T16:00:00Z");
    expect(presupuestoDelSeed(base, "sonda", septiembre).topePorEjecucion.seed).toBe(
      10,
    );
    expect(presupuestoDelSeed(base, "captura", septiembre).topePorEjecucion.seed).toBe(
      0,
    );
    // M1 caduca sola con el ciclo: en octubre, 0/0 para la sonda.
    const octubre = new Date("2026-10-01T00:00:00Z");
    const sonda = presupuestoDelSeed(base, "sonda", octubre);
    expect(sonda.topePorEjecucion.seed).toBe(0);
    expect(sonda.techoMensualPorPipeline.seed).toBe(0);
    for (const fase of ["sonda", "captura"] as const) {
      expect(presupuestoDelSeed(base, fase, INICIO).topePorEjecucion.seed).toBe(0);
    }
  });

  it("la captura de 202610 está INACTIVA antes del 1 de octubre y caduca el 1 de noviembre", () => {
    const efectivo = (iso: string): readonly [number, number] => {
      const p = presupuestoDelSeed(base, "captura", new Date(iso));
      return [p.topePorEjecucion.seed, p.techoMensualPorPipeline.seed];
    };
    // Hoy, y hasta el último milisegundo de septiembre (UTC): 0/0.
    expect(efectivo("2026-09-27T20:00:00Z")).toEqual([0, 0]);
    expect(efectivo("2026-09-30T23:59:59.999Z")).toEqual([0, 0]);
    // Madrid ya es 1 de octubre a las 22:00Z del 30: el ciclo es UTC, sigue 0/0.
    expect(efectivo("2026-09-30T22:30:00Z")).toEqual([0, 0]);
    // Todo octubre: 450/450, y nada más grande.
    expect(efectivo("2026-10-01T00:00:00Z")).toEqual([450, 450]);
    expect(efectivo("2026-10-31T23:59:59.999Z")).toEqual([450, 450]);
    // Noviembre: caducada.
    expect(efectivo("2026-11-01T00:00:00Z")).toEqual([0, 0]);
    // Los demás pipelines, intactos en octubre.
    const p = presupuestoDelSeed(base, "captura", new Date("2026-10-05T00:00:00Z"));
    expect({ ...p.topePorEjecucion, seed: 0 }).toEqual({
      ...base.topePorEjecucion,
      seed: 0,
    });
    expect({ ...p.techoMensualPorPipeline, seed: 0 }).toEqual({
      ...base.techoMensualPorPipeline,
      seed: 0,
    });
    expect(
      autorizacionVigente("captura", new Date("2026-09-30T23:59:59Z"), 1),
    ).toBeNull();
  });

  it("solo vale en su ciclo y para su fase; los demás pipelines no cambian", () => {
    const lista = [AUTORIZACION_M1, captura];
    expect(presupuestoDelSeed(base, "sonda", INICIO, lista).topePorEjecucion.seed).toBe(
      10,
    );
    expect(
      presupuestoDelSeed(base, "captura", INICIO, lista).topePorEjecucion.seed,
    ).toBe(0);
    const diciembre = new Date("2026-12-02T10:00:00Z");
    expect(
      presupuestoDelSeed(base, "captura", diciembre, lista).techoMensualPorPipeline
        .seed,
    ).toBe(450);
    expect(
      presupuestoDelSeed(base, "sonda", diciembre, lista).topePorEjecucion.seed,
    ).toBe(0);
    const enero = new Date("2027-01-01T00:00:00Z");
    expect(autorizacionVigente("captura", enero, 1, lista)).toBeNull();
    expect(
      presupuestoDelSeed(base, "captura", diciembre, lista).topePorEjecucion.deltas,
    ).toBe(4);
  });

  it("M1 y captura no comparten ciclo; techo ≥ tope; captura ≤ 450", () => {
    expect(() =>
      validarAutorizaciones([AUTORIZACION_M1, { ...captura, ciclo: 202611 }]),
    ).toThrow(/comparten ciclo/);
    expect(() => validarAutorizaciones([{ ...captura, tope: 100, techo: 50 }])).toThrow(
      /menor que el tope/,
    );
    expect(() =>
      validarAutorizaciones([{ ...captura, tope: 451, techo: 451 }]),
    ).toThrow(/máximo/);
    expect(() => validarAutorizaciones([{ ...captura, referencia: " " }])).toThrow(
      /referencia/,
    );
  });
});
