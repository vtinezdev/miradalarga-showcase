/**
 * El pipeline de *seed*, probado sin base de datos.
 *
 * Se divide en dos: lo que siempre corre —las funciones puras, con entradas
 * sintéticas— y lo que solo corre en local, porque `spike-1/raw/` está en
 * `.gitignore` y **el CI no lo tiene**. Un test que dependiera del crudo se
 * pondría rojo en CI por una razón que no es un defecto.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { TituloCanonico } from "../../jobs/adapters/contracts.ts";
import { construirFilas } from "../../jobs/pipelines/seed/filas.ts";
import {
  analizarUrlDeImagen,
  tipoDeImagen,
} from "../../jobs/pipelines/seed/imagenes.ts";
import type { TituloObservado } from "../../jobs/pipelines/seed/origen.ts";
import { plataformaDesdeFuente } from "../../jobs/pipelines/seed/plataformas.ts";

const OBSERVADO = new Date("2026-09-21T12:41:54.775Z");

function tituloDe(parcial: Partial<TituloCanonico> = {}): TituloObservado {
  const titulo: TituloCanonico = {
    tipo: "pelicula",
    ids: { imdbId: "tt0000001", tmdbId: "movie/1", idProveedor: "1" },
    titulo: "Prueba",
    tituloOriginal: null,
    sinopsis: null,
    valoracion: 50,
    anio: 2020,
    anioFin: null,
    duracionMinutos: 90,
    numeroTemporadas: null,
    numeroEpisodios: null,
    generos: [],
    reparto: [],
    direccion: [],
    imagenes: [],
    disponibilidad: [],
    ...parcial,
  };
  return { titulo, observadoEn: OBSERVADO, observadoPorOpcion: new Map() };
}

describe("la trampa hbo → max", () => {
  it("traduce el identificador del proveedor al nuestro", () => {
    expect(plataformaDesdeFuente("hbo")).toBe("max");
  });

  it("las otras cinco del MVP conservan su nombre", () => {
    for (const s of ["netflix", "prime", "disney", "apple", "skyshowtime"]) {
      expect(plataformaDesdeFuente(s)).toBe(s);
    }
  });

  it("una plataforma fuera del MVP no tiene traducción", () => {
    for (const s of ["mubi", "curiosity", "plutotv", "crunchyroll", "zee5", "max"]) {
      expect(plataformaDesdeFuente(s)).toBeNull();
    }
  });
});

describe("metadatos de imagen, sin descargar nada", () => {
  it("parsea la caducidad del parámetro Expires", () => {
    const m = analizarUrlDeImagen(
      "https://x.test/a/es/p.jpg?Expires=1790000000&Signature=z",
    );
    expect(m.caducaEn?.toISOString()).toBe(new Date(1790000000 * 1000).toISOString());
    expect(m.idioma).toBe("es");
    expect(m.esPlaceholder).toBe(false);
  });

  it("una URL sin Expires deja la caducidad en «no consta»", () => {
    expect(analizarUrlDeImagen("https://x.test/a/es/p.jpg").caducaEn).toBeNull();
  });

  it("reconoce el placeholder genérico del proveedor", () => {
    expect(analizarUrlDeImagen("https://x.test/media/image.svg").esPlaceholder).toBe(
      true,
    );
  });

  it("un backdrop sin segmento de idioma deja language en null", () => {
    expect(
      analizarUrlDeImagen("https://x.test/backdrops/horizontal/b.jpg").idioma,
    ).toBeNull();
  });

  it("traduce los cuatro conjuntos al enum del esquema", () => {
    expect(tipoDeImagen("poster_vertical")).toBe("vertical_poster");
    expect(tipoDeImagen("fondo_horizontal")).toBe("horizontal_backdrop");
    expect(tipoDeImagen("inventado")).toBeNull();
  });
});

describe("construcción de filas", () => {
  it("una sinopsis vacía es ausencia, no una cadena vacía", () => {
    const filas = construirFilas([tituloDe({ sinopsis: "" })]);
    expect(filas.titulos[0]?.overview).toBeNull();
  });

  it("descarta las ofertas de plataformas fuera del MVP, con motivo", () => {
    const filas = construirFilas([
      tituloDe({
        disponibilidad: [
          {
            plataformaId: "mubi",
            pais: "es",
            tipoOferta: "subscription",
            enlace: "https://mubi.test/a",
            enlaceReproduccion: null,
            calidad: null,
            precio: null,
            addon: null,
            idiomasAudio: [],
            idiomasSubtitulos: [],
            disponibleDesde: null,
            expiraEl: null,
          },
        ],
      }),
    ]);
    expect(filas.ofertas).toHaveLength(0);
    expect(filas.opciones).toHaveLength(0);
    expect(filas.descartes).toHaveLength(1);
    expect(filas.descartes[0]?.plataforma).toBe("mubi");
    expect(filas.descartes[0]?.motivo).toContain("MVP");
  });

  it("normaliza SOLO las expiraciones del año 9998, por lista exacta", () => {
    const opcion = {
      plataformaId: "netflix",
      pais: "es",
      tipoOferta: "subscription" as const,
      enlace: "https://netflix.test/a",
      enlaceReproduccion: null,
      calidad: null,
      precio: null,
      addon: null,
      idiomasAudio: [],
      idiomasSubtitulos: [],
      disponibleDesde: null,
    };
    const centinela = construirFilas([
      tituloDe({
        disponibilidad: [{ ...opcion, expiraEl: new Date(253368063900 * 1000) }],
      }),
    ]);
    expect(centinela.opciones[0]?.expiresAt).toBeNull();
    expect(centinela.expiracionesNormalizadas).toBe(1);

    // El grupo 2099–2106 NO se toca: son fechas bien formadas, y declararlas
    // falsas exigiría un umbral.
    const lejana = new Date(4102441140 * 1000);
    const conservada = construirFilas([
      tituloDe({ disponibilidad: [{ ...opcion, expiraEl: lejana }] }),
    ]);
    expect(conservada.opciones[0]?.expiresAt).toEqual(lejana);
    expect(conservada.expiracionesNormalizadas).toBe(0);
  });

  it("detecta el colapso de dos opciones con la misma clave natural", () => {
    const base = {
      plataformaId: "netflix",
      pais: "es",
      tipoOferta: "subscription" as const,
      enlace: "https://netflix.test/mismo",
      enlaceReproduccion: null,
      calidad: null,
      addon: null,
      idiomasAudio: [],
      idiomasSubtitulos: [],
      disponibleDesde: null,
      expiraEl: null,
    };
    const filas = construirFilas([
      tituloDe({
        disponibilidad: [
          { ...base, precio: { importe: "5.99", moneda: "EUR" } },
          { ...base, precio: { importe: "6.99", moneda: "EUR" } },
        ],
      }),
    ]);
    // Mismo (oferta, link, quality): la segunda no se pierde en silencio.
    expect(filas.opciones).toHaveLength(1);
    expect(filas.colapsos).toHaveLength(1);
    expect(filas.colapsos[0]?.tabla).toBe("external_availability_options");
  });
});

// ── Solo en local: el crudo del Spike 1 no está versionado ─────────────────
const RAIZ_SPIKE = join(import.meta.dirname, "..", "..", "spike-1");
const hayCrudo = existsSync(join(RAIZ_SPIKE, "raw"));

describe.skipIf(!hayCrudo)("el corpus real del Spike 1 encaja en el modelo v1", () => {
  it("reproduce los recuentos medidos", async () => {
    const { leerCorpusSpike1 } = await import("../../jobs/pipelines/seed/origen.ts");
    const corpus = leerCorpusSpike1(RAIZ_SPIKE);
    expect(corpus.diagnostico.titulosUnicos).toBe(764);
    expect(corpus.diagnostico.opcionesEs).toBe(2239);
    expect(corpus.diagnostico.showsRechazadosPorSchema).toBe(0);

    const filas = construirFilas(corpus.titulos);
    expect(filas.generos).toHaveLength(21);
    expect(filas.titulos).toHaveLength(764);
    expect(filas.titulosGeneros).toHaveLength(1633);
    expect(filas.imagenes).toHaveLength(13515);
    expect(filas.ofertas).toHaveLength(1837);
    expect(filas.opciones).toHaveLength(2218);
    expect(filas.descartes).toHaveLength(21);
    expect(filas.colapsos).toHaveLength(0);

    // Ninguna opción se evapora.
    expect(filas.opciones.length + filas.descartes.length).toBe(2239);
    // Ningún rating 0 sobrevive al adaptador.
    expect(filas.titulos.filter((t) => t.rating === 0)).toHaveLength(0);
    // El addon va por id (ADR 0005): 27 ids, no 25 nombres.
    const addons = new Set(filas.ofertas.map((o) => o.addon).filter((a) => a !== null));
    expect(addons.size).toBe(27);
  });
});
