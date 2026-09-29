/**
 * Reproducir un recorrido de `upcoming` **desde su crudo y su estado de
 * partida**, sin red: el manifiesto se escribe de verdad en disco, se lee y
 * se sirve desde los ficheros, como hace `pnpm api:run:upcoming --reproducir`.
 *
 * Lo que un doble no puede demostrar —triggers, `ON CONFLICT` y `SAVEPOINT`
 * reales— lo cubre el `--ensayo` contra Neon.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { crearLibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import type { LibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import { leerPresupuesto } from "../../jobs/ops/presupuesto.ts";
import type { FuenteDeCuota, Transporte } from "../../jobs/ops/transporte.ts";
import { transaccionPorPagina } from "../../jobs/pipelines/deltas/job.ts";
import type {
  Manifiesto,
  RegistroLocal,
} from "../../jobs/pipelines/deltas/manifiesto.ts";
import {
  crearRegistroLocal,
  leerManifiesto,
  ventanaDesdeSegundos,
} from "../../jobs/pipelines/deltas/manifiesto.ts";
import { ejecutarJobDeUpcoming } from "../../jobs/pipelines/upcoming/job.ts";
import {
  compararConOriginal,
  planDeReconstruccion,
} from "../../jobs/pipelines/upcoming/reproduccion.ts";
import { grabadasDe } from "../../scripts/horizonte-manual.ts";
import { llamadaDesdeDisco } from "../../scripts/manual-comun.ts";
import { conexionDeDatos } from "./ayudas-checkpoint.ts";
import { respuestaCruda, showCrudo } from "./ayudas-deltas.ts";
import type { BaseEnMemoria } from "./base-en-memoria.ts";
import { crearBaseEnMemoria } from "./base-en-memoria.ts";

const T = new Date("2026-09-24T10:00:00.000Z");
const DIA = 86_400_000;
const en = (dias: number, desde = T) => new Date(desde.getTime() + dias * DIA);
const seg = (d: Date) => Math.floor(d.getTime() / 1000);

const CUOTA = {
  "x-quota-used": "120",
  "x-quota-granted": "1000",
  "x-quota-reset": "2026-10-01T00:00:00Z",
};

interface Mundo {
  readonly libro: LibroEnMemoria;
  readonly base: BaseEnMemoria;
}

const crearMundo = (): Mundo => ({
  libro: crearLibroEnMemoria(),
  base: crearBaseEnMemoria(),
});

/** Sirve por `(change_type, cursor)`: la «API» de la ejecución original. */
function red(listas: ReadonlyMap<string, unknown>) {
  let llamadas = 0;
  const crear =
    (fuente: FuenteDeCuota): Transporte =>
    async (url) => {
      await fuente.pedirCuota();
      llamadas++;
      const u = new URL(url);
      const cuerpo = listas.get(
        `${u.searchParams.get("change_type") ?? "?"}|${u.searchParams.get("cursor") ?? ""}`,
      );
      if (cuerpo === undefined) throw new Error(`sin página para ${url}`);
      return new Response(JSON.stringify(cuerpo), {
        status: 200,
        headers: { "content-type": "application/json", ...CUOTA },
      });
    };
  return { crear, llamadas: () => llamadas };
}

function anuncio(
  id: string,
  estreno: Date,
  servicio = "netflix",
  link: string | null = null,
) {
  const enlace = link ?? `https://${servicio}.test/${id}`;
  return {
    cambio: {
      changeType: "upcoming",
      showId: id,
      service: servicio,
      type: "subscription",
      ...(servicio === "prime" ? {} : { link: enlace }),
      timestamp: seg(estreno),
    },
    show: showCrudo({ id, imdbId: `tt${id.padStart(7, "0")}`, opciones: [] }),
  };
}

function pagina(avisos: readonly ReturnType<typeof anuncio>[], nextCursor?: string) {
  return respuestaCruda({
    cambios: avisos.map((a) => a.cambio),
    shows: avisos.map((a) => a.show),
    hasMore: nextCursor !== undefined,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  });
}

/** Día 0: tres anuncios conocidos (uno de ellos de SkyShowtime). */
const DIA_0 = new Map([
  [
    "upcoming|",
    pagina([
      anuncio("1", en(10)),
      anuncio("2", en(12)),
      anuncio("3", en(14), "skyshowtime"),
    ]),
  ],
]);

/**
 * Día 1, EL QUE SE GRABA: dos páginas; «2» ya no aparece, «4» es nuevo, «1»
 * se aplaza, y Prime anuncia uno **sin link**.
 */
const DIA_1 = new Map([
  ["upcoming|", pagina([anuncio("1", en(11)), anuncio("4", en(6))], "c1")],
  ["upcoming|c1", pagina([anuncio("5", en(20), "prime")])],
]);

async function correr(
  mundo: Mundo,
  entrada: {
    readonly crearLlamada: (fuente: FuenteDeCuota) => Transporte;
    readonly ahora: Date;
    readonly tope: number;
    readonly directorio: string | null;
    readonly ventana?: { readonly from: number; readonly to: number };
    readonly modo?: "ensayo" | "reproduccion";
  },
) {
  const datos = conexionDeDatos(mundo.base, mundo.libro);
  let registro: RegistroLocal | null = null;
  const directorio = entrada.directorio;
  const salida = await ejecutarJobDeUpcoming({
    // El destino histórico, declarado: el régimen por defecto es el estricto.
    regimen: "historico",
    ejecutorOps: mundo.libro.ejecutor,
    ejecutorDatos: datos.ejecutor,
    transaccion: transaccionPorPagina(datos.ejecutor),
    presupuesto: leerPresupuesto({
      STREAMING_API_PER_RUN_CAPS: `upcoming=${String(entrada.tope)}`,
    }),
    crearLlamada: entrada.crearLlamada,
    apiKey: "k",
    plan:
      entrada.ventana === undefined
        ? { origen: "persistente" }
        : { origen: "fijo", ventana: ventanaDesdeSegundos(entrada.ventana) },
    ahora: entrada.ahora,
    crearRegistro:
      directorio === null
        ? null
        : (cabecera) => {
            registro = crearRegistroLocal(directorio, {
              modo: entrada.modo ?? "ensayo",
              pipeline: "upcoming",
              ...cabecera,
            });
            return registro;
          },
    vincularEventos: true,
  });
  return { salida, manifiesto: (registro as RegistroLocal | null)?.manifiesto() };
}

/**
 * La reproducción, como la hace el script: el crudo desde disco, la ventana
 * y el `ahora` GRABADOS, y como tope lo que la original gastó.
 */
async function reproducirDesde(mundo: Mundo, dir: string, destino: string) {
  const original = leerManifiesto(dir, "upcoming");
  let pedidas = 0;
  const disco = llamadaDesdeDisco(grabadasDe(dir, original));
  const r = await correr(mundo, {
    crearLlamada: (fuente) => {
      const t = disco(fuente);
      return (url, init) => {
        pedidas++;
        return t(url, init);
      };
    },
    ahora: new Date(original.ahora),
    tope: Math.max(1, original.requests.reservadas),
    directorio: destino,
    ventana: original.ventana,
    modo: "reproduccion",
  });
  return { original, ...r, pedidasAlDisco: pedidas };
}

/** El manifiesto de la repetición: tiene que existir. */
function definido(m: Manifiesto | undefined): Manifiesto {
  if (m === undefined) throw new Error("la repetición no dejó manifiesto");
  return m;
}

let temporal: string | null = null;
afterEach(() => {
  if (temporal !== null) rmSync(temporal, { recursive: true, force: true });
  temporal = null;
});

function nuevoTemporal(): string {
  temporal = mkdtempSync(join(tmpdir(), "upcoming-"));
  return temporal;
}

// ── Reproducción exacta ──────────────────────────────────────────────────────

describe("reproducción exacta desde el manifiesto, sin API", () => {
  async function grabar() {
    const dir = nuevoTemporal();
    const mundo = crearMundo();
    await correr(mundo, {
      crearLlamada: red(DIA_0).crear,
      ahora: T,
      tope: 12,
      directorio: null,
    });
    const api = red(DIA_1);
    const original = await correr(mundo, {
      crearLlamada: api.crear,
      ahora: en(1),
      tope: 12,
      directorio: join(dir, "original"),
    });
    return { dir, mundo, original, llamadasALaApi: api.llamadas() };
  }

  it("el manifiesto guarda horizonte y anuncios de upcoming", async () => {
    const { dir, original, llamadasALaApi } = await grabar();
    expect(llamadasALaApi).toBe(2);
    const m = leerManifiesto(join(dir, "original"), "upcoming");
    expect(m.pipeline).toBe("upcoming");
    expect(m.tipos).toEqual(["upcoming"]);
    expect(m.respuestas).toHaveLength(2);
    expect(m.horizonte).toEqual({
      completo: true,
      desaparecidas: 1,
      muestra: ["tt0000002|netflix|es|subscription|"],
      fueraDeCobertura: 1,
    });
    expect(m.anuncios?.sinEnlace.total).toBe(1);
    expect(m.anuncios?.sinEnlace.muestra[0]).toMatchObject({
      imdbId: "tt0000005",
      plataforma: "prime",
      instante: en(20).toISOString(),
    });
    // ADR 0007: lo que los anuncios hicieron con su tabla, conflictos incluidos.
    expect(m.anunciosGuardados).toMatchObject({ sinEnlace: 1, conflictos: [] });
    expect(m.anunciosGuardados?.observados).toBe(
      (m.anunciosGuardados?.nuevos ?? 0) +
        (m.anunciosGuardados?.sinCambios ?? 0) +
        (m.anunciosGuardados?.actualizados ?? 0) +
        (m.anunciosGuardados?.nuevosCiclos ?? 0) +
        (m.anunciosGuardados?.mismaObservacion ?? 0) +
        (m.anunciosGuardados?.enlacesCompletados ?? 0) +
        (m.anunciosGuardados?.fueraDeOrden ?? 0),
    );
    expect(m).toEqual(original.manifiesto);
  });

  it("desde el mismo estado de partida, TODO coincide: estado, eventos, horizonte y anuncios", async () => {
    const { dir, mundo } = await grabar();

    // El mismo estado de partida: el día 0, reconstruido en otra base.
    const copia = crearMundo();
    await correr(copia, {
      crearLlamada: red(DIA_0).crear,
      ahora: T,
      tope: 12,
      directorio: null,
    });
    const r = await reproducirDesde(
      copia,
      join(dir, "original"),
      join(dir, "repetida"),
    );

    expect(r.pedidasAlDisco).toBe(2);
    const diferencias = compararConOriginal(r.original, definido(r.manifiesto), true);
    expect(diferencias.filter((d) => !d.igual)).toEqual([]);
    expect(diferencias.every((d) => d.exigible)).toBe(true);
    expect(copia.base.foto()).toEqual(mundo.base.foto());
  });

  it("repetirla otra vez es un no-op: 0 eventos y la misma base", async () => {
    const { dir, mundo } = await grabar();
    const antes = mundo.base.foto();
    const r = await reproducirDesde(
      mundo,
      join(dir, "original"),
      join(dir, "otra-vez"),
    );
    expect(r.salida.informe?.eventos).toEqual({});
    expect(mundo.base.foto()).toEqual(antes);
    // De idempotencia: lo que sale del crudo coincide igual.
    const exigibles = compararConOriginal(r.original, definido(r.manifiesto), false)
      .filter((d) => d.exigible && !d.igual)
      .map((d) => d.campo);
    expect(exigibles).toEqual([]);
  });

  it("un recorrido cortado se reproduce cortado en el mismo punto", async () => {
    const dir = nuevoTemporal();
    const original = await correr(crearMundo(), {
      crearLlamada: red(DIA_1).crear,
      ahora: en(1),
      tope: 1,
      directorio: join(dir, "corte"),
    });
    expect(original.salida.resultado).toMatchObject({ estado: "budget_stopped" });
    const r = await reproducirDesde(crearMundo(), join(dir, "corte"), join(dir, "rep"));
    expect(r.salida.resultado).toMatchObject({ estado: "budget_stopped" });
    expect(r.salida.horizonte?.desaparecidas).toBeNull();
    expect(
      compararConOriginal(r.original, definido(r.manifiesto), true).filter(
        (d) => !d.igual,
      ),
    ).toEqual([]);
  });
});

// ── Qué se compara ───────────────────────────────────────────────────────────

describe("compararConOriginal de upcoming", () => {
  const base: Manifiesto = {
    version: 1,
    pipeline: "upcoming",
    modo: "ensayo",
    creadoEn: "2026-09-24T12:00:00.000Z",
    ahora: "2026-09-21T12:42:20.000Z",
    ventana: { from: 1789994480, to: 1792672940 },
    tipos: ["upcoming"],
    reanudaDe: null,
    runId: null,
    requests: { reservadas: 1, respuestas: 1, respuestasOk: 1 },
    respuestas: [],
    paginas: [],
    cuotaDelProveedor: [],
    estado: "succeeded",
    reanudacion: null,
    horizonte: { completo: true, desaparecidas: 0, muestra: [], fueraDeCobertura: 0 },
    anuncios: {
      paginas: 1,
      completo: true,
      avisos: 4,
      porPlataforma: {
        netflix: 0,
        prime: 4,
        disney: 0,
        max: 0,
        apple: 0,
        skyshowtime: 0,
      },
      fueraDelMvp: {},
      sinEnlace: { total: 4, porPlataforma: { prime: 4 }, muestra: [] },
      sinDisponibilidadEnEs: 4,
      yaEnElCatalogo: 0,
      sinShow: 0,
      fueraDelHorizonte: { antes: 0, despues: 0 },
      repetidos: 0,
    },
  };

  it("los anuncios salen del crudo: se exigen también en una de idempotencia", () => {
    const otros = structuredClone(base) as Manifiesto & {
      anuncios: { sinEnlace: { total: number } };
    };
    otros.anuncios.sinEnlace.total = 3;
    for (const exacta of [true, false]) {
      const fallidos = compararConOriginal(base, otros, exacta)
        .filter((d) => d.exigible && !d.igual)
        .map((d) => d.campo);
      expect(fallidos).toEqual([
        "anuncios (crudo: plataformas, sin enlace, fuera del horizonte)",
      ]);
    }
  });

  it("los anuncios guardados dependen del estado: solo se exigen en una exacta", () => {
    const vacio = {
      observados: 4,
      nuevos: 4,
      sinCambios: 0,
      actualizados: 0,
      fechasCambiadas: 0,
      enlacesCambiados: 0,
      nuevosCiclos: 0,
      mismaObservacion: 0,
      enlacesCompletados: 0,
      enlacesConservados: 0,
      fueraDeOrden: 0,
      sinEnlace: 4,
      conflictos: [],
    };
    const original: Manifiesto = { ...base, anunciosGuardados: vacio };
    // Una de idempotencia: los cuatro son ya la misma observación.
    const repetida: Manifiesto = {
      ...base,
      anunciosGuardados: { ...vacio, nuevos: 0, mismaObservacion: 4 },
    };
    const campo = "anuncios guardados (nuevos, actualizados, ciclos, conflictos)";
    const de = (exacta: boolean) =>
      compararConOriginal(original, repetida, exacta).find((d) => d.campo === campo);
    expect(de(true)).toMatchObject({ exigible: true, igual: false });
    expect(de(false)).toMatchObject({ exigible: false, igual: false });
  });

  it("📏 por valor, no por texto: otro orden de claves es el mismo manifiesto", () => {
    // Como `jsonb`, que devuelve las claves en otro orden (fila 44).
    const invertir = (x: unknown): unknown =>
      Array.isArray(x)
        ? x.map(invertir)
        : x !== null && typeof x === "object"
          ? Object.fromEntries(
              Object.entries(x)
                .reverse()
                .map(([k, v]) => [k, invertir(v)]),
            )
          : x;
    const invertido = invertir(base) as Manifiesto;
    expect(JSON.stringify(invertido.anuncios)).not.toBe(JSON.stringify(base.anuncios));
    expect(compararConOriginal(base, invertido, true).every((d) => d.igual)).toBe(true);
  });
});

describe("planDeReconstruccion de upcoming", () => {
  it("un ensayo sin estado inicial pide repetir el ensayo de upcoming, no el de expiring", () => {
    const leer = () => ({ ...({} as Manifiesto), modo: "ensayo" }) as Manifiesto;
    expect(() =>
      planDeReconstruccion("/e/viejo", leer, (b, r) => posix.resolve(b, r)),
    ).toThrow(/pnpm api:run:upcoming --ensayo/);
  });
});
