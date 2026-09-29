/**
 * **Un anuncio frente a lo que ya está en la base**: la protección contra
 * escrituras fuera de orden (`deltas/index.ts`) y, desde el ADR 0007, que un
 * anuncio **no toca la disponibilidad**: vive en su propia tabla. Con el job
 * de `upcoming` real sobre la base en memoria.
 *
 * 📏 El caso que las motivó (ensayo del 2026-09-24): el ensayo aplica
 * `raw/024`, capturado el **21-sep**, sobre una rama que la fila 21 de
 * `deltas` había actualizado el **23-sep**. Cuatro títulos anunciados ya
 * estaban dados de alta, con su fecha observada:
 *
 *   · `tt9000126` (Apple, `uhd`): el anuncio creaba una **opción fantasma**
 *     `(link, NULL)` junto a la real.
 *   · `tt90000082`, `tt90000101`, `tt90000059` (Netflix, sin `quality`): la
 *     sintética colisionaba con la real y **sobrescribía** su
 *     `available_since`, su `video_link` y sus idiomas.
 *
 * Los recortes son de datos reales: `deltas-fila21-new-solapados.json` (la
 * respuesta `new` de la fila 21) y `upcoming-solapados-con-fila21.json`
 * (`raw/024`).
 *
 * ⚖️ Desde el ADR 0007 ninguno de esos dos daños es posible por construcción
 * —un anuncio ya no sintetiza opciones—, pero los tests se quedan: son la
 * prueba de que la disponibilidad observada sale intacta de un `upcoming`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { crearLibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import { leerPresupuesto } from "../../jobs/ops/presupuesto.ts";
import type { FuenteDeCuota, Transporte } from "../../jobs/ops/transporte.ts";
import { ejecutarDeltas } from "../../jobs/pipelines/deltas/index.ts";
import { transaccionPorPagina } from "../../jobs/pipelines/deltas/job.ts";
import { ejecutarJobDeUpcoming } from "../../jobs/pipelines/upcoming/job.ts";
import { conexionDeDatos } from "./ayudas-checkpoint.ts";
import type { OpcionCruda } from "./ayudas-deltas.ts";
import { respuestaCruda, showCrudo } from "./ayudas-deltas.ts";
import type { BaseEnMemoria } from "./base-en-memoria.ts";
import { crearBaseEnMemoria } from "./base-en-memoria.ts";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "changes");
const leer = (nombre: string) =>
  JSON.parse(readFileSync(join(FIXTURES, nombre), "utf8")) as {
    readonly meta: { readonly ahora?: string; readonly ts_utc?: string };
    readonly body: {
      readonly changes: readonly {
        readonly showId: string;
        readonly service: { readonly id: string };
        readonly link?: string;
        readonly timestamp: number;
      }[];
      readonly shows: Readonly<Record<string, { readonly imdbId: string }>>;
    };
  };

const FILA_21 = leer("deltas-fila21-new-solapados.json");
const RAW_024 = leer("upcoming-solapados-con-fila21.json");
/** El `ahora` de la fila 21: el estado MÁS NUEVO. */
const T_FILA_21 = new Date(FILA_21.meta.ahora ?? "");
/** El `ahora` del ensayo: `to` de `raw/024` − 31 días. El aviso MÁS VIEJO. */
const T_ENSAYO = new Date("2026-09-21T12:42:20.000Z");

const T = new Date("2026-09-24T10:00:00.000Z");
const DIA = 86_400_000;
const en = (dias: number, desde = T) => new Date(desde.getTime() + dias * DIA);
const seg = (d: Date) => Math.floor(d.getTime() / 1000);

const CUOTA = {
  "x-quota-used": "1",
  "x-quota-granted": "1000",
  "x-quota-reset": "2026-10-01T00:00:00Z",
};

interface Mundo {
  readonly libro: ReturnType<typeof crearLibroEnMemoria>;
  readonly base: BaseEnMemoria;
}

const crearMundo = (): Mundo => ({
  libro: crearLibroEnMemoria(),
  base: crearBaseEnMemoria(),
});

/** Aplica una página `new` como lo hace `deltas`: así nace el estado real. */
async function estadoDeDeltas(mundo: Mundo, cuerpo: unknown, ahora: Date) {
  await ejecutarDeltas({
    ejecutor: mundo.base.ejecutor,
    peticion: {
      transporte: () =>
        Promise.resolve(new Response(JSON.stringify(cuerpo), { status: 200 })),
      apiKey: "k",
    },
    tipos: ["new"],
    ventana: null,
    ahora,
    maximoDePaginas: 1,
  });
}

/** Un recorrido de `upcoming` completo, de una página. */
async function upcoming(mundo: Mundo, cuerpo: unknown, ahora: Date) {
  const datos = conexionDeDatos(mundo.base, mundo.libro);
  const crear =
    (fuente: FuenteDeCuota): Transporte =>
    async () => {
      await fuente.pedirCuota();
      return new Response(JSON.stringify(cuerpo), {
        status: 200,
        headers: { "content-type": "application/json", ...CUOTA },
      });
    };
  const salida = await ejecutarJobDeUpcoming({
    // El destino histórico, declarado: el régimen por defecto es el estricto.
    regimen: "historico",
    ejecutorOps: mundo.libro.ejecutor,
    ejecutorDatos: datos.ejecutor,
    transaccion: transaccionPorPagina(datos.ejecutor),
    presupuesto: leerPresupuesto({ STREAMING_API_PER_RUN_CAPS: "upcoming=12" }),
    crearLlamada: crear,
    apiKey: "k",
    plan: { origen: "persistente" },
    ahora,
    crearRegistro: null,
    vincularEventos: true,
  });
  expect(salida.resultado).toMatchObject({ ejecutado: true, estado: "succeeded" });
  return salida;
}

interface OpcionDeFoto {
  readonly oferta: string;
  readonly link: string;
  readonly quality: string | null;
  readonly videoLink: string | null;
  readonly availableSince: string | null;
  readonly audioLanguages: readonly string[];
}
interface Foto {
  readonly opciones: readonly OpcionDeFoto[];
  readonly eventos: readonly { readonly oferta: string; readonly tipo: string }[];
}
/** La disponibilidad: todo menos los anuncios, que viven aparte (ADR 0007). */
const foto = (base: BaseEnMemoria, instantes = true): Foto => {
  const { anuncios: _anuncios, ...resto } = base.foto({ instantes }) as Foto & {
    anuncios: unknown;
  };
  return resto;
};

/** Los cuatro títulos, con la plataforma y el link de su anuncio. */
const CASOS = RAW_024.body.changes.map((c) => ({
  imdb: RAW_024.body.shows[c.showId]?.imdbId ?? "?",
  plataforma: c.service.id,
  link: c.link ?? "",
  timestamp: c.timestamp,
}));

const delLink = (f: Foto, caso: (typeof CASOS)[number]) =>
  f.opciones.filter(
    (o) =>
      o.oferta.startsWith(`${caso.imdb}|${caso.plataforma}|`) && o.link === caso.link,
  );

// ── 📏 Los cuatro casos reales ───────────────────────────────────────────────

describe("📏 los cuatro títulos que raw/024 anuncia y la fila 21 ya había dado de alta", () => {
  it("son los esperados, con link, y la fila 21 los dejó con su fecha observada", async () => {
    expect(CASOS.map((c) => c.imdb).sort()).toEqual([
      "tt90000059",
      "tt90000082",
      "tt90000101",
      "tt9000126",
    ]);
    const mundo = crearMundo();
    await estadoDeDeltas(mundo, FILA_21.body, T_FILA_21);
    const f = foto(mundo.base);
    for (const caso of CASOS) {
      const filas = delLink(f, caso);
      expect(filas, caso.imdb).toHaveLength(1);
      // La fecha observada NO es la del anuncio: por eso se notaba el pisotón.
      expect(filas[0]?.availableSince).not.toBe(
        new Date(caso.timestamp * 1000).toISOString(),
      );
      // 📏 Netflix trae `videoLink`; Apple no. Es lo que un pisotón borraría.
      expect(filas[0]?.videoLink !== null, caso.imdb).toBe(
        caso.plataforma === "netflix",
      );
    }
  });

  it("estado más nuevo → aviso upcoming más viejo → estado IDÉNTICO, sin fantasma ni `changed`", async () => {
    const mundo = crearMundo();
    await estadoDeDeltas(mundo, FILA_21.body, T_FILA_21);
    const antes = foto(mundo.base);

    const salida = await upcoming(mundo, RAW_024.body, T_ENSAYO);

    expect(foto(mundo.base)).toEqual(antes);
    expect(salida.informe?.eventos).toEqual({});
    for (const caso of CASOS) {
      expect(delLink(foto(mundo.base), caso), caso.imdb).toEqual(delLink(antes, caso));
    }
    // El aviso sigue contado, y su anuncio queda en su tabla: no había
    // ninguno previo, así que no es fuera de orden respecto a los anuncios.
    expect(salida.anuncios?.avisos).toBe(4);
    expect(mundo.base.anuncios().map((a) => a.imdbId)).toEqual(
      CASOS.map((c) => c.imdb).sort(),
    );
  });

  // Uno a uno: cada caso tiene que caer por sí mismo con el código anterior.
  it.each(CASOS.map((c) => [c.imdb, c] as const))(
    "%s: el aviso viejo no crea fantasma, no pisa filas y no emite evento",
    async (_imdb, caso) => {
      const mundo = crearMundo();
      await estadoDeDeltas(mundo, FILA_21.body, T_FILA_21);
      const antes = foto(mundo.base);
      await upcoming(mundo, RAW_024.body, T_ENSAYO);
      const despues = foto(mundo.base);
      expect(delLink(despues, caso)).toEqual(delLink(antes, caso));
      const deLaOferta = (f: Foto) =>
        f.eventos.filter((e) =>
          e.oferta.startsWith(`${caso.imdb}|${caso.plataforma}|`),
        );
      expect(deLaOferta(despues)).toEqual(deLaOferta(antes));
    },
  );

  it("con una observación FRESCA tampoco: la oferta ya está en el catálogo", async () => {
    const mundo = crearMundo();
    await estadoDeDeltas(mundo, FILA_21.body, T_FILA_21);
    const antes = foto(mundo.base, false);

    const salida = await upcoming(mundo, RAW_024.body, en(1, T_FILA_21));

    for (const caso of CASOS) {
      expect(delLink(foto(mundo.base, false), caso), caso.imdb).toEqual(
        delLink(antes, caso),
      );
    }
    // Ningún evento nuevo sobre las ofertas anunciadas.
    const anunciadas = CASOS.map((c) => `${c.imdb}|${c.plataforma}|`);
    const eventosDe = (f: Foto) =>
      f.eventos.filter((e) => anunciadas.some((p) => e.oferta.startsWith(p)));
    expect(eventosDe(foto(mundo.base))).toEqual(eventosDe(antes));
    expect(salida.anuncios?.avisos).toBe(4);
  });
});

// ── Orden temporal, con datos sintéticos ─────────────────────────────────────

const LINK = "https://tv.test/serie/1";

function nuevo(opcion: Omit<OpcionCruda, "service" | "type" | "link">, id = "1") {
  return respuestaCruda({
    cambios: [
      {
        changeType: "new",
        showId: id,
        service: "apple",
        type: "subscription",
        link: LINK,
        timestamp: opcion.availableSince ?? 0,
      },
    ],
    shows: [
      conVideo(
        showCrudo({
          id,
          imdbId: `tt${id.padStart(7, "0")}`,
          opciones: [{ service: "apple", type: "subscription", link: LINK, ...opcion }],
        }),
      ),
    ],
  });
}

/** `showCrudo` no pone `videoLink`: se añade para ver si alguien lo borra. */
function conVideo(show: Record<string, unknown>) {
  const es = (show.streamingOptions as { es: Record<string, unknown>[] }).es;
  return {
    ...show,
    streamingOptions: {
      es: es.map((o) => ({ ...o, videoLink: `${String(o.link)}/play` })),
    },
  };
}

function anuncio(estreno: Date, id = "1", opciones: readonly OpcionCruda[] = []) {
  return respuestaCruda({
    cambios: [
      {
        changeType: "upcoming",
        showId: id,
        service: "apple",
        type: "subscription",
        link: LINK,
        timestamp: seg(estreno),
      },
    ],
    shows: [showCrudo({ id, imdbId: `tt${id.padStart(7, "0")}`, opciones })],
  });
}

describe("orden temporal: estado más nuevo → aviso upcoming más viejo → estado idéntico", () => {
  it("sin la oferta en el snapshot del anuncio", async () => {
    const mundo = crearMundo();
    await estadoDeDeltas(
      mundo,
      nuevo({ quality: "hd", availableSince: seg(en(1)) }),
      en(2),
    );
    const antes = foto(mundo.base);
    const salida = await upcoming(mundo, anuncio(en(1.5)), T);
    expect(foto(mundo.base)).toEqual(antes);
    expect(salida.informe?.eventos).toEqual({});
  });

  it("y aunque el snapshot viejo SÍ la liste con otros datos: no pisa lo más nuevo", async () => {
    const mundo = crearMundo();
    await estadoDeDeltas(
      mundo,
      nuevo({ quality: "hd", availableSince: seg(en(1)) }),
      en(2),
    );
    const antes = foto(mundo.base);
    const viejo = anuncio(en(1.5), "1", [
      {
        service: "apple",
        type: "subscription",
        link: LINK,
        availableSince: seg(en(3)),
      },
    ]);
    const salida = await upcoming(mundo, viejo, T);
    expect(foto(mundo.base)).toEqual(antes);
    expect(salida.informe?.eventos).toEqual({});
  });

  it("la misma observación dos veces tampoco escribe la segunda vez", async () => {
    const mundo = crearMundo();
    await upcoming(mundo, anuncio(en(5)), T);
    const antes = mundo.base.foto();
    const salida = await upcoming(mundo, anuncio(en(9)), T);
    // Otra fecha en el MISMO instante es un conflicto: se reporta, no se pisa.
    expect(mundo.base.foto()).toEqual(antes);
    expect(salida.informe?.eventos).toEqual({});
    expect(salida.anunciosGuardados?.conflictos).toHaveLength(1);
  });

  it("y un anuncio más viejo que el guardado no lo toca", async () => {
    const mundo = crearMundo();
    await upcoming(mundo, anuncio(en(5)), en(1));
    const antes = mundo.base.anuncios();
    const salida = await upcoming(mundo, anuncio(en(9)), T);
    expect(mundo.base.anuncios()).toEqual(antes);
    expect(salida.anunciosGuardados).toMatchObject({ fueraDeOrden: 1 });
  });
});

describe("observación fresca con el mismo link", () => {
  it("sin opción previa: ninguna opción, un anuncio con announced_for = timestamp", async () => {
    const mundo = crearMundo();
    const salida = await upcoming(mundo, anuncio(en(5)), T);
    expect(foto(mundo.base).opciones).toEqual([]);
    expect(mundo.base.anuncios()).toMatchObject([
      { link: LINK, announcedFor: new Date(seg(en(5)) * 1000).toISOString() },
    ]);
    expect(salida.informe?.eventos).toEqual({});
  });

  it("opción real ya disponible (available_since <= ahora): ni fantasma ni pisotón", async () => {
    const mundo = crearMundo();
    await estadoDeDeltas(
      mundo,
      nuevo({ quality: "uhd", availableSince: seg(en(-3)) }),
      en(-1),
    );
    const antes = foto(mundo.base);
    const salida = await upcoming(mundo, anuncio(en(10)), T);
    expect(foto(mundo.base).opciones).toEqual(antes.opciones);
    expect(salida.informe?.eventos).toEqual({});
  });

  it("⚖️ también sin quality: no se usa quality NULL como marca de provisional", async () => {
    const mundo = crearMundo();
    await estadoDeDeltas(mundo, nuevo({ availableSince: seg(en(-3)) }), en(-1));
    const antes = foto(mundo.base);
    const salida = await upcoming(mundo, anuncio(en(10)), T);
    expect(foto(mundo.base).opciones).toEqual(antes.opciones);
    expect(foto(mundo.base).opciones[0]?.videoLink).toBe(`${LINK}/play`);
    expect(salida.informe?.eventos).toEqual({});
  });

  it("⚖️ opción futura OBSERVADA: el anuncio no desplaza su fecha; va a su tabla", async () => {
    const mundo = crearMundo();
    await estadoDeDeltas(
      mundo,
      nuevo({ quality: "hd", availableSince: seg(en(4)) }),
      en(-1),
    );
    const antes = foto(mundo.base);
    const salida = await upcoming(mundo, anuncio(en(8)), T);
    // Antes el anuncio reescribía `available_since` de la opción: ya no. La
    // opción es lo que el catálogo dijo; el anuncio, lo que dice el aviso.
    expect(foto(mundo.base)).toEqual(antes);
    expect(mundo.base.anuncios()).toMatchObject([
      { announcedFor: new Date(seg(en(8)) * 1000).toISOString() },
    ]);
    expect(salida.informe?.eventos).toEqual({});
  });
});
