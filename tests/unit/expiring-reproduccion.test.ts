/**
 * Reproducir una ejecución de `expiring` **desde su mismo estado de partida**,
 * y comparar todo lo que debe coincidir. Sin red y sin base de datos.
 *
 * 📏 El defecto que motiva estos tests (2026-09-24): el ensayo midió 4
 * desaparecidas y 0 ofertas de línea base; su reproducción, 2 y 309. Mismas
 * páginas, mismos avisos, mismo estado… y 7/7, porque solo se comparaba lo
 * que sale del crudo.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { InformeDeDeltas } from "../../jobs/pipelines/deltas/contratos.ts";
import type {
  EstadoInicial,
  HuellaDeLaRama,
  Manifiesto,
} from "../../jobs/pipelines/deltas/manifiesto.ts";
import {
  NOMBRE_DEL_MANIFIESTO,
  crearRegistroLocal,
} from "../../jobs/pipelines/deltas/manifiesto.ts";
import {
  cambiosEnLaRama,
  compararConOriginal,
  planDeReconstruccion,
} from "../../jobs/pipelines/expiring/reproduccion.ts";
import { mismoValorJson, rutaCopiable } from "../../scripts/manual-comun.ts";

const EXCLUIR = /^\d{3}-(C-changes|D-|H-daily)-/.source;

function manifiesto(parcial: Partial<Manifiesto> = {}): Manifiesto {
  return {
    version: 1,
    pipeline: "expiring",
    modo: "ensayo",
    creadoEn: "2026-09-24T11:38:26.854Z",
    ahora: "2026-09-21T12:42:20.000Z",
    ventana: { from: 1789994480, to: 1792672940 },
    tipos: ["expiring"],
    reanudaDe: null,
    runId: null,
    requests: { reservadas: 2, respuestas: 2, respuestasOk: 2 },
    respuestas: [],
    paginas: [
      {
        changeType: "expiring",
        pagina: 1,
        cursorDeEntrada: null,
        nextCursor: "1790632740:1047936342",
        hasMore: true,
        avisos: 25,
        ultimoTimestamp: "2026-09-28T21:59:00.000Z",
        eventos: {},
        eventosEscritos: 0,
      },
    ],
    cuotaDelProveedor: [],
    estado: "succeeded",
    reanudacion: null,
    horizonte: { completo: true, desaparecidas: 4, muestra: ["a", "b", "c", "d"] },
    resumen: {
      paginas: 2,
      avisos: 82,
      titulosTocados: 80,
      eventos: {},
      eventosEscritos: 0,
      ofertasDeLineaBase: 0,
      retiradasSinEstadoPrevio: 0,
      observacionesYaAplicadas: 0,
    },
    ...parcial,
  };
}

const RAMA: HuellaDeLaRama = {
  recuentos: { external_titles: 42, external_availability: 51 },
  ultimoEvento: 120,
  ultimaComprobacion: "2026-09-24T04:37:12.000Z",
};

const corpus = (previas: readonly string[] = []): EstadoInicial => ({
  tipo: "corpus_spike1",
  excluir: EXCLUIR,
  previas,
  rama: RAMA,
});

/** Un árbol de manifiestos en memoria y un resolvedor POSIX. */
function lector(arbol: Record<string, Manifiesto>) {
  return (dir: string) => {
    const m = arbol[dir];
    if (m === undefined) throw new Error(`no existe ${dir}`);
    return m;
  };
}
const resolver = (base: string, relativa: string) => posix.resolve(base, relativa);

// ── Desde qué estado ─────────────────────────────────────────────────────────

describe("planDeReconstruccion", () => {
  it("un ensayo sobre el corpus se reconstruye EXACTO", () => {
    const plan = planDeReconstruccion(
      "/e/pasada-1",
      lector({ "/e/pasada-1": manifiesto({ estadoInicial: corpus() }) }),
      resolver,
    );
    expect(plan).toEqual({
      tipo: "corpus_spike1",
      excluir: new RegExp(EXCLUIR),
      previas: [],
      rama: RAMA,
    });
  });

  it("encadena las previas en orden, también las de las previas", () => {
    const arbol = {
      "/e/a": manifiesto({ estadoInicial: corpus() }),
      "/e/b": manifiesto({ estadoInicial: corpus(["../a"]) }),
      "/e/c": manifiesto({ estadoInicial: corpus(["../b"]) }),
    };
    const plan = planDeReconstruccion("/e/c", lector(arbol), resolver);
    expect(plan.tipo === "corpus_spike1" && plan.previas).toEqual(["/e/a", "/e/b"]);
  });

  it("una previa de otro corpus no se encadena", () => {
    const arbol = {
      "/e/a": manifiesto({
        estadoInicial: {
          tipo: "corpus_spike1",
          excluir: "^otro-",
          previas: [],
          rama: RAMA,
        },
      }),
      "/e/b": manifiesto({ estadoInicial: corpus(["../a"]) }),
    };
    expect(() => planDeReconstruccion("/e/b", lector(arbol), resolver)).toThrow(
      /no parte del mismo corpus/,
    );
  });

  it("un ciclo de previas se rechaza", () => {
    const arbol = {
      "/e/a": manifiesto({ estadoInicial: corpus(["../b"]) }),
      "/e/b": manifiesto({ estadoInicial: corpus(["../a"]) }),
    };
    expect(() => planDeReconstruccion("/e/a", lector(arbol), resolver)).toThrow(
      /ciclo/,
    );
  });

  it("📏 un ensayo ANTERIOR al registro del estado inicial no se reproduce a ciegas", () => {
    expect(() =>
      planDeReconstruccion("/e/viejo", lector({ "/e/viejo": manifiesto() }), resolver),
    ).toThrow(/Vuelve a ejecutar/);
  });

  it("una ejecución real es de idempotencia: la rama no es reconstruible", () => {
    const plan = planDeReconstruccion(
      "/r",
      lector({ "/r": manifiesto({ modo: "real", estadoInicial: { tipo: "rama" } }) }),
      resolver,
    );
    expect(plan.tipo).toBe("rama");
  });

  it("una real sin estado declarado se trata como rama", () => {
    const plan = planDeReconstruccion(
      "/r",
      lector({ "/r": manifiesto({ modo: "real" }) }),
      resolver,
    );
    expect(plan.tipo).toBe("rama");
  });
});

// ── La rama bajo el corpus ───────────────────────────────────────────────────

describe("cambiosEnLaRama", () => {
  it("igual → null: la reconstrucción puede ser exacta", () => {
    expect(cambiosEnLaRama(RAMA, structuredClone(RAMA))).toBeNull();
  });

  it("📏 el cron de deltas mueve la última comprobación aunque no inserte nada", () => {
    const tras = { ...RAMA, ultimaComprobacion: "2026-09-25T04:37:09.000Z" };
    expect(cambiosEnLaRama(RAMA, tras)).toBe(
      "última comprobación 2026-09-24T04:37:12.000Z→2026-09-25T04:37:09.000Z",
    );
  });

  it("nombra cada tabla que cambia de recuento y el último evento", () => {
    const tras = {
      recuentos: { external_titles: 45, external_availability: 51 },
      ultimoEvento: 131,
      ultimaComprobacion: RAMA.ultimaComprobacion,
    };
    expect(cambiosEnLaRama(RAMA, tras)).toBe(
      "external_titles 42→45 · último evento 120→131",
    );
  });
});

// ── Qué tiene que coincidir ──────────────────────────────────────────────────

describe("compararConOriginal", () => {
  /** Lo observado el 2026-09-24: mismo crudo, otra base. */
  const reproducida = manifiesto({
    modo: "reproduccion",
    horizonte: { completo: true, desaparecidas: 2, muestra: ["b", "d"] },
    resumen: {
      paginas: 2,
      avisos: 82,
      titulosTocados: 80,
      eventos: {},
      eventosEscritos: 0,
      ofertasDeLineaBase: 309,
      retiradasSinEstadoPrevio: 0,
      observacionesYaAplicadas: 0,
    },
  });

  const exigiblesFallidos = (exacta: boolean) =>
    compararConOriginal(manifiesto(), reproducida, exacta)
      .filter((d) => d.exigible && !d.igual)
      .map((d) => d.campo);

  it("📏 exacta: la diferencia de horizonte y de línea base SE DETECTA", () => {
    expect(exigiblesFallidos(true)).toEqual([
      "resumen del informe",
      "horizonte (completo, desaparecidas, muestra)",
    ]);
  });

  it("de idempotencia: solo se exige lo que sale del crudo", () => {
    expect(exigiblesFallidos(false)).toEqual([]);
    const informativos = compararConOriginal(manifiesto(), reproducida, false).filter(
      (d) => !d.exigible,
    );
    expect(informativos.map((d) => d.campo)).toEqual([
      "páginas (estado: eventos por página)",
      "resumen del informe",
      "horizonte (completo, desaparecidas, muestra)",
    ]);
  });

  it("lo que sale del crudo es exigible SIEMPRE", () => {
    const otroCursor = manifiesto({
      paginas: [{ ...manifiesto().paginas[0]!, nextCursor: "otro" }],
    });
    for (const exacta of [true, false]) {
      const fallidos = compararConOriginal(manifiesto(), otroCursor, exacta)
        .filter((d) => d.exigible && !d.igual)
        .map((d) => d.campo);
      expect(fallidos).toEqual(["páginas (crudo: cursores, hasMore, avisos, fechas)"]);
    }
  });

  it("idéntica → todo coincide", () => {
    expect(
      compararConOriginal(manifiesto(), manifiesto(), true).every((d) => d.igual),
    ).toBe(true);
  });
});

// ── El manifiesto guarda lo que hace falta para compararlo ───────────────────

describe("el manifiesto", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("guarda el estado inicial declarado y el resumen del informe", () => {
    dir = mkdtempSync(join(tmpdir(), "expiring-"));
    const registro = crearRegistroLocal(dir, {
      modo: "ensayo",
      pipeline: "expiring",
      estadoInicial: corpus(["../pasada-1"]),
      ahora: new Date("2026-09-21T12:42:20.000Z"),
      ventana: { desde: new Date(0), hasta: new Date(1000) },
      tipos: ["expiring"],
      reanudaDe: null,
    });
    registro.anotarResumen({
      paginas: 2,
      avisos: 82,
      titulosTocados: 80,
      eventos: { changed: 1 },
      eventosEscritos: 1,
      ofertasDeLineaBase: 3,
      retiradasSinEstadoPrevio: 0,
      observacionesYaAplicadas: 5,
      ofertasNombradas: ["no-cabe-en-el-resumen"],
    } as unknown as InformeDeDeltas);
    const escrito = JSON.parse(
      readFileSync(join(dir, NOMBRE_DEL_MANIFIESTO), "utf8"),
    ) as Manifiesto;
    expect(escrito.estadoInicial).toEqual(corpus(["../pasada-1"]));
    expect(escrito.resumen).toEqual({
      paginas: 2,
      avisos: 82,
      titulosTocados: 80,
      eventos: { changed: 1 },
      eventosEscritos: 1,
      ofertasDeLineaBase: 3,
      retiradasSinEstadoPrevio: 0,
      observacionesYaAplicadas: 5,
    });
  });

  it("sin estado declarado, no lo inventa", () => {
    dir = mkdtempSync(join(tmpdir(), "deltas-"));
    const registro = crearRegistroLocal(dir, {
      modo: "real",
      ahora: new Date(0),
      ventana: { desde: new Date(0), hasta: new Date(1000) },
      tipos: ["removed", "new"],
      reanudaDe: null,
    });
    expect("estadoInicial" in registro.manifiesto()).toBe(false);
  });
});

// ── Comparar un checkpoint con la fila que lo guardó ─────────────────────────

describe("mismoValorJson", () => {
  /** Como lo tenía el job: el orden del schema. */
  const delJob = {
    v: 1,
    estrategia: "horizonte",
    horizonteDias: 31,
    ventana: { from: 1790251506, to: 1792929966 },
    tipos: ["expiring"],
    pendiente: null,
    ultimoTimestampConfirmado: "2026-10-23T21:59:00.000Z",
    paginasConfirmadas: 6,
    reanudaDe: null,
  };
  /** 📏 Como lo devolvió la fila 44: el orden de jsonb. */
  const deLaFila = {
    v: 1,
    tipos: ["expiring"],
    ventana: { from: 1790251506, to: 1792929966 },
    pendiente: null,
    reanudaDe: null,
    estrategia: "horizonte",
    horizonteDias: 31,
    paginasConfirmadas: 6,
    ultimoTimestampConfirmado: "2026-10-23T21:59:00.000Z",
  };

  it("📏 fila 44: mismo valor con otro orden de claves → igual", () => {
    // El validador anterior comparaba texto, y esto daba un falso negativo.
    expect(JSON.stringify(delJob) === JSON.stringify(deLaFila)).toBe(false);
    expect(mismoValorJson(deLaFila, delJob)).toBe(true);
  });

  it("un valor distinto sigue detectándose, también anidado", () => {
    expect(
      mismoValorJson(deLaFila, {
        ...delJob,
        ultimoTimestampConfirmado: "2026-10-15T21:59:00.000Z",
      }),
    ).toBe(false);
    expect(
      mismoValorJson(deLaFila, { ...delJob, ventana: { from: 1790251506, to: 1 } }),
    ).toBe(false);
    expect(mismoValorJson(deLaFila, { ...delJob, reanudaDe: 7 })).toBe(false);
  });

  it("null frente a un checkpoint no es igual", () => {
    expect(mismoValorJson(null, delJob)).toBe(false);
  });
});

// ── La ruta que se imprime para copiar ───────────────────────────────────────

describe("rutaCopiable", () => {
  const raiz = join(import.meta.dirname, "..", "..");

  it("📏 relativa y con `/`: sobrevive a un shell POSIX sin comillas", () => {
    const ruta = join(
      raiz,
      ".expiring-runs",
      "2026-09-24T11-38-26-854Z-ensayo",
      "pasada-1",
    );
    expect(rutaCopiable(ruta)).toBe(
      ".expiring-runs/2026-09-24T11-38-26-854Z-ensayo/pasada-1",
    );
    expect(rutaCopiable(ruta)).not.toContain("\\");
  });

  it("fuera del repositorio se queda absoluta, también con `/`", () => {
    const fuera = join(tmpdir(), "x", "y");
    expect(rutaCopiable(fuera)).not.toContain("\\");
    expect(rutaCopiable(fuera).endsWith("x/y")).toBe(true);
  });
});
