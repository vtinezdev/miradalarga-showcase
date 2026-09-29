/**
 * El job de `updated` en modo real (`vincularEventos: true`), **sin red y sin
 * base de datos**: el libro y la base en memoria, como `expiring-job.test.ts`.
 *
 * Lo que se prueba aquí es lo que `updated` comparte con `deltas` —la ventana
 * contigua hacia atrás, el checkpoint persistente y su reanudación (ADR
 * 0006)— y lo que no: su checkpoint es suyo, su tope en el repositorio es 0 y
 * su manifiesto lleva la clasificación, que se reproduce exacta.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { crearLibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import type { LibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import { leerPresupuesto } from "../../jobs/ops/presupuesto.ts";
import type { FuenteDeCuota, Transporte } from "../../jobs/ops/transporte.ts";
import { checkpointInicial } from "../../jobs/pipelines/deltas/checkpoint.ts";
import { transaccionPorPagina } from "../../jobs/pipelines/deltas/job.ts";
import type { Manifiesto } from "../../jobs/pipelines/deltas/manifiesto.ts";
import {
  crearRegistroLocal,
  leerManifiesto,
  ventanaDesdeSegundos,
  ventanaEnSegundos,
} from "../../jobs/pipelines/deltas/manifiesto.ts";
import { ventanaHaciaAtras } from "../../jobs/pipelines/deltas/origen.ts";
import { compararConOriginal } from "../../jobs/pipelines/horizonte/reproduccion.ts";
import type { PlanDeUpdated } from "../../jobs/pipelines/updated/job.ts";
import { ejecutarJobDeUpdated } from "../../jobs/pipelines/updated/job.ts";
import { CAMPOS_PROPIOS_DE_UPDATED } from "../../jobs/pipelines/updated/reproduccion.ts";
import { conexionDeDatos } from "./ayudas-checkpoint.ts";
import type { OpcionCruda } from "./ayudas-deltas.ts";
import { respuestaCruda, showCrudo } from "./ayudas-deltas.ts";
import { foto, sembrar } from "./ayudas-updated.ts";
import type { BaseEnMemoria } from "./base-en-memoria.ts";
import { crearBaseEnMemoria } from "./base-en-memoria.ts";

const CUOTA = {
  "x-quota-used": "130",
  "x-quota-granted": "1000",
  "x-quota-reset": "2026-10-01T00:00:00Z",
};

const T0 = new Date("2026-09-24T06:00:00.000Z");
const T = new Date("2026-09-25T06:00:00.000Z");
const HORA = 3_600_000;
const seg = (d: Date) => Math.floor(d.getTime() / 1000);

const COMPRA: OpcionCruda = {
  service: "apple",
  type: "buy",
  link: "https://apple.test/7",
  quality: "hd",
  price: { amount: "9.99", currency: "EUR" },
};
const show = (precio: string) =>
  showCrudo({
    id: "7",
    imdbId: "tt0000007",
    opciones: [{ ...COMPRA, price: { amount: precio, currency: "EUR" } }],
  });
const aviso = {
  changeType: "updated",
  showId: "7",
  service: "apple",
  type: "buy",
  timestamp: seg(T0) + 3600,
};

/** Dos páginas: la 1 baja el precio a 4.99 y la 2 no cambia nada más. */
const PAGINA_1 = respuestaCruda({
  cambios: [aviso],
  shows: [show("4.99")],
  hasMore: true,
  nextCursor: "1790300000:42",
});
const PAGINA_2 = respuestaCruda({ cambios: [aviso], shows: [show("4.99")] });
const DOS_PAGINAS = new Map<string, unknown>([
  ["updated|", PAGINA_1],
  ["updated|1790300000:42", PAGINA_2],
]);

// ── Dobles ───────────────────────────────────────────────────────────────────

function servidor(listas: ReadonlyMap<string, unknown>) {
  const urls: URL[] = [];
  const crear =
    (fuente: FuenteDeCuota): Transporte =>
    async (url) => {
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

async function mundoConCatalogo(): Promise<Mundo> {
  const base = crearBaseEnMemoria();
  await sembrar(base, T0, [show("9.99")]);
  return { libro: crearLibroEnMemoria(), base };
}

async function ejecutar(
  mundo: Mundo,
  entrada: {
    readonly listas?: ReadonlyMap<string, unknown>;
    readonly ahora?: Date;
    /** `null` = el presupuesto del repositorio, sin inyectar nada. */
    readonly tope?: number | null;
    readonly plan?: PlanDeUpdated;
    readonly directorio?: string;
    readonly vincularEventos?: boolean;
  } = {},
) {
  const datos = conexionDeDatos(mundo.base, mundo.libro);
  const red = servidor(entrada.listas ?? DOS_PAGINAS);
  const tope = entrada.tope === undefined ? 4 : entrada.tope;
  const directorio = entrada.directorio;
  const salida = await ejecutarJobDeUpdated({
    // El destino histórico, declarado: el régimen por defecto es el estricto.
    regimen: "historico",
    ejecutorOps: mundo.libro.ejecutor,
    ejecutorDatos: datos.ejecutor,
    transaccion: transaccionPorPagina(datos.ejecutor),
    presupuesto: leerPresupuesto(
      tope === null ? {} : { STREAMING_API_PER_RUN_CAPS: `updated=${String(tope)}` },
    ),
    crearLlamada: red.crear,
    apiKey: "k",
    plan: entrada.plan ?? {
      origen: "persistente",
      sinCheckpoint: "ventana_de_validacion",
    },
    ahora: entrada.ahora ?? T,
    crearRegistro:
      directorio === undefined
        ? null
        : (cabecera) =>
            crearRegistroLocal(directorio, {
              modo: "ensayo",
              pipeline: "updated",
              ...cabecera,
            }),
    vincularEventos: entrada.vincularEventos ?? true,
  });
  const runId = salida.resultado.ejecutado ? salida.resultado.runId : -1;
  const fila = mundo.libro.filas.find((f) => f.id === runId);
  return { salida, red, fila };
}

const estado = (s: { resultado: { ejecutado: boolean } }) => {
  const r = s.resultado as { ejecutado: boolean; estado?: string };
  return r.ejecutado ? r.estado : "no_ejecutado";
};

// ── La ventana ───────────────────────────────────────────────────────────────

describe("la ventana de updated: contigua hacia atrás", () => {
  it("sin checkpoint, en validación: [ahora − 24 h, ahora] con la query medida", async () => {
    const mundo = await mundoConCatalogo();
    const { salida, red, fila } = await ejecutar(mundo);
    expect(estado(salida)).toBe("succeeded");
    expect(fila?.pipeline).toBe("updated");

    const q = red.urls[0]?.searchParams;
    const esperada = ventanaEnSegundos(ventanaHaciaAtras(T));
    expect(q?.get("change_type")).toBe("updated");
    expect(Number(q?.get("from"))).toBe(esperada.from);
    expect(Number(q?.get("to"))).toBe(esperada.to);
    // 📏 La query medida de `raw/055` no lo llevaba: no se envía.
    expect(q?.has("include_unknown_dates")).toBe(false);
    expect(red.urls[1]?.searchParams.get("cursor")).toBe("1790300000:42");

    expect(salida.checkpoint).toMatchObject({
      tipos: ["updated"],
      pendiente: null,
      paginasConfirmadas: 2,
    });
    expect(salida.contadores.reservasConcedidas).toBe(2);
  });

  it("la siguiente ejecución empieza donde terminó la anterior", async () => {
    const mundo = await mundoConCatalogo();
    const a = await ejecutar(mundo);
    const b = await ejecutar(mundo, { ahora: new Date(T.getTime() + 24 * HORA) });
    expect(b.salida.checkpoint?.ventana.from).toBe(a.salida.checkpoint?.ventana.to);
  });

  it("sin checkpoint y sin permiso para la ventana de validación: failed, 0 requests", async () => {
    const mundo = await mundoConCatalogo();
    const { salida, red } = await ejecutar(mundo, {
      plan: { origen: "persistente", sinCheckpoint: "prohibido" },
    });
    expect(estado(salida)).toBe("failed");
    expect(red.urls).toHaveLength(0);
  });

  it("el checkpoint de deltas no le sirve: cada pipeline lee solo el suyo", async () => {
    const mundo = await mundoConCatalogo();
    mundo.libro.sembrarFila({
      pipeline: "deltas",
      status: "succeeded",
      checkpoint: {
        ...checkpointInicial({
          ventana: ventanaEnSegundos(ventanaHaciaAtras(T0)),
          tipos: ["removed", "new"],
        }),
        pendiente: null,
      },
    });
    const { salida, red } = await ejecutar(mundo, {
      plan: { origen: "persistente", sinCheckpoint: "prohibido" },
    });
    expect(estado(salida)).toBe("failed");
    expect(red.urls).toHaveLength(0);
  });
});

// ── Presupuesto ──────────────────────────────────────────────────────────────

describe("presupuesto", () => {
  it("con el presupuesto del repositorio (tope 0) no gasta ni una request", async () => {
    const mundo = await mundoConCatalogo();
    const { salida, red } = await ejecutar(mundo, { tope: null });
    expect(estado(salida)).toBe("budget_stopped");
    expect(salida.contadores.reservasConcedidas).toBe(0);
    expect(red.urls).toHaveLength(0);
    expect(salida.clasificacion).toBeNull();
  });

  it("corte por tope: la siguiente reanuda la misma ventana con el mismo cursor", async () => {
    const limpio = await mundoConCatalogo();
    await ejecutar(limpio);

    const mundo = await mundoConCatalogo();
    const a = await ejecutar(mundo, { tope: 1 });
    expect(estado(a.salida)).toBe("budget_stopped");
    expect(a.salida.checkpoint?.pendiente).toEqual({
      changeType: "updated",
      cursorDeEntrada: "1790300000:42",
    });

    const b = await ejecutar(mundo, { ahora: new Date(T.getTime() + HORA) });
    expect(estado(b.salida)).toBe("succeeded");
    expect(b.salida.checkpoint?.reanudaDe).toBe(a.fila?.id);
    expect(b.salida.checkpoint?.ventana).toEqual(a.salida.checkpoint?.ventana);
    expect(b.red.urls).toHaveLength(1);
    expect(b.red.urls[0]?.searchParams.get("cursor")).toBe("1790300000:42");

    // Cortado y reanudado deja el mismo estado y los mismos eventos que de una vez.
    const final = (m: Mundo) => {
      const f = foto(m.base, false);
      return { opciones: f.opciones, eventos: f.eventos.map((e) => e.tipo) };
    };
    expect(final(mundo)).toEqual(final(limpio));
  });
});

// ── Manifiesto y reproducción ────────────────────────────────────────────────

describe("manifiesto y reproducción exacta", () => {
  let dir = "";
  afterEach(() => {
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  /** Las respuestas grabadas de un manifiesto, servidas por `(tipo, cursor)`. */
  function grabadas(directorio: string, m: Manifiesto) {
    const listas = new Map<string, unknown>();
    for (const r of m.respuestas) {
      listas.set(
        `${r.changeType ?? "?"}|${r.cursorDeEntrada ?? ""}`,
        JSON.parse(readFileSync(join(directorio, r.fichero), "utf8")) as unknown,
      );
    }
    return listas;
  }

  it("el manifiesto lleva la clasificación, y reproducirlo desde el mismo estado la repite", async () => {
    dir = mkdtempSync(join(tmpdir(), "updated-"));
    const ventana = ventanaHaciaAtras(T);

    const original = await ejecutar(await mundoConCatalogo(), {
      plan: { origen: "fijo", ventana },
      directorio: join(dir, "original"),
      vincularEventos: false,
    });
    expect(estado(original.salida)).toBe("succeeded");
    const m = leerManifiesto(join(dir, "original"), "updated");
    expect(m.updated).toEqual(original.salida.clasificacion);
    expect(m.updated?.porResultado).toMatchObject({ evento: 1, misma_observacion: 1 });
    expect(m.updated?.precios).toMatchObject({ cambios: 1, bajan: 1 });

    // Mismo estado de partida, mismo crudo, misma ventana, mismo `ahora`.
    const repetida = await ejecutar(await mundoConCatalogo(), {
      listas: grabadas(join(dir, "original"), m),
      plan: { origen: "fijo", ventana: ventanaDesdeSegundos(m.ventana) },
      ahora: new Date(m.ahora),
      directorio: join(dir, "repetida"),
      vincularEventos: false,
    });
    const r = leerManifiesto(join(dir, "repetida"), "updated");
    const diferencias = compararConOriginal(m, r, true, CAMPOS_PROPIOS_DE_UPDATED);
    expect(diferencias.filter((d) => !d.igual)).toEqual([]);
    expect(repetida.salida.clasificacion).toEqual(original.salida.clasificacion);
  });

  it("reproducir sobre el estado ya escrito es un no-op: la clasificación del crudo coincide y la completa no", async () => {
    dir = mkdtempSync(join(tmpdir(), "updated-"));
    const mundo = await mundoConCatalogo();
    const ventana = ventanaHaciaAtras(T);
    await ejecutar(mundo, {
      plan: { origen: "fijo", ventana },
      directorio: join(dir, "original"),
      vincularEventos: false,
    });
    const m = leerManifiesto(join(dir, "original"), "updated");
    const eventos = mundo.base.eventos().length;

    const otra = await ejecutar(mundo, {
      listas: grabadas(join(dir, "original"), m),
      plan: { origen: "fijo", ventana },
      directorio: join(dir, "otra"),
      vincularEventos: false,
    });
    expect(otra.salida.informe?.eventosEscritos).toBe(0);
    expect(mundo.base.eventos()).toHaveLength(eventos);
    expect(otra.salida.clasificacion?.porResultado).toMatchObject({
      misma_observacion: 2,
    });

    const r = leerManifiesto(join(dir, "otra"), "updated");
    const porCampo = new Map(
      compararConOriginal(m, r, false, CAMPOS_PROPIOS_DE_UPDATED).map((d) => [
        d.campo,
        d,
      ]),
    );
    expect(
      porCampo.get(
        "clasificación de updated (del crudo: avisos por plataforma y tipo)",
      ),
    ).toMatchObject({ exigible: true, igual: true });
    expect(porCampo.get("clasificación de updated (completa)")).toMatchObject({
      exigible: false,
      igual: false,
    });
  });
});
