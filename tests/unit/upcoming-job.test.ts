/**
 * El job de `upcoming` en modo REAL (`vincularEventos: true`), **sin red y sin
 * base de datos**: el libro y la base en memoria, como en `expiring-job.test.ts`.
 *
 * Dos fuentes de datos:
 *
 *   · 📏 **Recortes del Spike 1** (`tests/fixtures/changes/upcoming-*.json`, de
 *     `raw/024`, `raw/032` y `raw/036`): la forma real de
 *     `/changes?change_type=upcoming`, con los anuncios de Prime **sin `link`**.
 *   · Páginas sintéticas para lo que el Spike no capturó: cortes de tope,
 *     duplicados, fechas fuera de la ventana y anuncios que desaparecen.
 *
 * Desde el ADR 0007 cada anuncio es una fila de
 * `external_availability_announcements`, nunca una opción: lo que se mira
 * aquí es `base.anuncios()`. La persistencia en detalle —ciclos, conflictos,
 * `last_seen_run_id`— está en `upcoming-persistencia.test.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { crearLibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import type { LibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import {
  TOPE_POR_EJECUCION_POR_DEFECTO,
  leerPresupuesto,
} from "../../jobs/ops/presupuesto.ts";
import type { FuenteDeCuota, Transporte } from "../../jobs/ops/transporte.ts";
import { transaccionPorPagina } from "../../jobs/pipelines/deltas/job.ts";
import { ventanaEnSegundos } from "../../jobs/pipelines/deltas/manifiesto.ts";
import {
  CATALOGOS_MVP,
  ventanaHaciaDelante,
} from "../../jobs/pipelines/deltas/origen.ts";
import { claveDeOferta } from "../../jobs/pipelines/seed/filas.ts";
import { planificarUpcoming } from "../../jobs/pipelines/upcoming/checkpoint.ts";
import { ejecutarJobDeUpcoming } from "../../jobs/pipelines/upcoming/job.ts";
import { PIPELINES_REGISTRADOS } from "../../jobs/registro.ts";
import { conexionDeDatos } from "./ayudas-checkpoint.ts";
import { respuestaCruda, showCrudo } from "./ayudas-deltas.ts";
import type { BaseEnMemoria } from "./base-en-memoria.ts";
import { crearBaseEnMemoria } from "./base-en-memoria.ts";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "changes");
const DIA = 86_400_000;

const CUOTA = {
  "x-quota-used": "120",
  "x-quota-granted": "1000",
  "x-quota-reset": "2026-10-01T00:00:00Z",
};

interface AvisoDelFixture {
  readonly showId: string;
  readonly service: { readonly id: string };
  readonly streamingOptionType: string;
  readonly addon?: { readonly id: string };
  readonly link?: string;
  readonly timestamp: number;
}

interface Fixture {
  readonly meta: { readonly ts_utc: string };
  readonly body: {
    readonly changes: readonly AvisoDelFixture[];
    readonly shows: Readonly<Record<string, { readonly imdbId: string }>>;
    readonly hasMore: boolean;
    readonly nextCursor?: string;
  };
}

function fixture(nombre: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURES, nombre), "utf8")) as Fixture;
}

const PAGINA_1 = fixture("upcoming-pagina-1.json");
const PAGINA_PRIME = fixture("upcoming-prime-completa.json");
const SKYSHOWTIME = fixture("upcoming-skyshowtime-vacia.json");
/** El instante de la captura de `raw/024`: el `ahora` del recorrido medido. */
const T_SPIKE = new Date(PAGINA_1.meta.ts_utc);

const T = new Date("2026-09-24T10:00:00.000Z");
const en = (dias: number, desde = T) => new Date(desde.getTime() + dias * DIA);
const seg = (d: Date) => Math.floor(d.getTime() / 1000);

// ── Dobles ───────────────────────────────────────────────────────────────────

type Listas = ReadonlyMap<string, unknown>;

/** Sirve por `(change_type, cursor)`, pasando por la fuente de cuota como el real. */
function servidor(listas: Listas) {
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

const crearMundo = (): Mundo => ({
  libro: crearLibroEnMemoria(),
  base: crearBaseEnMemoria(),
});

async function ejecutar(
  mundo: Mundo,
  entrada: {
    readonly listas: Listas;
    readonly ahora?: Date;
    /** `null` = el presupuesto del repositorio, sin inyectar nada. */
    readonly tope?: number | null;
  },
) {
  const datos = conexionDeDatos(mundo.base, mundo.libro);
  const red = servidor(entrada.listas);
  const tope = entrada.tope === undefined ? 12 : entrada.tope;
  const salida = await ejecutarJobDeUpcoming({
    // El destino histórico, declarado: el régimen por defecto es el estricto.
    regimen: "historico",
    ejecutorOps: mundo.libro.ejecutor,
    ejecutorDatos: datos.ejecutor,
    transaccion: transaccionPorPagina(datos.ejecutor),
    presupuesto: leerPresupuesto(
      tope === null ? {} : { STREAMING_API_PER_RUN_CAPS: `upcoming=${String(tope)}` },
    ),
    crearLlamada: red.crear,
    apiKey: "k",
    plan: { origen: "persistente" },
    ahora: entrada.ahora ?? T,
    crearRegistro: null,
    vincularEventos: true,
  });
  const runId = salida.resultado.ejecutado ? salida.resultado.runId : -1;
  const fila = mundo.libro.filas.find((f) => f.id === runId);
  return { salida, red, fila };
}

const estado = (s: { resultado: { ejecutado: boolean } }) => {
  const r = s.resultado as { ejecutado: boolean; estado?: string };
  return r.ejecutado ? r.estado : "no_ejecutado";
};

/** Un aviso `upcoming` sintético con su show. `link: null` = sin enlace. */
function anuncio(entrada: {
  readonly id: string;
  readonly estreno: Date;
  readonly servicio?: string;
  readonly link?: string | null;
}) {
  const servicio = entrada.servicio ?? "netflix";
  const link =
    entrada.link === undefined
      ? `https://${servicio}.test/${entrada.id}`
      : entrada.link;
  return {
    cambio: {
      changeType: "upcoming",
      showId: entrada.id,
      service: servicio,
      type: "subscription",
      ...(link === null ? {} : { link }),
      timestamp: seg(entrada.estreno),
    },
    // 📏 El caso normal: el show anunciado todavía no tiene opciones en ES.
    show: showCrudo({ id: entrada.id, imdbId: imdb(entrada.id), opciones: [] }),
  };
}

const imdb = (id: string) => `tt${id.padStart(7, "0")}`;

function paginaDe(
  avisos: readonly ReturnType<typeof anuncio>[],
  nextCursor?: string,
): Record<string, unknown> {
  return respuestaCruda({
    cambios: avisos.map((a) => a.cambio),
    shows: avisos.map((a) => a.show),
    hasMore: nextCursor !== undefined,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  });
}

const soloPagina = (avisos: readonly ReturnType<typeof anuncio>[]): Listas =>
  new Map([["upcoming|", paginaDe(avisos)]]);

interface Foto {
  titulos: string[];
  ofertas: { oferta: string }[];
  opciones: {
    oferta: string;
    link: string;
    quality: string | null;
    missingStreak: number;
    availableSince: string | null;
  }[];
  eventos: { oferta: string; tipo: string }[];
}

const foto = (base: BaseEnMemoria) => base.foto() as Foto;

/** La clave natural de una oferta sintética de Netflix. */
const clave = (id: string, plataforma = "netflix") =>
  claveDeOferta(imdb(id), plataforma, "subscription", null);

// ── 0 · El presupuesto del repositorio ───────────────────────────────────────

describe("upcoming con el presupuesto del repositorio (2026-09-24)", () => {
  it("su tope es 8 y está registrado en `pnpm job`", () => {
    expect(TOPE_POR_EJECUCION_POR_DEFECTO.upcoming).toBe(8);
    expect(Object.keys(PIPELINES_REGISTRADOS)).toContain("upcoming");
  });

  it("sin tope inyectado, el del repositorio: la 9.ª página no se pide", async () => {
    const nueve: Listas = new Map(
      Array.from({ length: 9 }, (_, i) => [
        `upcoming|${i === 0 ? "" : `c${String(i)}`}`,
        paginaDe(
          [anuncio({ id: String(900 + i), estreno: en(2 + i) })],
          i < 8 ? `c${String(i + 1)}` : undefined,
        ),
      ]),
    );
    const { salida, red, fila } = await ejecutar(crearMundo(), {
      listas: nueve,
      tope: null,
    });
    expect(estado(salida)).toBe("budget_stopped");
    expect(red.urls).toHaveLength(8);
    expect(fila?.requestsMade).toBe(8);
    expect(salida.horizonte?.desaparecidas).toBeNull();
  });
});

// ── 1 · Recorrido completo sobre los recortes del Spike 1 ───────────────────

describe("recorrido completo con los recortes del Spike 1", () => {
  const listas: Listas = new Map<string, unknown>([
    ["upcoming|", PAGINA_1.body],
    [`upcoming|${PAGINA_1.body.nextCursor ?? "?"}`, PAGINA_PRIME.body],
  ]);

  it("dos páginas, dos requests, succeeded y horizonte completo", async () => {
    const mundo = crearMundo();
    const { salida, fila } = await ejecutar(mundo, { listas, ahora: T_SPIKE });

    expect(estado(salida)).toBe("succeeded");
    expect(salida.contadores.reservasConcedidas).toBe(2);
    expect(fila?.pipeline).toBe("upcoming");
    expect(fila?.requestsMade).toBe(2);
    expect(salida.checkpoint).toMatchObject({
      tipos: ["upcoming"],
      pendiente: null,
      paginasConfirmadas: 2,
      reanudaDe: null,
    });
    expect(fila?.checkpoint).toEqual(salida.checkpoint);
    expect(salida.horizonte?.completo).toBe(true);
    expect(salida.horizonte?.desaparecidas).toBe(0);
    expect(salida.anuncios).toMatchObject({ paginas: 2, completo: true, avisos: 12 });
  });

  it("la query es la medida: upcoming, 31 días hacia delante, sin fechas desconocidas", async () => {
    const { red } = await ejecutar(crearMundo(), { listas, ahora: T_SPIKE });
    const v = ventanaEnSegundos(ventanaHaciaDelante(T_SPIKE, 31));
    for (const u of red.urls) {
      expect(u.searchParams.get("change_type")).toBe("upcoming");
      expect(u.searchParams.get("include_unknown_dates")).toBe("false");
      expect(u.searchParams.get("from")).toBe(String(v.from));
      expect(u.searchParams.get("to")).toBe(String(v.to));
      // Las seis del MVP, con `hbo` —el id de la fuente—, SkyShowtime incluida.
      expect(u.searchParams.get("catalogs")).toBe(CATALOGOS_MVP);
    }
    expect(red.urls[0]?.searchParams.get("cursor")).toBeNull();
    expect(red.urls[1]?.searchParams.get("cursor")).toBe(PAGINA_1.body.nextCursor);
  });

  it("cada anuncio queda en su tabla con la fecha del aviso, y ninguno como opción", async () => {
    const mundo = crearMundo();
    await ejecutar(mundo, { listas, ahora: T_SPIKE });
    const anuncios = mundo.base.anuncios();
    const opciones = foto(mundo.base).opciones;
    for (const a of PAGINA_1.body.changes) {
      const imdbId = PAGINA_1.body.shows[a.showId]?.imdbId;
      const plataforma = a.service.id === "hbo" ? "max" : a.service.id;
      const guardado = anuncios.find(
        (x) => x.imdbId === imdbId && x.platformId === plataforma,
      );
      expect(guardado, `sin anuncio para ${a.showId}`).toBeDefined();
      expect(guardado?.announcedFor).toBe(new Date(a.timestamp * 1000).toISOString());
      expect(guardado?.link).toBe(a.link ?? null);
      // El link anunciado no aparece como opción sintética.
      if (a.link !== undefined) {
        expect(
          opciones.filter((o) => o.link === a.link && o.quality === null),
          a.showId,
        ).toEqual([]);
      }
    }
    // 12 avisos, uno repetido entre páginas (5000107): 11 anuncios.
    expect(anuncios).toHaveLength(11);
  });

  it("📏 hbo se guarda como max, nunca como hbo", async () => {
    const mundo = crearMundo();
    const { salida } = await ejecutar(mundo, { listas, ahora: T_SPIKE });
    const plataformas = mundo.base.anuncios().map((a) => a.platformId);
    expect(plataformas.filter((p) => p === "max")).toHaveLength(2);
    expect(plataformas).not.toContain("hbo");
    expect(foto(mundo.base).ofertas.some((o) => o.oferta.includes("|hbo|"))).toBe(
      false,
    );
    expect(salida.anuncios?.porPlataforma).toEqual({
      netflix: 4,
      prime: 5,
      disney: 0,
      max: 2,
      apple: 1,
      skyshowtime: 0,
    });
  });

  it("⚖️ sobre una base vacía, ni un evento: los anuncios van a su tabla", async () => {
    const mundo = crearMundo();
    const { salida } = await ejecutar(mundo, { listas, ahora: T_SPIKE });
    // Antes: 7 `announced`, uno por anuncio con link. Un anuncio no es un
    // cambio de disponibilidad (ADR 0007).
    expect(salida.informe?.eventos).toEqual({});
    expect(foto(mundo.base).eventos).toEqual([]);
    // 📏 Las ofertas de Prime que ya listaban 1478, 5000085 y 5000088 no las
    // anuncia nadie: son línea base, sin evento.
    expect(salida.informe?.ofertasDeLineaBase).toBeGreaterThan(0);
  });

  it("repetir el recorrido con el mismo ahora no cambia nada", async () => {
    const mundo = crearMundo();
    await ejecutar(mundo, { listas, ahora: T_SPIKE });
    const antes = mundo.base.foto();
    const { salida } = await ejecutar(mundo, { listas, ahora: T_SPIKE });
    expect(estado(salida)).toBe("succeeded");
    expect(salida.informe?.eventos).toEqual({});
    expect(mundo.base.foto()).toEqual(antes);
  });

  it("y un recorrido posterior con los mismos anuncios tampoco emite nada", async () => {
    const mundo = crearMundo();
    await ejecutar(mundo, { listas, ahora: T_SPIKE });
    const antes = mundo.base.foto({ instantes: false });
    const { salida } = await ejecutar(mundo, { listas, ahora: en(1, T_SPIKE) });
    expect(salida.informe?.eventos).toEqual({});
    expect(mundo.base.foto({ instantes: false })).toEqual(antes);
    expect(salida.horizonte?.desaparecidas).toBe(0);
  });
});

// ── 2 · Anuncios sin link ────────────────────────────────────────────────────

describe("📏 anuncios sin link: Prime, 4 de 4 en raw/032", () => {
  const listas: Listas = new Map([["upcoming|", PAGINA_PRIME.body]]);

  it("guarda el título: su identidad es un dato real", async () => {
    const mundo = crearMundo();
    await ejecutar(mundo, { listas, ahora: T_SPIKE });
    const esperados = PAGINA_PRIME.body.changes
      .map((a) => PAGINA_PRIME.body.shows[a.showId]?.imdbId ?? "?")
      .sort();
    expect(foto(mundo.base).titulos).toEqual(esperados);
  });

  it("no inventa enlace ni crea una oferta padre vacía, que leería como `gone`", async () => {
    const mundo = crearMundo();
    const { salida } = await ejecutar(mundo, { listas, ahora: T_SPIKE });
    expect(foto(mundo.base).ofertas).toEqual([]);
    expect(foto(mundo.base).opciones).toEqual([]);
    expect(salida.informe?.eventosEscritos).toBe(0);
  });

  it("⚖️ se guardan los 4: anuncio con link NULL, sin descarte, y detalle en el resumen", async () => {
    const mundo = crearMundo();
    const { salida } = await ejecutar(mundo, { listas, ahora: T_SPIKE });
    expect(salida.informe?.descartes).toEqual([]);
    expect(mundo.base.anuncios()).toHaveLength(4);
    expect(
      mundo.base.anuncios().every((a) => a.platformId === "prime" && a.link === null),
    ).toBe(true);
    expect(salida.anunciosGuardados).toMatchObject({ nuevos: 4, sinEnlace: 4 });
    expect(salida.anuncios?.sinEnlace.total).toBe(4);
    expect(salida.anuncios?.sinEnlace.porPlataforma.prime).toBe(4);
    expect(salida.anuncios?.sinDisponibilidadEnEs).toBe(4);
    expect(salida.anuncios?.sinEnlace.muestra).toEqual(
      PAGINA_PRIME.body.changes.map((a) => ({
        idProveedor: a.showId,
        imdbId: PAGINA_PRIME.body.shows[a.showId]?.imdbId,
        plataforma: "prime",
        tipoOferta: "subscription",
        addon: null,
        instante: new Date(a.timestamp * 1000).toISOString(),
      })),
    );
  });

  it("con link en una página y sin él en otra de la MISMA ejecución: se queda el link, sin conflicto", async () => {
    const conLink = anuncio({ id: "7", estreno: en(4), servicio: "prime" });
    const sinLink = anuncio({ id: "7", estreno: en(4), servicio: "prime", link: null });
    // En los dos órdenes: el resultado no depende de la paginación.
    for (const [p1, p2] of [
      [conLink, sinLink],
      [sinLink, conLink],
    ] as const) {
      const mundo = crearMundo();
      const { salida } = await ejecutar(mundo, {
        listas: new Map([
          ["upcoming|", paginaDe([p1], "c1")],
          ["upcoming|c1", paginaDe([p2])],
        ]),
      });
      expect(mundo.base.anuncios()).toMatchObject([{ link: "https://prime.test/7" }]);
      expect(salida.anunciosGuardados?.conflictos).toEqual([]);
    }
  });
});

// ── 3 · Rarezas que se procesan sin perder nada ──────────────────────────────

describe("duplicados, fechas fuera de la ventana, campos opcionales y servicios", () => {
  it("el mismo anuncio repetido en una página deja UN anuncio, sin opción ni evento", async () => {
    const mundo = crearMundo();
    const a = anuncio({ id: "10", estreno: en(5) });
    const { salida } = await ejecutar(mundo, { listas: soloPagina([a, a]) });
    expect(mundo.base.anuncios()).toHaveLength(1);
    expect(foto(mundo.base).opciones).toEqual([]);
    expect(salida.informe?.eventos).toEqual({});
    expect(salida.anuncios?.repetidos).toBe(1);
    expect(salida.anunciosGuardados).toMatchObject({ nuevos: 1, mismaObservacion: 1 });
  });

  it("repetido entre dos páginas: la segunda es la misma observación", async () => {
    const mundo = crearMundo();
    const a = anuncio({ id: "11", estreno: en(5) });
    const { salida } = await ejecutar(mundo, {
      listas: new Map([
        ["upcoming|", paginaDe([a], "c1")],
        ["upcoming|c1", paginaDe([a])],
      ]),
    });
    expect(estado(salida)).toBe("succeeded");
    expect(mundo.base.anuncios()).toHaveLength(1);
    expect(salida.informe?.eventos).toEqual({});
    expect(salida.anunciosGuardados).toMatchObject({ nuevos: 1, mismaObservacion: 1 });
    expect(salida.anuncios?.repetidos).toBe(1);
  });

  it("📏 el Spike ya lo trae: 5000107 está en raw/024 y en raw/032", async () => {
    const { salida } = await ejecutar(crearMundo(), {
      listas: new Map<string, unknown>([
        ["upcoming|", PAGINA_1.body],
        [`upcoming|${PAGINA_1.body.nextCursor ?? "?"}`, PAGINA_PRIME.body],
      ]),
      ahora: T_SPIKE,
    });
    expect(salida.anuncios?.repetidos).toBe(1);
    expect(salida.anuncios?.sinEnlace.total).toBe(5);
  });

  it("un estreno más allá de `to` se guarda con su fecha y se cuenta como fuera", async () => {
    const mundo = crearMundo();
    const lejos = en(45);
    const { salida } = await ejecutar(mundo, {
      listas: soloPagina([anuncio({ id: "12", estreno: lejos })]),
    });
    expect(mundo.base.anuncios()[0]?.announcedFor).toBe(
      new Date(seg(lejos) * 1000).toISOString(),
    );
    expect(salida.informe?.eventos).toEqual({});
    expect(salida.anuncios?.fueraDelHorizonte).toEqual({ antes: 0, despues: 1 });
  });

  it("uno anterior a `from` se guarda igual y se cuenta: no se reinterpreta", async () => {
    const mundo = crearMundo();
    const pasado = en(-2);
    const { salida } = await ejecutar(mundo, {
      listas: soloPagina([anuncio({ id: "13", estreno: pasado })]),
    });
    expect(mundo.base.anuncios()[0]?.announcedFor).toBe(
      new Date(seg(pasado) * 1000).toISOString(),
    );
    // Antes se sintetizaba una opción ya «disponible» por su fecha y salía un
    // `added`. Ahora es un anuncio con fecha pasada: qué significa lo decide
    // quien lo lea. Se cuenta para que la rareza se vea.
    expect(salida.informe?.eventos).toEqual({});
    expect(foto(mundo.base).opciones).toEqual([]);
    expect(salida.anuncios?.fueraDelHorizonte).toEqual({ antes: 1, despues: 0 });
  });

  it("un show sin streamingOptions, sinopsis, géneros ni reparto y un aviso sin addon", async () => {
    const mundo = crearMundo();
    const minimo = {
      changes: [
        {
          changeType: "upcoming",
          itemType: "show",
          showId: "14",
          showType: "series",
          service: { id: "apple", name: "Apple TV" },
          streamingOptionType: "subscription",
          link: "https://apple.test/14",
          timestamp: seg(en(6)),
        },
      ],
      shows: {
        "14": {
          itemType: "show",
          showType: "series",
          id: "14",
          imdbId: imdb("14"),
          title: "Solo lo imprescindible",
        },
      },
      hasMore: false,
    };
    const { salida } = await ejecutar(mundo, {
      listas: new Map([["upcoming|", minimo]]),
    });
    expect(estado(salida)).toBe("succeeded");
    expect(salida.informe?.eventos).toEqual({});
    expect(mundo.base.anuncios()).toMatchObject([
      {
        platformId: "apple",
        offerType: "subscription",
        addon: null,
        link: "https://apple.test/14",
      },
    ]);
    expect(salida.anuncios?.sinDisponibilidadEnEs).toBe(1);
  });

  it("un servicio fuera del MVP se cuenta, pero no entra en el catálogo", async () => {
    const mundo = crearMundo();
    const { salida } = await ejecutar(mundo, {
      listas: soloPagina([anuncio({ id: "15", estreno: en(3), servicio: "mubi" })]),
    });
    expect(foto(mundo.base).ofertas).toEqual([]);
    expect(mundo.base.anuncios()).toEqual([]);
    expect(salida.anuncios?.fueraDelMvp).toEqual({ mubi: 1 });
  });

  it("⚖️ si algún día llega un anuncio de SkyShowtime, se procesa: no se extrapola", async () => {
    const mundo = crearMundo();
    const { salida } = await ejecutar(mundo, {
      listas: soloPagina([
        anuncio({ id: "16", estreno: en(3), servicio: "skyshowtime" }),
      ]),
    });
    expect(salida.informe?.eventos).toEqual({});
    expect(mundo.base.anuncios().map((a) => a.platformId)).toEqual(["skyshowtime"]);
    expect(salida.anuncios?.porPlataforma.skyshowtime).toBe(1);
  });

  it("📏 la lista vacía de SkyShowtime (raw/036) es un recorrido completo sin nada", async () => {
    const { salida } = await ejecutar(crearMundo(), {
      listas: new Map([["upcoming|", SKYSHOWTIME.body]]),
      ahora: T_SPIKE,
    });
    expect(estado(salida)).toBe("succeeded");
    expect(salida.horizonte).toEqual({
      completo: true,
      desaparecidas: 0,
      muestra: [],
      fueraDeCobertura: 0,
    });
    expect(salida.anuncios?.avisos).toBe(0);
  });
});

// ── 4 · Las desapariciones ───────────────────────────────────────────────────

describe("los anuncios que desaparecen solo se miden con el recorrido completo", () => {
  async function conocidas(mundo: Mundo) {
    await ejecutar(mundo, {
      listas: soloPagina([
        anuncio({ id: "20", estreno: en(10) }),
        anuncio({ id: "21", estreno: en(12) }),
        anuncio({ id: "22", estreno: en(14), servicio: "skyshowtime" }),
      ]),
    });
  }

  it("completo: cuenta la que ya no aparece, y SkyShowtime va aparte", async () => {
    const mundo = crearMundo();
    await conocidas(mundo);
    const antes = mundo.base.anuncios();

    const { salida } = await ejecutar(mundo, {
      listas: soloPagina([anuncio({ id: "20", estreno: en(10) })]),
      ahora: en(1),
    });
    expect(salida.horizonte).toEqual({
      completo: true,
      desaparecidas: 1,
      muestra: [clave("21")],
      fueraDeCobertura: 1,
    });
    // Medir no es actuar: ni borrado, ni marca, ni evento.
    const sinCambios = (imdbId: string) =>
      expect(mundo.base.anuncios().find((a) => a.imdbId === imdbId)).toEqual(
        antes.find((a) => a.imdbId === imdbId),
      );
    sinCambios(imdb("21"));
    sinCambios(imdb("22"));
    expect(salida.informe?.eventos).toEqual({});
    expect(salida.informe?.opcionesMarcadasAusentes).toBe(0);
  });

  it("ninguna ausencia se interpreta, aunque se repita en varios recorridos", async () => {
    const mundo = crearMundo();
    await conocidas(mundo);
    const antes = mundo.base.sentencias.length;
    for (const dia of [1, 2, 3]) {
      await ejecutar(mundo, {
        listas: soloPagina([anuncio({ id: "20", estreno: en(10) })]),
        ahora: en(dia),
      });
    }
    const anuncio21 = mundo.base.anuncios().find((a) => a.imdbId === imdb("21"));
    expect(anuncio21).toMatchObject({
      announcedFor: new Date(seg(en(12)) * 1000).toISOString(),
      lastSeenAt: T.toISOString(),
    });
    const posteriores = mundo.base.sentencias.slice(antes);
    expect(posteriores.some((s) => s.startsWith("DELETE"))).toBe(false);
    expect(posteriores.some((s) => s.includes("SET missing_streak = $2"))).toBe(false);
  });

  it("una opción ACTUAL que falta en el snapshot de un título anunciado no sube su racha", async () => {
    // Sin la protección de las opciones futuras: la de Netflix ya está
    // disponible. Solo `interpretarAusencias: false` la mantiene a cero.
    const conCatalogo = (link: string) => ({
      cambio: anuncio({ id: "24", estreno: en(8), servicio: "prime" }).cambio,
      show: showCrudo({
        id: "24",
        imdbId: imdb("24"),
        opciones: [
          {
            service: "netflix",
            type: "subscription",
            link,
            quality: "hd",
            availableSince: seg(en(-30)),
          },
        ],
      }),
    });
    const mundo = crearMundo();
    await ejecutar(mundo, {
      listas: soloPagina([conCatalogo("https://netflix.test/24-a")]),
    });
    await ejecutar(mundo, {
      listas: soloPagina([conCatalogo("https://netflix.test/24-b")]),
      ahora: en(1),
    });
    expect(mundo.base.opcion("https://netflix.test/24-a")?.missingStreak).toBe(0);
    expect(mundo.base.opcion("https://netflix.test/24-b")?.missingStreak).toBe(0);
  });

  it("incompleto (corte de tope con hasMore): desaparecidas = null, no cero", async () => {
    const mundo = crearMundo();
    await conocidas(mundo);
    const { salida, red } = await ejecutar(mundo, {
      tope: 1,
      ahora: en(1),
      listas: new Map([
        ["upcoming|", paginaDe([anuncio({ id: "20", estreno: en(10) })], "c1")],
        ["upcoming|c1", paginaDe([anuncio({ id: "21", estreno: en(12) })])],
      ]),
    });
    expect(estado(salida)).toBe("budget_stopped");
    expect(red.urls).toHaveLength(1);
    expect(salida.checkpoint?.pendiente).toEqual({
      changeType: "upcoming",
      cursorDeEntrada: "c1",
    });
    expect(salida.horizonte).toEqual({
      completo: false,
      desaparecidas: null,
      muestra: [],
      fueraDeCobertura: null,
    });
    expect(salida.anuncios).toMatchObject({ completo: false, paginas: 1, avisos: 1 });
  });

  it("un aviso sin su show impide atribuir: desaparecidas = null", async () => {
    const mundo = crearMundo();
    await conocidas(mundo);
    const huerfano = paginaDe([anuncio({ id: "20", estreno: en(10) })]) as {
      changes: unknown[];
    };
    huerfano.changes.push({
      ...(anuncio({ id: "99", estreno: en(11) }).cambio as object),
      itemType: "show",
      showType: "movie",
      service: { id: "netflix", name: "netflix" },
      streamingOptionType: "subscription",
    });
    const { salida } = await ejecutar(mundo, {
      listas: new Map([["upcoming|", huerfano]]),
      ahora: en(1),
    });
    expect(salida.informe?.avisosSinShow).toBe(1);
    expect(salida.horizonte).toMatchObject({ completo: true, desaparecidas: null });
    expect(salida.anuncios?.sinShow).toBe(1);
  });

  it("un show con imdbId vacío es un aviso sin show: sin anuncio, con error y sin vigencia", async () => {
    const mundo = crearMundo();
    await conocidas(mundo);
    const vacio = anuncio({ id: "98", estreno: en(11) });
    const pagina = paginaDe([
      anuncio({ id: "20", estreno: en(10) }),
      { ...vacio, show: { ...vacio.show, imdbId: "" } },
    ]);
    const antes = foto(mundo.base).titulos;
    const { salida, fila } = await ejecutar(mundo, {
      listas: new Map([["upcoming|", pagina]]),
      ahora: en(1),
    });
    expect(estado(salida)).toBe("succeeded");
    expect(salida.informe?.avisosSinShow).toBe(1);
    expect(salida.informe?.avisosSinIdentidad).toBe(1);
    // La misma consecuencia que un aviso sin show: no sirve de referencia de
    // la vigencia, y la muestra dice por qué.
    expect(salida.horizonte).toMatchObject({ completo: true, desaparecidas: null });
    expect(fila?.errorSamples).toEqual([
      { motivo: "avisos_sin_show", avisos: 1, sinIdentidad: 1 },
    ]);
    expect(salida.anuncios?.sinShow).toBe(1);
    // Ni título vacío ni anuncio colgado de él.
    expect(foto(mundo.base).titulos).toEqual(antes);
    expect(foto(mundo.base).titulos).not.toContain("");
    expect(mundo.base.anuncios().map((a) => a.imdbId)).not.toContain("");
  });

  it("un aplazamiento dentro del horizonte mueve la fecha del anuncio: ni baja ni evento", async () => {
    const mundo = crearMundo();
    await ejecutar(mundo, {
      listas: soloPagina([anuncio({ id: "23", estreno: en(10) })]),
    });
    const { salida } = await ejecutar(mundo, {
      listas: soloPagina([anuncio({ id: "23", estreno: en(15) })]),
      ahora: en(1),
    });
    expect(salida.informe?.eventos).toEqual({});
    expect(mundo.base.anuncios()).toMatchObject([
      {
        announcedFor: new Date(seg(en(15)) * 1000).toISOString(),
        firstAnnouncedFor: new Date(seg(en(10)) * 1000).toISOString(),
      },
    ]);
    expect(salida.horizonte?.desaparecidas).toBe(0);
  });
});

// ── 5 · Cada recorrido empieza por su primera página ─────────────────────────

describe("el siguiente recorrido empieza desde la página 1", () => {
  const tres: Listas = new Map([
    ["upcoming|", paginaDe([anuncio({ id: "30", estreno: en(2) })], "c1")],
    ["upcoming|c1", paginaDe([anuncio({ id: "31", estreno: en(9) })], "c2")],
    ["upcoming|c2", paginaDe([anuncio({ id: "32", estreno: en(20) })])],
  ]);

  it("tras un corte, no continúa el cursor: pide la primera página sin cursor", async () => {
    const mundo = crearMundo();
    const corte = await ejecutar(mundo, { listas: tres, tope: 2 });
    expect(estado(corte.salida)).toBe("budget_stopped");
    expect(corte.salida.checkpoint?.pendiente?.cursorDeEntrada).toBe("c2");

    const { salida, red } = await ejecutar(mundo, { listas: tres, ahora: en(1) });
    expect(red.urls.map((u) => u.searchParams.get("cursor"))).toEqual([
      null,
      "c1",
      "c2",
    ]);
    expect(salida.checkpoint?.reanudaDe).toBeNull();
    expect(salida.checkpoint?.ventana).toEqual(planificarUpcoming(en(1)).ventana);
    expect(estado(salida)).toBe("succeeded");
    expect(salida.horizonte?.completo).toBe(true);
  });

  it("corte + recorrido nuevo deja el mismo catálogo que un recorrido limpio", async () => {
    const limpio = crearMundo();
    await ejecutar(limpio, { listas: tres });

    const cortado = crearMundo();
    await ejecutar(cortado, { listas: tres, tope: 1 });
    await ejecutar(cortado, { listas: tres });

    // Sin instantes: el run que vio cada anuncio es otro en cada mundo.
    expect(cortado.base.foto({ instantes: false })).toEqual(
      limpio.base.foto({ instantes: false }),
    );
    expect(cortado.base.anuncios().map((a) => a.lastSeenAt)).toEqual(
      limpio.base.anuncios().map((a) => a.lastSeenAt),
    );
  });
});
