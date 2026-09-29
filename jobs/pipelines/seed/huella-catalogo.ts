/**
 * **Huella canónica del catálogo** (ADR 0009 §9): la prueba de que dos cargas
 * del mismo crudo dejan el mismo catálogo.
 *
 * Es el sha256 de las filas de las tablas de estado **ordenadas por clave
 * natural** y **sin** lo que legítimamente difiere entre destinos:
 *
 *   · ids internos (`external_titles.id`, ofertas, opciones, imágenes) —la
 *     identidad viaja por clave natural: `imdb_id`, la clave de la oferta,
 *     `(link, quality)`, `(title, type, width, language)`—;
 *   · `created_at` y `external_titles.updated_at`, instantes de carga;
 *   · `sync_run_id`, `last_seen_run_id` y `missing_streak`, que la carga no
 *     escribe.
 *
 * Los instantes que **sí** entran —`last_checked_at`, `first_seen_at`,
 * `last_seen_at`, `captured_at`— son los de observación del crudo, nunca los de
 * la carga: por eso coinciden entre validación y `production`.
 *
 * Se calcula tres veces: offline desde el crudo (`seed:verificar`), desde
 * validación y desde `production`. Las tres tienen que coincidir. Aquí vive la
 * forma común y el cálculo offline; la lectura desde una base la hará un
 * validador de solo lectura construyendo estas mismas `FilasCanonicas`.
 */
import type { FilaDeCapacidad } from "./capacidades.ts";
import { jsonCanonico, sha256 } from "./crudo/huella.ts";
import type { FilasDeSeed } from "./filas.ts";
import { FUENTE } from "./filas.ts";
import type { PlataformaCurada } from "./plataformas.ts";
import { FUENTE_DE_PLATAFORMAS } from "./plataformas.ts";

export const VERSION_DE_LA_HUELLA_CANONICA = 1;

type Fila = Readonly<Record<string, unknown>>;

/** Las tablas de estado, con nombres de columna del esquema y sin ids internos. */
export interface FilasCanonicas {
  readonly external_platforms: readonly Fila[];
  readonly external_platform_capabilities: readonly Fila[];
  readonly external_genres: readonly Fila[];
  readonly external_titles: readonly Fila[];
  readonly external_title_genres: readonly Fila[];
  readonly external_title_images: readonly Fila[];
  readonly external_availability: readonly Fila[];
  readonly external_availability_options: readonly Fila[];
}

/** La clave natural de cada tabla, en columnas canónicas. */
export const CLAVES_NATURALES: Readonly<
  Record<keyof FilasCanonicas, readonly string[]>
> = {
  external_platforms: ["id"],
  external_platform_capabilities: ["platform_id", "country", "capability"],
  external_genres: ["id"],
  external_titles: ["imdb_id"],
  external_title_genres: ["imdb_id", "genre_id"],
  external_title_images: ["imdb_id", "type", "width", "language"],
  external_availability: ["imdb_id", "platform_id", "country", "offer_type", "addon"],
  external_availability_options: [
    "imdb_id",
    "platform_id",
    "country",
    "offer_type",
    "addon",
    "link",
    "quality",
  ],
};

/**
 * **Las columnas canónicas de cada tabla**, en el orden en que se leen. Es el
 * contrato entre el cálculo offline (`filasCanonicasDesdeSeed`) y la lectura
 * desde una base (`huella-base.ts`): un test exige que las dos produzcan
 * exactamente estas claves, así que ninguna puede añadir o quitar una columna
 * sin que la otra lo note.
 */
export const COLUMNAS_CANONICAS: Readonly<
  Record<keyof FilasCanonicas, readonly string[]>
> = {
  external_platforms: ["id", "name", "source", "source_id", "public_slug", "is_active"],
  external_platform_capabilities: ["platform_id", "country", "capability", "status"],
  external_genres: ["id", "name"],
  external_titles: [
    "imdb_id",
    "type",
    "tmdb_id",
    "source",
    "source_id",
    "title",
    "original_title",
    "overview",
    "rating",
    "year",
    "end_year",
    "runtime_minutes",
    "season_count",
    "episode_count",
    "cast_members",
    "directors",
  ],
  external_title_genres: ["imdb_id", "genre_id"],
  external_title_images: [
    "imdb_id",
    "type",
    "width",
    "language",
    "observed_url",
    "url_expires_at",
    "captured_at",
    "is_placeholder",
  ],
  external_availability: [
    "imdb_id",
    "platform_id",
    "country",
    "offer_type",
    "addon",
    "last_checked_at",
  ],
  external_availability_options: [
    "imdb_id",
    "platform_id",
    "country",
    "offer_type",
    "addon",
    "link",
    "quality",
    "video_link",
    "price_amount",
    "price_currency",
    "audio_languages",
    "subtitle_languages",
    "available_since",
    "expires_at",
    "first_seen_at",
    "last_seen_at",
  ],
};

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/** Las filas que una carga de estas `filas` tiene que dejar en la base. */
export function filasCanonicasDesdeSeed(
  filas: FilasDeSeed,
  entrada: {
    readonly plataformas: readonly PlataformaCurada[];
    readonly capacidades: readonly FilaDeCapacidad[];
  },
): FilasCanonicas {
  const ofertaPorClave = new Map(filas.ofertas.map((o) => [o.clave, o]));
  return {
    external_platforms: entrada.plataformas.map((p) => ({
      id: p.id,
      name: p.nombre,
      source: FUENTE_DE_PLATAFORMAS,
      source_id: p.sourceId,
      public_slug: p.slugPublico,
      is_active: p.activa,
    })),
    external_platform_capabilities: entrada.capacidades.map((c) => ({
      platform_id: c.platformId,
      country: c.country,
      capability: c.capability,
      status: c.status,
    })),
    external_genres: filas.generos.map((g) => ({ id: g.id, name: g.name })),
    external_titles: filas.titulos.map((t) => ({
      imdb_id: t.imdbId,
      type: t.type,
      tmdb_id: t.tmdbId,
      source: FUENTE,
      source_id: t.sourceId,
      title: t.title,
      original_title: t.originalTitle,
      overview: t.overview,
      rating: t.rating,
      year: t.year,
      end_year: t.endYear,
      runtime_minutes: t.runtimeMinutes,
      season_count: t.seasonCount,
      episode_count: t.episodeCount,
      cast_members: [...t.castMembers],
      directors: [...t.directors],
    })),
    external_title_genres: filas.titulosGeneros.map((tg) => ({
      imdb_id: tg.imdbId,
      genre_id: tg.genreId,
    })),
    external_title_images: filas.imagenes.map((i) => ({
      imdb_id: i.imdbId,
      type: i.type,
      width: i.width,
      language: i.language,
      observed_url: i.observedUrl,
      url_expires_at: iso(i.urlExpiresAt),
      captured_at: iso(i.capturedAt),
      is_placeholder: i.isPlaceholder,
    })),
    external_availability: filas.ofertas.map((o) => ({
      imdb_id: o.imdbId,
      platform_id: o.platformId,
      country: o.country,
      offer_type: o.offerType,
      addon: o.addon,
      last_checked_at: iso(o.lastCheckedAt),
    })),
    external_availability_options: filas.opciones.map((o) => {
      const oferta = ofertaPorClave.get(o.claveOferta);
      if (oferta === undefined) throw new Error(`Opción sin oferta: ${o.claveOferta}`);
      return {
        imdb_id: oferta.imdbId,
        platform_id: oferta.platformId,
        country: oferta.country,
        offer_type: oferta.offerType,
        addon: oferta.addon,
        link: o.link,
        quality: o.quality,
        video_link: o.videoLink,
        price_amount: o.priceAmount,
        price_currency: o.priceCurrency,
        audio_languages: [...o.audioLanguages],
        subtitle_languages: [...o.subtitleLanguages],
        available_since: iso(o.availableSince),
        expires_at: iso(o.expiresAt),
        first_seen_at: iso(o.firstSeenAt),
        last_seen_at: iso(o.lastSeenAt),
      };
    }),
  };
}

/** Ordena por clave natural y calcula el sha256. Independiente del orden de entrada. */
export function huellaCanonicaDelCatalogo(filas: FilasCanonicas): string {
  const tablas: Record<string, readonly string[]> = {};
  for (const tabla of Object.keys(CLAVES_NATURALES) as (keyof FilasCanonicas)[]) {
    const clave = CLAVES_NATURALES[tabla];
    tablas[tabla] = filas[tabla]
      .map((f) => ({
        k: jsonCanonico(clave.map((c) => f[c] ?? null)),
        f: jsonCanonico(f),
      }))
      .sort((a, b) =>
        a.k < b.k ? -1 : a.k > b.k ? 1 : a.f < b.f ? -1 : a.f > b.f ? 1 : 0,
      )
      .map((x) => x.f);
  }
  return sha256(jsonCanonico({ v: VERSION_DE_LA_HUELLA_CANONICA, tablas }));
}
