/**
 * El **checkpoint persistente** de `deltas` (ADR 0006). **Sin red y sin base
 * de datos.**
 *
 * Aquí se prueba en modo REAL (`vincularEventos: true`): el checkpoint viaja
 * por la conexión de DATOS, dentro de la transacción de cada página. Para eso
 * hace falta un doble que se porte como PostgreSQL en lo que importa:
 *
 *   · dos conexiones —ops y datos— sobre **la misma** tabla `ops_sync_runs`
 *     (el libro en memoria);
 *   · la conexión de datos tiene transacciones de verdad (`base-en-memoria`),
 *     y lo que escribe en `ops_sync_runs` **solo se aplica al `COMMIT`**; un
 *     `ROLLBACK` lo descarta;
 *   · `requests_made` va por la conexión de ops y se aplica al instante.
 *
 * Lo que un doble no puede demostrar —que Neon hace exactamente eso, y que
 * las dos conexiones no se bloquean— lo mide `pnpm db:validate:checkpoint`.
 */
import { describe, expect, it } from "vitest";

import { crearLibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import type { LibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import { leerPresupuesto } from "../../jobs/ops/presupuesto.ts";
import type { FuenteDeCuota, Transporte } from "../../jobs/ops/transporte.ts";
import type { CheckpointDeDeltas } from "../../jobs/pipelines/deltas/checkpoint.ts";
import {
  MARGEN_DEL_HUECO_MS,
  avanzarCheckpoint,
  checkpointInicial,
  checkpointV1,
  leerCheckpoint,
  planificarDesde,
} from "../../jobs/pipelines/deltas/checkpoint.ts";
import type { PlanDelJob } from "../../jobs/pipelines/deltas/job.ts";
import {
  ejecutarJobDeDeltas,
  transaccionPorPagina,
} from "../../jobs/pipelines/deltas/job.ts";
import { ventanaEnSegundos } from "../../jobs/pipelines/deltas/manifiesto.ts";
import { ventanaHaciaAtras } from "../../jobs/pipelines/deltas/origen.ts";
import type { BaseEnMemoria } from "./base-en-memoria.ts";
import { crearBaseEnMemoria } from "./base-en-memoria.ts";
import { conexionDeDatos } from "./ayudas-checkpoint.ts";
import { respuestaCruda, showCrudo } from "./ayudas-deltas.ts";

const T = new Date("2026-09-23T10:00:00.000Z");
const T_MAS_UN_DIA = new Date(T.getTime() + 86_400_000);
const HACE_UNA_HORA = Math.floor(T.getTime() / 1000) - 3600;
const CURSOR_A = "1790000000:111";
const CURSOR_B = "1790000600:222";

const CUOTA = {
  "x-quota-used": "120",
  "x-quota-granted": "1000",
  "x-quota-reset": "2026-10-01T00:00:00Z",
};

// ── Páginas ──────────────────────────────────────────────────────────────────

function paginaNew(id: string, nextCursor?: string) {
  return respuestaCruda({
    cambios: [
      {
        changeType: "new",
        showId: id,
        service: "netflix",
        type: "subscription",
        link: `https://netflix.test/${id}`,
        timestamp: HACE_UNA_HORA,
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

const VACIA = respuestaCruda({ cambios: [], shows: [] });

/** `removed` vacía + `new` en tres páginas: A y B son los cursores intermedios. */
const LISTAS: ReadonlyMap<string, Record<string, unknown>> = new Map([
  ["removed|", VACIA],
  ["new|", paginaNew("21", CURSOR_A)],
  [`new|${CURSOR_A}`, paginaNew("22", CURSOR_B)],
  [`new|${CURSOR_B}`, paginaNew("23")],
]);

// ── Dobles ───────────────────────────────────────────────────────────────────

/** Sirve por `(change_type, cursor)`, pasando por la fuente de cuota como el real. */
function servidor(
  listas: ReadonlyMap<string, Record<string, unknown>> = LISTAS,
  alPedir?: () => void,
) {
  const urls: URL[] = [];
  const crear =
    (fuente: FuenteDeCuota): Transporte =>
    async (url) => {
      alPedir?.();
      await fuente.pedirCuota();
      const u = new URL(url);
      urls.push(u);
      const clave = `${u.searchParams.get("change_type") ?? "?"}|${u.searchParams.get("cursor") ?? ""}`;
      const cuerpo = listas.get(clave);
      if (cuerpo === undefined) throw new Error(`sin página para ${clave}`);
      return new Response(JSON.stringify(cuerpo), {
        status: 200,
        headers: { "content-type": "application/json", ...CUOTA },
      });
    };
  return { crear, urls };
}

interface Mundo {
  readonly libro: LibroEnMemoria;
  readonly base: BaseEnMemoria;
}

/** Un «Neon»: la tabla de ejecuciones y la de datos, compartidas entre procesos. */
function crearMundo(): Mundo {
  return { libro: crearLibroEnMemoria(), base: crearBaseEnMemoria() };
}

/**
 * Una ejecución **real** —otro proceso, otro runner—: conexiones nuevas sobre
 * el mismo mundo. Nada pasa de una a otra salvo lo que quedó en la base.
 */
async function ejecutar(
  mundo: Mundo,
  entrada: {
    readonly ahora?: Date;
    readonly tope?: number;
    readonly plan?: PlanDelJob;
    readonly listas?: ReadonlyMap<string, Record<string, unknown>>;
    readonly fallarAlEscribirCheckpoint?: () => boolean;
    readonly alPedir?: () => void;
  } = {},
) {
  const datos = conexionDeDatos(mundo.base, mundo.libro, {
    ...(entrada.fallarAlEscribirCheckpoint === undefined
      ? {}
      : { fallarAlEscribirCheckpoint: entrada.fallarAlEscribirCheckpoint }),
  });
  const red = servidor(entrada.listas, entrada.alPedir);
  const salida = await ejecutarJobDeDeltas({
    ejecutorOps: mundo.libro.ejecutor,
    ejecutorDatos: datos.ejecutor,
    transaccion: transaccionPorPagina(datos.ejecutor),
    presupuesto: leerPresupuesto({
      STREAMING_API_PER_RUN_CAPS: `deltas=${String(entrada.tope ?? 4)}`,
    }),
    crearLlamada: red.crear,
    apiKey: "k",
    plan: entrada.plan ?? {
      origen: "persistente",
      sinCheckpoint: "ventana_de_validacion",
    },
    ahora: entrada.ahora ?? T,
    crearRegistro: null,
    vincularEventos: true,
  });
  const runId = salida.resultado.ejecutado ? salida.resultado.runId : -1;
  const fila = mundo.libro.filas.find((f) => f.id === runId);
  return { salida, red, datos, fila, runId };
}

const estado = (s: { salida: { resultado: { ejecutado: boolean } } }) => {
  const r = s.salida.resultado as { ejecutado: boolean; estado?: string };
  return r.ejecutado ? r.estado : "no_ejecutado";
};

const pendienteDe = (checkpoint: unknown) =>
  (checkpoint as CheckpointDeDeltas | null)?.pendiente ?? null;

// ── 1 · El checkpoint nace con la fila ───────────────────────────────────────

describe("el checkpoint existe desde el INSERT", () => {
  it("antes de la primera reserva, la fila ya tiene el plan entero", async () => {
    const mundo = crearMundo();
    let alPrimeraPeticion: unknown = "sin observar";
    let requestsAlPedir = -1;
    await ejecutar(mundo, {
      alPedir: () => {
        if (alPrimeraPeticion !== "sin observar") return;
        alPrimeraPeticion = structuredClone(mundo.libro.filas[0]?.checkpoint);
        requestsAlPedir = mundo.libro.filas[0]?.requestsMade ?? -1;
      },
    });
    expect(requestsAlPedir).toBe(0);
    expect(alPrimeraPeticion).toEqual({
      v: 1,
      ventana: ventanaEnSegundos(ventanaHaciaAtras(T)),
      tipos: ["removed", "new"],
      pendiente: { changeType: "removed", cursorDeEntrada: null },
      ultimoTimestampConfirmado: null,
      paginasConfirmadas: 0,
      reanudaDe: null,
    });
  });
});

// ── 2 · Avanza con la página, en su transacción ──────────────────────────────

describe("el checkpoint avanza dentro de la transacción de la página", () => {
  it("página confirmada → checkpoint avanzado en la fila", async () => {
    const mundo = crearMundo();
    const { fila, salida } = await ejecutar(mundo, { tope: 2 });
    // removed (vacía) + new p1 confirmadas; new p2 cortada por el tope.
    expect(estado({ salida })).toBe("budget_stopped");
    expect(fila?.checkpoint).toMatchObject({
      pendiente: { changeType: "new", cursorDeEntrada: CURSOR_A },
      paginasConfirmadas: 2,
    });
    expect(fila?.checkpoint).toEqual(salida.checkpoint);
  });

  it("es la ÚLTIMA sentencia de cada transacción, justo antes del COMMIT", async () => {
    const mundo = crearMundo();
    const { datos } = await ejecutar(mundo);
    const transacciones = datos.control
      .join(" ")
      .split("BEGIN")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    expect(transacciones.length).toBe(4);
    for (const tx of transacciones) expect(tx).toMatch(/checkpoint COMMIT$/);
  });

  it("página vacía → abre su transacción y el checkpoint avanza igual", async () => {
    const mundo = crearMundo();
    const { datos, fila } = await ejecutar(mundo, { tope: 1 });
    // Solo `removed`, vacía: una transacción con el checkpoint y nada más.
    expect(datos.control).toEqual(["BEGIN", "checkpoint", "COMMIT"]);
    expect(pendienteDe(fila?.checkpoint)).toEqual({
      changeType: "new",
      cursorDeEntrada: null,
    });
  });

  it("ejecución completada → pendiente = null, y la fila cierra succeeded", async () => {
    const mundo = crearMundo();
    const { fila, salida } = await ejecutar(mundo);
    expect(estado({ salida })).toBe("succeeded");
    expect(fila?.checkpoint).toMatchObject({ pendiente: null, paginasConfirmadas: 4 });
    expect(salida.reanudacion).toBeNull();
  });
});

// ── 3 · El rollback se lleva el checkpoint con él ────────────────────────────

describe("rollback de la página: el checkpoint tampoco avanza", () => {
  async function conFalloEnLaPagina2DeNew() {
    const mundo = crearMundo();
    let inserciones = 0;
    // La 2.ª página de `new` escribe su estado y falla antes del evento.
    mundo.base.fallarUnaVezEn(
      (t) =>
        t.startsWith("INSERT INTO external_availability_events") && ++inserciones === 2,
    );
    const r = await ejecutar(mundo);
    return { mundo, ...r };
  }

  it("fallo en la página N → el checkpoint apunta a N, no a N+1", async () => {
    const { fila, salida } = await conFalloEnLaPagina2DeNew();
    expect(estado({ salida })).toBe("failed");
    // La página 2 de `new` se pidió con CURSOR_A: ese es el punto, no CURSOR_B.
    expect(pendienteDe(fila?.checkpoint)).toEqual({
      changeType: "new",
      cursorDeEntrada: CURSOR_A,
    });
    expect(fila?.checkpoint).toMatchObject({ paginasConfirmadas: 2 });
  });

  it("si falla el propio COMMIT, el checkpoint YA escrito se revierte con los datos", async () => {
    const mundo = crearMundo();
    let commits = 0;
    // El 2.º COMMIT es el de `new` p1: su checkpoint ya se escribió dentro.
    mundo.base.fallarUnaVezEn((t) => t === "COMMIT" && ++commits === 2);
    const { fila, salida, datos } = await ejecutar(mundo);
    expect(estado({ salida })).toBe("failed");
    expect(datos.control.filter((c) => c === "checkpoint")).toHaveLength(2);
    expect(pendienteDe(fila?.checkpoint)).toEqual({
      changeType: "new",
      cursorDeEntrada: null,
    });
    expect(mundo.base.eventos()).toHaveLength(0);
  });

  it("requests_made sobrevive al rollback: la cuota no se devuelve", async () => {
    const { fila, salida } = await conFalloEnLaPagina2DeNew();
    // removed + new p1 + new p2 (revertida): tres requests, las tres contadas.
    expect(salida.contadores.reservasConcedidas).toBe(3);
    expect(fila?.requestsMade).toBe(3);
  });

  it("si el checkpoint no se puede escribir, la página ENTERA se revierte", async () => {
    const mundo = crearMundo();
    let escrituras = 0;
    const { fila, salida } = await ejecutar(mundo, {
      // Falla la segunda escritura: la de `new` p1, tras escribir su estado.
      fallarAlEscribirCheckpoint: () => ++escrituras === 2,
    });
    expect(estado({ salida })).toBe("failed");
    expect(pendienteDe(fila?.checkpoint)).toEqual({
      changeType: "new",
      cursorDeEntrada: null,
    });
    // Ni el título ni su evento: el estado se fue con el checkpoint.
    expect(mundo.base.eventos()).toHaveLength(0);
    expect(fila?.requestsMade).toBe(2);
  });
});

// ── 4 · Otro proceso reanuda desde la base ───────────────────────────────────

describe("reanudar desde OTRO proceso", () => {
  it("usa la misma ventana y el mismo cursor, aunque el reloj haya avanzado", async () => {
    const mundo = crearMundo();
    const primera = await ejecutar(mundo, { tope: 2 });
    const segunda = await ejecutar(mundo, { ahora: T_MAS_UN_DIA });

    const q = segunda.red.urls[0]?.searchParams;
    const ventana = ventanaEnSegundos(ventanaHaciaAtras(T));
    expect(q?.get("change_type")).toBe("new");
    expect(q?.get("cursor")).toBe(CURSOR_A);
    expect(Number(q?.get("from"))).toBe(ventana.from);
    expect(Number(q?.get("to"))).toBe(ventana.to);
    expect(segunda.fila?.checkpoint).toMatchObject({
      ventana,
      reanudaDe: primera.runId,
      pendiente: null,
    });
    expect(estado(segunda)).toBe("succeeded");
    // Solo lo que faltaba: new p2 y new p3.
    expect(segunda.red.urls).toHaveLength(2);
  });

  it("una huérfana conserva su último checkpoint, y la siguiente la reanuda", async () => {
    const mundo = crearMundo();
    const ventana = ventanaEnSegundos(ventanaHaciaAtras(T));
    const idHuerfana = mundo.libro.sembrarFila({
      pipeline: "deltas",
      status: "running",
      requestsMade: 3,
      checkpoint: {
        ...checkpointInicial({ ventana, tipos: ["removed", "new"] }),
        pendiente: { changeType: "new", cursorDeEntrada: CURSOR_B },
        paginasConfirmadas: 3,
      },
    });
    const antes = structuredClone(mundo.libro.filas[0]?.checkpoint);

    const r = await ejecutar(mundo, { ahora: T_MAS_UN_DIA });

    const huerfana = mundo.libro.filas.find((f) => f.id === idHuerfana);
    expect(huerfana?.status).toBe("failed");
    expect(huerfana?.checkpoint).toEqual(antes);
    expect(huerfana?.requestsMade).toBe(3);
    expect(r.red.urls.map((u) => u.searchParams.get("cursor"))).toEqual([CURSOR_B]);
    expect(r.fila?.checkpoint).toMatchObject({
      reanudaDe: idHuerfana,
      pendiente: null,
    });
  });
});

// ── 5 · Ventanas contiguas ───────────────────────────────────────────────────

describe("dos ejecuciones completadas generan ventanas contiguas", () => {
  it("la segunda empieza exactamente donde terminó la primera", async () => {
    const mundo = crearMundo();
    const primera = await ejecutar(mundo);
    const segunda = await ejecutar(mundo, { ahora: T_MAS_UN_DIA });
    const v1 = (primera.fila?.checkpoint as CheckpointDeDeltas).ventana;
    const v2 = (segunda.fila?.checkpoint as CheckpointDeDeltas).ventana;
    expect(v2.from).toBe(v1.to);
    expect(v2.to).toBe(Math.floor(T_MAS_UN_DIA.getTime() / 1000));
    expect(estado(segunda)).toBe("succeeded");
    // Y es la que viajó en la query.
    expect(Number(segunda.red.urls[0]?.searchParams.get("from"))).toBe(v1.to);
  });
});

// ── 6 · Arranques imposibles: failed y 0 API ─────────────────────────────────

describe("sin plan posible: failed, 0 requests", () => {
  async function conUltimo(checkpoint: unknown, ahora = T) {
    const mundo = crearMundo();
    mundo.libro.sembrarFila({ pipeline: "deltas", status: "succeeded", checkpoint });
    const r = await ejecutar(mundo, { ahora });
    return { mundo, ...r };
  }

  it.each([
    ["versión desconocida", { v: 2, lo: "que sea" }, "checkpoint_version_desconocida"],
    ["sin versión", { ventana: { from: 1, to: 2 } }, "checkpoint_version_desconocida"],
    ["un escalar", 42, "checkpoint_version_desconocida"],
    [
      "v1 con una clave de más",
      {
        ...checkpointInicial({ ventana: { from: 1, to: 2 }, tipos: ["new"] }),
        extra: 1,
      },
      "checkpoint_invalido",
    ],
    [
      "v1 con un tipo ajeno",
      {
        ...checkpointInicial({ ventana: { from: 1, to: 2 }, tipos: ["new"] }),
        tipos: ["updated"],
      },
      "checkpoint_invalido",
    ],
  ])("%s → failed sin llamar a la API", async (_caso, checkpoint, motivo) => {
    const { red, fila, salida } = await conUltimo(checkpoint);
    expect(red.urls).toHaveLength(0);
    expect(salida.contadores.reservasConcedidas).toBe(0);
    expect(fila?.status).toBe("failed");
    expect(fila?.requestsMade).toBe(0);
    expect(fila?.errorSamples[0]).toMatchObject({ motivo });
    // La fila fallida NO lleva checkpoint: no tapa al roto, que sigue ahí.
    expect(fila?.checkpoint).toBeNull();
  });

  it("un checkpoint roto no se salta: la ejecución siguiente vuelve a fallar", async () => {
    const { mundo } = await conUltimo({ v: 2 });
    const otra = await ejecutar(mundo);
    expect(otra.red.urls).toHaveLength(0);
    expect(otra.fila?.status).toBe("failed");
  });

  it("hueco mayor de lo que /changes cubre → hueco_irrecuperable, 0 API", async () => {
    const hace40Dias = Math.floor(T.getTime() / 1000) - 40 * 86_400;
    const { red, fila } = await conUltimo({
      ...checkpointInicial({
        ventana: { from: hace40Dias - 86_400, to: hace40Dias },
        tipos: ["removed", "new"],
      }),
      pendiente: null,
    });
    expect(red.urls).toHaveLength(0);
    expect(fila?.status).toBe("failed");
    expect(fila?.errorSamples[0]).toMatchObject({ motivo: "hueco_irrecuperable" });
  });

  it("sin checkpoint y sin permiso para la ventana de validación → failed, 0 API", async () => {
    const mundo = crearMundo();
    const r = await ejecutar(mundo, {
      plan: { origen: "persistente", sinCheckpoint: "prohibido" },
    });
    expect(r.red.urls).toHaveLength(0);
    expect(r.fila?.status).toBe("failed");
    expect(r.fila?.errorSamples[0]).toMatchObject({ motivo: "sin_checkpoint" });
  });
});

// ── 7 · Las piezas puras ─────────────────────────────────────────────────────

describe("planificarDesde", () => {
  const V = { from: 1_790_000_000, to: 1_790_086_400 };
  const registrado = (checkpoint: unknown, runId = 9) => ({
    runId,
    status: "budget_stopped",
    checkpoint,
  });

  it("sin checkpoint: la ventana medida de 24 h, solo si se permite", () => {
    const cp = planificarDesde({
      ultimo: null,
      ahora: T,
      sinCheckpoint: "ventana_de_validacion",
      tipos: ["removed", "new"],
    });
    expect(cp.ventana).toEqual(ventanaEnSegundos(ventanaHaciaAtras(T)));
    expect(cp.ventana.to - cp.ventana.from).toBe(86_400);
  });

  it("con pendiente: reanuda sin tocar la ventana ni los tipos", () => {
    const previo = {
      ...checkpointInicial({ ventana: V, tipos: ["new"] }),
      pendiente: { changeType: "new", cursorDeEntrada: CURSOR_A },
    };
    const cp = planificarDesde({
      ultimo: registrado(previo),
      ahora: new Date(V.to * 1000 + 5 * 86_400_000),
      sinCheckpoint: "prohibido",
      tipos: ["removed", "new"],
    });
    expect(cp).toMatchObject({
      ventana: V,
      tipos: ["new"],
      pendiente: { changeType: "new", cursorDeEntrada: CURSOR_A },
      reanudaDe: 9,
      paginasConfirmadas: 0,
    });
  });

  it("el borde del hueco: un from justo dentro se acepta, justo fuera no", () => {
    const ahora = T;
    const limite = Math.ceil(
      (ahora.getTime() - 31 * 86_400_000 + MARGEN_DEL_HUECO_MS) / 1000,
    );
    const con = (to: number) => ({
      ...checkpointInicial({ ventana: { from: to - 10, to }, tipos: ["new"] }),
      pendiente: null,
    });
    expect(() =>
      planificarDesde({
        ultimo: registrado(con(limite)),
        ahora,
        sinCheckpoint: "prohibido",
        tipos: ["new"],
      }),
    ).not.toThrow();
    expect(() =>
      planificarDesde({
        ultimo: registrado(con(limite - 1)),
        ahora,
        sinCheckpoint: "prohibido",
        tipos: ["new"],
      }),
    ).toThrow(/hueco_irrecuperable/);
  });

  it("una ventana contigua vacía no se inventa: ventana_vacia", () => {
    const to = Math.floor(T.getTime() / 1000);
    expect(() =>
      planificarDesde({
        ultimo: registrado({
          ...checkpointInicial({ ventana: { from: to - 60, to }, tipos: ["new"] }),
          pendiente: null,
        }),
        ahora: T,
        sinCheckpoint: "prohibido",
        tipos: ["new"],
      }),
    ).toThrow(/ventana_vacia/);
  });
});

describe("avanzarCheckpoint y el schema v1", () => {
  const V = { from: 100, to: 200 };
  const pagina = (extra: Partial<Parameters<typeof avanzarCheckpoint>[1]>) => ({
    tipo: "removed" as const,
    pagina: 1,
    cursorDeEntrada: null,
    hayMas: false,
    cursorSiguiente: null,
    avisos: 1,
    ultimoTimestamp: new Date("2026-09-23T09:00:00.000Z"),
    eventos: {},
    eventosEscritos: 0,
    filasPorTabla: {},
    multiLinkOffers: 0,
    farFutureExpiries: 0,
    ...extra,
  });

  it("con hasMore sigue en la misma lista, con el nextCursor de la confirmada", () => {
    const cp = avanzarCheckpoint(
      checkpointInicial({ ventana: V, tipos: ["removed", "new"] }),
      pagina({ hayMas: true, cursorSiguiente: CURSOR_A }),
    );
    expect(cp.pendiente).toEqual({ changeType: "removed", cursorDeEntrada: CURSOR_A });
    expect(cp.ultimoTimestampConfirmado).toBe("2026-09-23T09:00:00.000Z");
  });

  it("al agotar una lista pasa a la siguiente desde su principio", () => {
    const cp = avanzarCheckpoint(
      checkpointInicial({ ventana: V, tipos: ["removed", "new"] }),
      pagina({}),
    );
    expect(cp.pendiente).toEqual({ changeType: "new", cursorDeEntrada: null });
    expect(cp.ultimoTimestampConfirmado).toBeNull();
  });

  it("lo que se construye siempre se puede volver a leer", () => {
    const cp = avanzarCheckpoint(
      checkpointInicial({ ventana: V, tipos: ["removed", "new"] }),
      pagina({}),
    );
    expect(leerCheckpoint(JSON.parse(JSON.stringify(cp)), 1)).toEqual(cp);
    expect(checkpointV1.safeParse(cp).success).toBe(true);
  });

  it("rechaza una ventana invertida y una pendiente fuera de sus tipos", () => {
    const base = checkpointInicial({ ventana: V, tipos: ["new"] });
    expect(
      checkpointV1.safeParse({ ...base, ventana: { from: 200, to: 100 } }).success,
    ).toBe(false);
    expect(
      checkpointV1.safeParse({
        ...base,
        pendiente: { changeType: "removed", cursorDeEntrada: null },
      }).success,
    ).toBe(false);
  });
});
