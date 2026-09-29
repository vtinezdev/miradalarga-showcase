/**
 * Del modelo canónico a las filas del esquema v1.
 *
 * Aquí ocurre la traducción español → inglés que `docs/DATA-MODEL.md` sitúa en
 * la frontera de `src/db/schema/`, y **aquí se decide qué NO se carga**. Todo
 * descarte sale nombrado y contado: una opción del corpus tiene que acabar o en
 * una fila o en la lista de descartes, nunca evaporada.
 */
import type { TipoTitulo } from "../../adapters/contracts.ts";
import type { Descarte } from "./contratos.ts";
import { analizarUrlDeImagen, tipoDeImagen } from "./imagenes.ts";
import { plataformaDesdeFuente } from "./plataformas.ts";
import { firmaDeOpcion, type TituloObservado } from "./origen.ts";

const PAIS = "es";
export const FUENTE = "streaming-availability";

/**
 * 📏 **Marcas de expiración que no son fechas**, por lista explícita de valores
 * exactos y **nunca por umbral** (`docs/DATA-SOURCES.md` §1.10).
 *
 * Son el año 9998. Las de 2099–2106 **no se tocan**: son fechas bien formadas,
 * y declararlas falsas exigiría un umbral. La exposición real —imprimir «expira
 * el 31/12/2099»— se resuelve en presentación, no tocando el dato.
 */
const EXPIRACIONES_QUE_NO_SON_FECHAS = new Set([253368063900, 253368028800]);

export interface FilaTitulo {
  readonly imdbId: string;
  readonly type: string;
  readonly tmdbId: string | null;
  readonly sourceId: string;
  readonly title: string;
  readonly originalTitle: string | null;
  readonly overview: string | null;
  readonly rating: number | null;
  readonly year: number | null;
  readonly endYear: number | null;
  readonly runtimeMinutes: number | null;
  readonly seasonCount: number | null;
  readonly episodeCount: number | null;
  readonly castMembers: readonly string[];
  readonly directors: readonly string[];
}

export interface FilaGenero {
  readonly id: string;
  readonly name: string;
}
export interface FilaTituloGenero {
  readonly imdbId: string;
  readonly genreId: string;
}

export interface FilaImagen {
  readonly imdbId: string;
  readonly type: string;
  readonly width: number;
  readonly language: string | null;
  readonly observedUrl: string;
  readonly urlExpiresAt: Date | null;
  readonly capturedAt: Date;
  readonly isPlaceholder: boolean;
}

export interface FilaOferta {
  readonly clave: string;
  readonly imdbId: string;
  readonly platformId: string;
  readonly country: string;
  readonly offerType: string;
  readonly addon: string | null;
  readonly lastCheckedAt: Date;
}

export interface FilaOpcion {
  readonly claveOferta: string;
  readonly link: string;
  readonly videoLink: string | null;
  readonly quality: string | null;
  readonly priceAmount: string | null;
  readonly priceCurrency: string | null;
  readonly audioLanguages: readonly string[];
  readonly subtitleLanguages: readonly string[];
  readonly availableSince: Date | null;
  readonly expiresAt: Date | null;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
}

export interface Colapso {
  readonly tabla: string;
  readonly clave: string;
}

export interface FilasDeSeed {
  readonly generos: readonly FilaGenero[];
  readonly titulos: readonly FilaTitulo[];
  readonly titulosGeneros: readonly FilaTituloGenero[];
  readonly imagenes: readonly FilaImagen[];
  readonly ofertas: readonly FilaOferta[];
  readonly opciones: readonly FilaOpcion[];
  readonly descartes: readonly Descarte[];
  readonly colapsos: readonly Colapso[];
  readonly expiracionesNormalizadas: number;
}

const TIPOS: Readonly<Record<TipoTitulo, string>> = {
  pelicula: "movie",
  serie: "series",
};

export function claveDeOferta(
  imdbId: string,
  platformId: string,
  offerType: string,
  addon: string | null,
): string {
  return [imdbId, platformId, PAIS, offerType, addon ?? ""].join("|");
}

export function construirFilas(titulos: readonly TituloObservado[]): FilasDeSeed {
  const generos = new Map<string, FilaGenero>();
  const filasTitulo: FilaTitulo[] = [];
  const titulosGeneros = new Map<string, FilaTituloGenero>();
  const imagenes = new Map<string, FilaImagen>();
  const ofertas = new Map<string, FilaOferta>();
  const opciones = new Map<string, FilaOpcion>();
  const descartes: Descarte[] = [];
  const colapsos: Colapso[] = [];
  let expiracionesNormalizadas = 0;

  for (const { titulo: t, observadoEn, observadoPorOpcion } of titulos) {
    const imdbId = t.ids.imdbId;

    filasTitulo.push({
      imdbId,
      type: TIPOS[t.tipo],
      tmdbId: t.ids.tmdbId,
      sourceId: t.ids.idProveedor,
      title: t.titulo,
      originalTitle: t.tituloOriginal,
      // 📏 La fuente manda cadena vacía cuando no hay traducción: eso es
      // ausencia, no un texto vacío.
      overview: t.sinopsis === null || t.sinopsis === "" ? null : t.sinopsis,
      rating: t.valoracion,
      year: t.anio,
      endYear: t.anioFin,
      runtimeMinutes: t.duracionMinutos,
      seasonCount: t.numeroTemporadas,
      episodeCount: t.numeroEpisodios,
      castMembers: t.reparto,
      directors: t.direccion,
    });

    for (const g of t.generos) {
      generos.set(g.id, { id: g.id, name: g.nombre });
      const clave = `${imdbId}|${g.id}`;
      if (titulosGeneros.has(clave))
        colapsos.push({ tabla: "external_title_genres", clave });
      else titulosGeneros.set(clave, { imdbId, genreId: g.id });
    }

    for (const imagen of t.imagenes) {
      const tipo = tipoDeImagen(imagen.tipo);
      if (tipo === null) continue;
      for (const [ancho, url] of Object.entries(imagen.urlPorAncho)) {
        const meta = analizarUrlDeImagen(url);
        const clave = `${imdbId}|${tipo}|${ancho}|${meta.idioma ?? ""}`;
        if (imagenes.has(clave)) {
          colapsos.push({ tabla: "external_title_images", clave });
          continue;
        }
        imagenes.set(clave, {
          imdbId,
          type: tipo,
          width: Number(ancho),
          language: meta.idioma,
          observedUrl: url,
          urlExpiresAt: meta.caducaEn,
          capturedAt: observadoEn,
          isPlaceholder: meta.esPlaceholder,
        });
      }
    }

    for (const d of t.disponibilidad) {
      const plataforma = plataformaDesdeFuente(d.plataformaId);
      if (plataforma === null) {
        descartes.push({
          imdbId,
          plataforma: d.plataformaId,
          tipoOferta: d.tipoOferta,
          motivo: "plataforma fuera del MVP (ADR 0003)",
        });
        continue;
      }

      const claveOferta = claveDeOferta(imdbId, plataforma, d.tipoOferta, d.addon);
      const visto = observadoPorOpcion.get(firmaDeOpcion(d)) ?? observadoEn;

      const anterior = ofertas.get(claveOferta);
      ofertas.set(claveOferta, {
        clave: claveOferta,
        imdbId,
        platformId: plataforma,
        country: PAIS,
        offerType: d.tipoOferta,
        addon: d.addon,
        // Comprobar no es ver: se queda la comprobación más reciente.
        lastCheckedAt:
          anterior !== undefined && anterior.lastCheckedAt > visto
            ? anterior.lastCheckedAt
            : visto,
      });

      let expiraEl = d.expiraEl;
      if (expiraEl !== null) {
        const segundos = Math.round(expiraEl.getTime() / 1000);
        if (EXPIRACIONES_QUE_NO_SON_FECHAS.has(segundos)) {
          expiraEl = null;
          expiracionesNormalizadas++;
        }
      }

      const claveOpcion = `${claveOferta}|${d.enlace}|${d.calidad ?? ""}`;
      if (opciones.has(claveOpcion)) {
        colapsos.push({ tabla: "external_availability_options", clave: claveOpcion });
        continue;
      }
      opciones.set(claveOpcion, {
        claveOferta,
        link: d.enlace,
        videoLink: d.enlaceReproduccion,
        quality: d.calidad,
        priceAmount: d.precio?.importe ?? null,
        priceCurrency: d.precio?.moneda ?? null,
        audioLanguages: d.idiomasAudio,
        subtitleLanguages: d.idiomasSubtitulos,
        availableSince: d.disponibleDesde,
        expiresAt: expiraEl,
        firstSeenAt: visto,
        lastSeenAt: visto,
      });
    }
  }

  return {
    generos: [...generos.values()],
    titulos: filasTitulo,
    titulosGeneros: [...titulosGeneros.values()],
    imagenes: [...imagenes.values()],
    ofertas: [...ofertas.values()],
    opciones: [...opciones.values()],
    descartes,
    colapsos,
    expiracionesNormalizadas,
  };
}
