/**
 * Pipeline de *seed*: del corpus crudo a las tablas de estado del esquema v1.
 *
 * Es el embrión del seed de la Fase 2. Hoy lee de disco, pero la lectura está
 * aislada en `origen.ts`: cuando el seed tire de la API en vivo, se cambia esa
 * pieza y el resto —normalización, construcción de filas, upsert— no se toca.
 *
 * **Escribe solo las seis tablas de estado**, que son las recargables sin
 * pérdida. Ni eventos, ni capturas, ni posiciones: ese histórico lo emite el
 * pipeline de deltas comparando dos estados, y aquí no hay dos estados que
 * comparar. Fabricarlo sería inventar observaciones que nadie hizo.
 *
 * **Nunca descarga ni cachea imágenes.** Solo guarda la referencia: copiar a
 * R2 es trabajo del pipeline de imágenes, que todavía no existe.
 */
import type { FilaDeCapacidad } from "./capacidades.ts";
import type { EjecutorSql, InformeDeSeed, ResultadoDeTabla } from "./contratos.ts";
import { construirFilas, FUENTE, type FilasDeSeed } from "./filas.ts";
import { leerCorpusSpike1 } from "./origen.ts";
import { FUENTE_DE_PLATAFORMAS, PLATAFORMAS_MVP } from "./plataformas.ts";
import { upsert } from "./upsert.ts";

export { construirFilas, leerCorpusSpike1 };
export type { FilasDeSeed };

/**
 * Ofertas lógicas con más de una opción.
 *
 * No hace falta preguntárselo a la base de datos: la clave natural de la oferta
 * ya está en cada opción, así que el recuento sale de lo que el pipeline tiene
 * delante. `ops_sync_runs.multi_link_offers` es un contador de observabilidad,
 * no una consulta.
 */
function contarOfertasMultiOpcion(filas: FilasDeSeed): number {
  const porOferta = new Map<string, number>();
  for (const opcion of filas.opciones) {
    porOferta.set(opcion.claveOferta, (porOferta.get(opcion.claveOferta) ?? 0) + 1);
  }
  let conVarias = 0;
  for (const cuantas of porOferta.values()) if (cuantas > 1) conVarias++;
  return conVarias;
}

/** Cuántos colapsos hubo en cada tabla, por nombre. */
function contarColapsos(filas: FilasDeSeed, tabla: string): number {
  return filas.colapsos.filter((c) => c.tabla === tabla).length;
}

export interface OpcionesDeEjecutarSeed {
  /**
   * El instante de la carga, para `external_titles.updated_at`. Por defecto,
   * `new Date()`. La carga del seed lo fija para ser reproducible; nunca es un
   * instante de observación.
   */
  readonly ahora?: Date;
  /**
   * Las filas de `external_platform_capabilities` (ADR 0009 §8). Si vienen, se
   * escriben **justo después de las plataformas** —la FK lo exige— y antes de
   * los títulos. Por defecto, ninguna: el seed del Spike no las escribe.
   */
  readonly capacidades?: readonly FilaDeCapacidad[];
}

export async function ejecutarSeed(
  ejecutor: EjecutorSql,
  filas: FilasDeSeed,
  ajustes: OpcionesDeEjecutarSeed = {},
): Promise<InformeDeSeed> {
  const tablas: ResultadoDeTabla[] = [];
  const ahora = ajustes.ahora ?? new Date();

  // ── 1 · Géneros. Vocabulario cerrado, sin dependencias ───────────────────
  const generos = await upsert(
    ejecutor,
    {
      tabla: "external_genres",
      columnas: ["id", "name"],
      constraint: "external_genres_pkey",
      actualizar: ["name"],
      tamanoLote: 500,
    },
    filas.generos.map((g) => [g.id, g.name]),
  );
  tablas.push(generos.resumen);

  // ── 2 · Plataformas. Referencia CURADA, no ingerida ──────────────────────
  const plataformas = await upsert(
    ejecutor,
    {
      tabla: "external_platforms",
      columnas: ["id", "name", "source", "source_id", "public_slug", "is_active"],
      constraint: "external_platforms_pkey",
      actualizar: ["name", "source", "source_id", "public_slug", "is_active"],
      tamanoLote: 50,
    },
    PLATAFORMAS_MVP.map((p) => [
      p.id,
      p.nombre,
      FUENTE_DE_PLATAFORMAS,
      p.sourceId,
      p.slugPublico,
      p.activa,
    ]),
  );
  tablas.push(plataformas.resumen);

  // ── 2b · Capacidades. Referencia CURADA, solo si se piden ────────────────
  if (ajustes.capacidades !== undefined) {
    const capacidades = await upsert(
      ejecutor,
      {
        tabla: "external_platform_capabilities",
        columnas: ["platform_id", "country", "capability", "status"],
        constraint: "external_platform_capabilities_pkey",
        // Convergente: si la matriz se remide, reaplicarla solo cambia el estado.
        actualizar: ["status"],
        tamanoLote: 100,
      },
      ajustes.capacidades.map((c) => [c.platformId, c.country, c.capability, c.status]),
    );
    tablas.push(capacidades.resumen);
  }

  // ── 3 · Títulos. `imdb_id` es la clave de deduplicación ──────────────────
  const titulos = await upsert(
    ejecutor,
    {
      tabla: "external_titles",
      columnas: [
        "type",
        "imdb_id",
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
        "updated_at",
      ],
      constraint: "external_titles_imdb_id_key",
      actualizar: [
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
        "updated_at",
      ],
      devolver: ["id", "imdb_id"],
      tamanoLote: 300,
    },
    filas.titulos.map((t) => [
      t.type,
      t.imdbId,
      t.tmdbId,
      FUENTE,
      t.sourceId,
      t.title,
      t.originalTitle,
      t.overview,
      t.rating,
      t.year,
      t.endYear,
      t.runtimeMinutes,
      t.seasonCount,
      t.episodeCount,
      [...t.castMembers],
      [...t.directors],
      ahora,
    ]),
  );
  tablas.push(titulos.resumen);

  const idPorImdb = new Map<string, string>();
  for (const fila of titulos.devueltas) {
    idPorImdb.set(String(fila.imdb_id), String(fila.id));
  }

  const idDe = (imdbId: string): string => {
    const id = idPorImdb.get(imdbId);
    if (id === undefined) throw new Error(`Sin id para el título ${imdbId}`);
    return id;
  };

  // ── 4 · Relación N:M de géneros ──────────────────────────────────────────
  const titulosGeneros = await upsert(
    ejecutor,
    {
      tabla: "external_title_genres",
      columnas: ["title_id", "genre_id"],
      constraint: "external_title_genres_pkey",
      actualizar: [],
      tamanoLote: 800,
    },
    filas.titulosGeneros.map((tg) => [idDe(tg.imdbId), tg.genreId]),
    contarColapsos(filas, "external_title_genres"),
  );
  tablas.push(titulosGeneros.resumen);

  // ── 5 · Imágenes. Estado actual, no histórico. Solo referencias ──────────
  const imagenes = await upsert(
    ejecutor,
    {
      tabla: "external_title_images",
      columnas: [
        "title_id",
        "type",
        "width",
        "language",
        "observed_url",
        "url_expires_at",
        "captured_at",
        "is_placeholder",
      ],
      constraint: "external_title_images_key",
      actualizar: ["observed_url", "url_expires_at", "captured_at", "is_placeholder"],
      tamanoLote: 500,
    },
    filas.imagenes.map((i) => [
      idDe(i.imdbId),
      i.type,
      i.width,
      i.language,
      i.observedUrl,
      i.urlExpiresAt,
      i.capturedAt,
      i.isPlaceholder,
    ]),
    contarColapsos(filas, "external_title_images"),
  );
  tablas.push(imagenes.resumen);

  // ── 6 · Ofertas lógicas. Solo identidad ──────────────────────────────────
  const ofertas = await upsert(
    ejecutor,
    {
      tabla: "external_availability",
      columnas: [
        "title_id",
        "platform_id",
        "country",
        "offer_type",
        "addon",
        "last_checked_at",
      ],
      constraint: "external_availability_key",
      actualizar: ["last_checked_at"],
      // Comprobar no retrocede: es la identidad de la última observación.
      monotonas: ["last_checked_at"],
      devolver: ["id", "title_id", "platform_id", "offer_type", "addon"],
      tamanoLote: 600,
    },
    filas.ofertas.map((o) => [
      idDe(o.imdbId),
      o.platformId,
      o.country,
      o.offerType,
      o.addon,
      o.lastCheckedAt,
    ]),
  );
  tablas.push(ofertas.resumen);

  const imdbPorId = new Map<string, string>();
  for (const [imdb, id] of idPorImdb) imdbPorId.set(id, imdb);

  const idPorClaveDeOferta = new Map<string, string>();
  for (const fila of ofertas.devueltas) {
    const imdb = imdbPorId.get(String(fila.title_id));
    if (imdb === undefined) continue;
    // `addon` vuelve como texto o como NULL; el `??` conserva la distinción
    // entre «sin addon» y un addon cuyo id fuera cadena vacía, que no existe.
    const addon = typeof fila.addon === "string" ? fila.addon : "";
    const clave = [
      imdb,
      String(fila.platform_id),
      "es",
      String(fila.offer_type),
      addon,
    ].join("|");
    idPorClaveDeOferta.set(clave, String(fila.id));
  }

  // ── 7 · Opciones. La variante concreta observada ─────────────────────────
  const opciones = await upsert(
    ejecutor,
    {
      tabla: "external_availability_options",
      columnas: [
        "availability_id",
        "link",
        "video_link",
        "quality",
        "price_amount",
        "price_currency",
        "audio_languages",
        "subtitle_languages",
        "available_since",
        "expires_at",
        "first_seen_at",
        "last_seen_at",
      ],
      constraint: "external_availability_options_key",
      actualizar: [
        "video_link",
        "price_amount",
        "price_currency",
        "audio_languages",
        "subtitle_languages",
        "available_since",
        "expires_at",
        "last_seen_at",
      ],
      monotonas: ["last_seen_at"],
      tamanoLote: 300,
    },
    filas.opciones.map((o) => {
      const idOferta = idPorClaveDeOferta.get(o.claveOferta);
      if (idOferta === undefined) {
        throw new Error(`Opción sin oferta padre: ${o.claveOferta}`);
      }
      return [
        idOferta,
        o.link,
        o.videoLink,
        o.quality,
        o.priceAmount,
        o.priceCurrency,
        [...o.audioLanguages],
        [...o.subtitleLanguages],
        o.availableSince,
        o.expiresAt,
        o.firstSeenAt,
        o.lastSeenAt,
      ];
    }),
    contarColapsos(filas, "external_availability_options"),
  );
  tablas.push(opciones.resumen);

  return {
    tablas,
    descartes: filas.descartes,
    multiLinkOffers: contarOfertasMultiOpcion(filas),
    farFutureExpiries: filas.expiracionesNormalizadas,
    idsDeTitulo: idPorImdb,
    idsDeOferta: idPorClaveDeOferta,
  };
}
