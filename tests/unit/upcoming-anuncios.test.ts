/**
 * El resumen de anuncios de un recorrido de `upcoming`: función pura sobre el
 * crudo. 📏 Los recortes del Spike 1 dan la forma real; las páginas
 * sintéticas, las rarezas que el Spike no trajo.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MUESTRA_DE_SIN_ENLACE,
  resumirAnuncios,
} from "../../jobs/pipelines/upcoming/anuncios.ts";
import { respuestaCruda, showCrudo } from "./ayudas-deltas.ts";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "changes");

interface Fixture {
  readonly meta: {
    readonly ventana: { readonly from_epoch: number; readonly to_epoch: number };
  };
  readonly body: unknown;
}

const fixture = (nombre: string) =>
  JSON.parse(readFileSync(join(FIXTURES, nombre), "utf8")) as Fixture;

const PAGINA_1 = fixture("upcoming-pagina-1.json");
const PAGINA_PRIME = fixture("upcoming-prime-completa.json");
/** 📏 La ventana medida de `raw/024`. */
const VENTANA = {
  from: PAGINA_1.meta.ventana.from_epoch,
  to: PAGINA_1.meta.ventana.to_epoch,
};

const resumir = (cuerpos: readonly unknown[], completo = true) =>
  resumirAnuncios(cuerpos, { ventana: VENTANA, completo });

function aviso(
  id: string,
  timestamp: number,
  extra: { servicio?: string; link?: string | null; opciones?: string[] } = {},
) {
  const servicio = extra.servicio ?? "netflix";
  const link = extra.link === undefined ? `https://${servicio}.test/${id}` : extra.link;
  return {
    cambio: {
      changeType: "upcoming",
      showId: id,
      service: servicio,
      type: "subscription",
      ...(link === null ? {} : { link }),
      timestamp,
    },
    show: showCrudo({
      id,
      imdbId: `tt${id.padStart(7, "0")}`,
      opciones: (extra.opciones ?? []).map((s) => ({
        service: s,
        type: "subscription",
        link: `https://${s}.test/ya/${id}`,
      })),
    }),
  };
}

const pagina = (avisos: readonly ReturnType<typeof aviso>[]) =>
  respuestaCruda({
    cambios: avisos.map((a) => a.cambio),
    shows: avisos.map((a) => a.show),
  });

const DENTRO = VENTANA.from + 86_400;

describe("📏 sobre los recortes del Spike 1", () => {
  it("página 1 de raw/024: plataformas con hbo como max, un Prime sin link", () => {
    const r = resumir([PAGINA_1.body]);
    expect(r).toMatchObject({
      paginas: 1,
      completo: true,
      avisos: 8,
      porPlataforma: {
        netflix: 4,
        prime: 1,
        disney: 0,
        max: 2,
        apple: 1,
        skyshowtime: 0,
      },
      fueraDelMvp: {},
      sinShow: 0,
      repetidos: 0,
      fueraDelHorizonte: { antes: 0, despues: 0 },
      // Las ofertas de Prime que traen 1478, 5000085 y 5000088 no son las
      // anunciadas (Netflix): el anuncio no está en el catálogo.
      yaEnElCatalogo: 0,
      sinDisponibilidadEnEs: 5,
    });
    expect(r.porPlataforma).not.toHaveProperty("hbo");
    expect(r.sinEnlace.total).toBe(1);
    expect(r.sinEnlace.muestra).toEqual([
      {
        idProveedor: "5000107",
        imdbId: "tt90000053",
        plataforma: "prime",
        tipoOferta: "subscription",
        addon: null,
        instante: "2026-09-22T22:00:00.000Z",
      },
    ]);
  });

  it("con la lista de Prime detrás: 5 sin link y el anuncio repetido contado", () => {
    const r = resumir([PAGINA_1.body, PAGINA_PRIME.body]);
    expect(r.avisos).toBe(12);
    expect(r.sinEnlace.total).toBe(5);
    expect(r.sinEnlace.porPlataforma).toEqual({
      netflix: 0,
      prime: 5,
      disney: 0,
      max: 0,
      apple: 0,
      skyshowtime: 0,
    });
    expect(r.repetidos).toBe(1);
  });

  it("sin páginas confirmadas no inventa nada: todo a cero y las seis plataformas", () => {
    const r = resumir([], false);
    expect(r.completo).toBe(false);
    expect(r.avisos).toBe(0);
    expect(Object.keys(r.porPlataforma)).toEqual([
      "netflix",
      "prime",
      "disney",
      "max",
      "apple",
      "skyshowtime",
    ]);
  });
});

describe("rarezas", () => {
  it("fechas fuera de la ventana, antes y después", () => {
    const r = resumir([
      pagina([
        aviso("1", VENTANA.from - 1),
        aviso("2", DENTRO),
        aviso("3", VENTANA.to + 1),
        aviso("4", VENTANA.to),
      ]),
    ]);
    expect(r.fueraDelHorizonte).toEqual({ antes: 1, despues: 1 });
  });

  it("servicios fuera del MVP, por su id en la fuente", () => {
    const r = resumir([
      pagina([
        aviso("5", DENTRO, { servicio: "mubi" }),
        aviso("6", DENTRO, { servicio: "mubi" }),
      ]),
    ]);
    expect(r.fueraDelMvp).toEqual({ mubi: 2 });
    expect(Object.values(r.porPlataforma).every((n) => n === 0)).toBe(true);
  });

  it("una oferta anunciada que ya figura en streamingOptions.es", () => {
    const r = resumir([pagina([aviso("7", DENTRO, { opciones: ["netflix"] })])]);
    expect(r.yaEnElCatalogo).toBe(1);
    expect(r.sinDisponibilidadEnEs).toBe(0);
  });

  it("un aviso sin su show: sin show y sin imdb en la muestra", () => {
    const cuerpo = pagina([aviso("8", DENTRO, { servicio: "prime", link: null })]) as {
      shows: Record<string, unknown>;
    };
    cuerpo.shows = {};
    const r = resumir([cuerpo]);
    expect(r.sinShow).toBe(1);
    expect(r.sinEnlace.muestra[0]?.imdbId).toBeNull();
  });

  it(`la muestra de sin link se corta en ${String(MUESTRA_DE_SIN_ENLACE)}; el total, no`, () => {
    const muchos = Array.from({ length: MUESTRA_DE_SIN_ENLACE + 10 }, (_, i) =>
      aviso(String(100 + i), DENTRO, { servicio: "prime", link: null }),
    );
    const r = resumir([pagina(muchos)]);
    expect(r.sinEnlace.total).toBe(MUESTRA_DE_SIN_ENLACE + 10);
    expect(r.sinEnlace.muestra).toHaveLength(MUESTRA_DE_SIN_ENLACE);
  });

  it("un cuerpo que no es una respuesta de /changes se rechaza, no se interpreta", () => {
    expect(() => resumir([{ shows: [] }])).toThrow();
  });
});
