/**
 * Traducción de Streaming Availability al modelo canónico.
 *
 * Es el único punto donde las dos formas se tocan. Funciones puras: sin red,
 * sin reloj, sin base de datos. Lo que no se sabe se devuelve como `null`,
 * nunca como un valor por defecto inventado (CLAUDE.md, regla 7).
 */
import type {
  AdaptadorCatalogo,
  DisponibilidadCanonica,
  ImagenCanonica,
  TipoTitulo,
  TituloCanonico,
  Valoracion,
} from "../contracts.ts";
import { respuestaBusquedaProveedor, type ShowProveedor } from "./schema.ts";

export const FUENTE = "streaming-availability";

/**
 * `rating: 0` del proveedor significa **«sin valoración todavía»**, no un cero
 * real (Spike 1: el 1 % de la muestra vale 0, ningún título cae entre 0 y 10, y
 * los ceros se concentran en los estrenos).
 *
 * La conversión ocurre aquí y solo aquí. A partir de este punto, `null` es
 * ausencia y cualquier número es una valoración de verdad.
 */
export function normalizarValoracion(rating: number | undefined): Valoracion {
  if (rating === undefined || rating === 0) return null;
  return rating;
}

/** Marcas de tiempo UNIX en segundos. `0` y ausencia significan lo mismo: no consta. */
function aFecha(segundos: number | undefined): Date | null {
  if (segundos === undefined || segundos <= 0) return null;
  return new Date(segundos * 1000);
}

function normalizarImagenes(show: ShowProveedor): ImagenCanonica[] {
  const mapa = [
    ["poster_vertical", show.imageSet?.verticalPoster],
    ["poster_horizontal", show.imageSet?.horizontalPoster],
    ["fondo_vertical", show.imageSet?.verticalBackdrop],
    ["fondo_horizontal", show.imageSet?.horizontalBackdrop],
  ] as const;

  const salida: ImagenCanonica[] = [];
  for (const [tipo, anchos] of mapa) {
    if (!anchos) continue;
    const urlPorAncho: Record<number, string> = {};
    for (const [clave, url] of Object.entries(anchos)) {
      urlPorAncho[Number(clave.slice(1))] = url;
    }
    if (Object.keys(urlPorAncho).length > 0) salida.push({ tipo, urlPorAncho });
  }
  return salida;
}

function normalizarDisponibilidad(
  show: ShowProveedor,
  pais: string,
): DisponibilidadCanonica[] {
  const opciones = show.streamingOptions?.[pais] ?? [];
  return opciones.map((o) => ({
    plataformaId: o.service.id,
    pais,
    tipoOferta: o.type,
    enlace: o.link,
    enlaceReproduccion: o.videoLink ?? null,
    calidad: o.quality ?? null,
    precio: o.price ? { importe: o.price.amount, moneda: o.price.currency } : null,
    // El `id`, nunca el `name`: el nombre es presentación y dos addons
    // distintos pueden compartirlo (ADR 0005).
    addon: o.addon?.id ?? null,
    idiomasAudio: (o.audios ?? []).map((a) => a.language),
    idiomasSubtitulos: (o.subtitles ?? []).map((s) => s.locale.language),
    disponibleDesde: aFecha(o.availableSince),
    expiraEl: aFecha(o.expiresOn),
  }));
}

/**
 * El `imdbId` como identidad, o `null` si no sirve como tal.
 *
 * Ausente, `null`, `""` o solo espacios **no es una identidad**: dos shows así
 * colisionarían en `external_titles.imdb_id` y el segundo se escribiría sobre
 * el primero. Se recorta antes de validar, y lo que sobrevive se devuelve
 * recortado. **No se exige el formato `tt…`**: el contrato solo pide que la
 * identidad exista.
 */
export function normalizarImdbId(valor: string | null | undefined): string | null {
  const recortado = valor?.trim() ?? "";
  return recortado === "" ? null : recortado;
}

/**
 * Traduce un único show ya validado.
 *
 * Devuelve `null` si el show **no tiene identidad** (`normalizarImdbId`): sin
 * ella no hay título al que colgar ofertas, imágenes ni géneros, y no se
 * inventa una. Quien lo llama decide cómo contarlo.
 */
export function normalizarShow(
  show: ShowProveedor,
  pais: string,
): TituloCanonico | null {
  const imdbId = normalizarImdbId(show.imdbId);
  if (imdbId === null) return null;

  const esSerie = show.showType === "series";
  const tipo: TipoTitulo = esSerie ? "serie" : "pelicula";

  return {
    tipo,
    ids: {
      imdbId,
      tmdbId: show.tmdbId ?? null,
      idProveedor: show.id,
    },
    titulo: show.title,
    tituloOriginal: show.originalTitle ?? null,
    sinopsis: show.overview ?? null,
    valoracion: normalizarValoracion(show.rating),
    anio: (esSerie ? show.firstAirYear : show.releaseYear) ?? null,
    anioFin: esSerie ? (show.lastAirYear ?? null) : null,
    duracionMinutos: esSerie ? null : (show.runtime ?? null),
    numeroTemporadas: esSerie ? (show.seasonCount ?? null) : null,
    numeroEpisodios: esSerie ? (show.episodeCount ?? null) : null,
    generos: (show.genres ?? []).map((g) => ({ id: g.id, nombre: g.name })),
    reparto: show.cast ?? [],
    // El proveedor separa dirección (películas) y creación (series); para
    // nosotros es el mismo papel autoral.
    direccion: esSerie ? (show.creators ?? []) : (show.directors ?? []),
    imagenes: normalizarImagenes(show),
    disponibilidad: normalizarDisponibilidad(show, pais),
  };
}

export const adaptadorStreamingAvailability: AdaptadorCatalogo = {
  fuente: FUENTE,
  normalizar(respuestaCruda: unknown, pais: string): readonly TituloCanonico[] {
    const respuesta = respuestaBusquedaProveedor.parse(respuestaCruda);
    return respuesta.shows
      .map((show) => normalizarShow(show, pais))
      .filter((titulo) => titulo !== null);
  },
};
