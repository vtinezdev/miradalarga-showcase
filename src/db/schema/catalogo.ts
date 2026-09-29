/**
 * Plano `external_*` — catálogo tal y como llega de fuera. **Solo la ingesta
 * escribe aquí.**
 *
 * Grupo **estado**: recargable sin pérdida. Una reingesta de estas cuatro
 * tablas no destruye nada propio (`docs/ARCHITECTURE.md`).
 *
 * `null` significa siempre **«no lo sabemos»**, nunca un valor por defecto
 * inventado (CLAUDE.md, regla 7).
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

import { imageType, titleType } from "./enums.ts";

/**
 * El título normalizado.
 *
 * **Ningún identificador externo es clave primaria.** Cambiar de proveedor es
 * reescribir `source` y `source_id`; `imdb_id` sigue siendo el puente, y URLs,
 * rankings y contenido editorial no se enteran (ADR 0001, mitigación 2).
 */
export const externalTitles = pgTable(
  "external_titles",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),

    type: titleType("type").notNull(),

    /** 📏 Presente al 100 % en la muestra: la deduplicación es exacta. */
    imdbId: text("imdb_id").notNull(),
    /** 📏 **Tal y como llega, con prefijo**: `tv/232766`, no `232766`. */
    tmdbId: text("tmdb_id"),

    /** Fuente de la que vino el dato, y su identificador interno allí. */
    source: text("source").notNull(),
    sourceId: text("source_id").notNull(),

    title: text("title").notNull(),
    originalTitle: text("original_title"),
    /**
     * Sinopsis en español. 📏 Falta en buena parte del catálogo por **hueco de
     * traducción, no de dato**: la fuente la manda como cadena vacía.
     *
     * No hay `overview_en`: el seed bilingüe sigue siendo una cuestión abierta
     * (`docs/DATA-SOURCES.md` §1.2) y no se modela lo que no se ha medido.
     */
    overview: text("overview"),

    /**
     * Valoración canónica: **1..100, o `null`**.
     *
     * 📏 El proveedor emite `0` para «sin valoración todavía», no para «malo».
     * La conversión `0 → null` ocurre una sola vez, en el adaptador; el `CHECK`
     * de abajo garantiza que ese `0` **no puede** llegar a la base de datos.
     */
    rating: integer("rating"),

    /** Estreno (película) o primera emisión (serie). */
    year: integer("year"),
    /** Solo series: año de la última emisión. */
    endYear: integer("end_year"),
    /** Solo películas. */
    runtimeMinutes: integer("runtime_minutes"),

    /**
     * 📏 **Contadores escalares, no entidades.** En las 64 respuestas del
     * Spike 1 hay 210 apariciones de `seasonCount`/`episodeCount` y **cero**
     * arrays `seasons[]` o `episodes[]`. No se modela lo que no se ha visto.
     */
    seasonCount: integer("season_count"),
    episodeCount: integer("episode_count"),

    /** 📏 Reparto y dirección como **texto plano**: la fuente no da ids ni fotos. */
    castMembers: text("cast_members").array().notNull(),
    directors: text("directors").array().notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("external_titles_imdb_id_key").on(t.imdbId),
    unique("external_titles_source_key").on(t.source, t.sourceId),
    // Lo que el adaptador promete, el esquema lo garantiza.
    check("external_titles_rating_rango", sql`${t.rating} BETWEEN 1 AND 100`),
    // 📏 `NOT NULL UNIQUE` no impide `''`: un único `imdbId: ""` entra, y el
    // siguiente show sin identidad colisionaría con él. Migración 0004.
    //
    // Al menos un carácter que no sea blanco: la misma regla que el `trim()`
    // de `normalizarImdbId`. `btrim()` sin segundo argumento solo quita
    // espacios, y dejaba pasar tabuladores y saltos de línea. 📏 Medido en
    // PostgreSQL 18.6 (`C.UTF-8`): coincide con `trim()` también en U+00A0 y
    // U+3000.
    check("external_titles_imdb_id_no_vacio", sql`${t.imdbId} ~ '[^[:space:]]'`),
  ],
);

/**
 * 📏 21 géneros, vocabulario cerrado medido.
 *
 * **Sin slug público en v1:** `/generos/terror` ≠ `horror`, y el slug español
 * nace con las landings, no antes.
 */
export const externalGenres = pgTable("external_genres", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});

export const externalTitleGenres = pgTable(
  "external_title_genres",
  {
    titleId: bigint("title_id", { mode: "number" })
      .notNull()
      .references(() => externalTitles.id, { onDelete: "cascade" }),
    genreId: text("genre_id")
      .notNull()
      .references(() => externalGenres.id, { onDelete: "restrict" }),
  },
  (t) => [
    primaryKey({
      name: "external_title_genres_pkey",
      columns: [t.titleId, t.genreId],
    }),
    index("external_title_genres_genre_id_idx").on(t.genreId),
  ],
);

/**
 * Referencias de imagen. **Estado actual, no histórico.**
 *
 * Nunca binarios: Neon Free son 0,5 GB. Y las URLs del proveedor **caducan**,
 * así que se guardan con `url_expires_at` y `captured_at`, jamás como si fueran
 * estables (invariante 12).
 */
export const externalTitleImages = pgTable(
  "external_title_images",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    titleId: bigint("title_id", { mode: "number" })
      .notNull()
      .references(() => externalTitles.id, { onDelete: "cascade" }),

    type: imageType("type").notNull(),
    width: integer("width").notNull(),
    /**
     * 📏 **El idioma del póster es función de la petición, no del título.** En
     * 380 reobservaciones del mismo `(título, tipo, ancho)` el idioma cambió, y
     * el 100 % de las veces intervenía el sondeo `output_language=en`.
     *
     * `null` en los backdrops, que nunca llevan segmento de idioma: por eso el
     * único de abajo necesita `NULLS NOT DISTINCT`.
     */
    language: text("language"),

    /** URL firmada completa, tal y como se observó. */
    observedUrl: text("observed_url").notNull(),
    /**
     * Caducidad parseada del parámetro `Expires`.
     * 📏 Presente en 13.360 de 13.515 URLs; las 155 restantes son el placeholder.
     */
    urlExpiresAt: timestamp("url_expires_at", { withTimezone: true }),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),

    /**
     * 📏 **Obligatorio, no un adorno.** 155 URLs de 13.515 son el SVG genérico
     * del proveedor, y **3 títulos de 764 solo tienen placeholder como póster
     * vertical**. Sin esta columna, el filtro de «ficha mínima» del Ranking A
     * los admitiría como títulos con póster.
     */
    isPlaceholder: boolean("is_placeholder").notNull(),

    /** Opcional y **exclusivamente analítico**. No se usa para construir URLs. */
    pathBase: text("path_base"),
  },
  (t) => [
    unique("external_title_images_key")
      .on(t.titleId, t.type, t.width, t.language)
      .nullsNotDistinct(),
    index("external_title_images_title_id_idx").on(t.titleId),
  ],
);
