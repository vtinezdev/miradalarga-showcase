/**
 * Plano `external_*` — señales ordinales.
 *
 * Un solo par de tablas sirve para la **popularidad** (cuatro ventanas) y para
 * el **Top 10 oficial**: ambas son «una lista ordenada capturada de la fuente en
 * un instante, con un alcance».
 *
 * **Por qué esta forma y no una tabla plana de métricas:** con `obtained_depth`,
 * un título ausente de una captura es **«fuera del top N»**, y la ausencia de la
 * captura entera es **«no se midió»**. En una tabla plana las dos se confunden,
 * y `docs/RANKINGS.md` exige que el «sin dato» sea representable.
 *
 * ❌ **IRRECUPERABLE.** Las dos son inmutables. La fuente no devuelve el pasado.
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

import { externalTitles } from "./catalogo.ts";
import { externalPlatforms } from "./disponibilidad.ts";
import { listKind, popularityWindow, titleType } from "./enums.ts";
import { opsSyncRuns } from "./operacion.ts";

/**
 * Una captura de una lista ordenada, con su alcance y su profundidad.
 *
 * **`bucket_start_at` + `captured_at`, sin columna de cadencia.** El *bucket* es
 * el intervalo al que pertenece la captura; `captured_at`, el instante real.
 * **El esquema no fija ninguna frecuencia**: cambiar de diaria a semanal u
 * horaria es cambiar cómo el job calcula el *bucket*, sin migración.
 */
export const externalListCaptures = pgTable(
  "external_list_captures",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),

    /** Popularidad o Top 10 oficial. Explícito, no deducido de `window IS NULL`. */
    listKind: listKind("list_kind").notNull(),

    platformId: text("platform_id")
      .notNull()
      .references(() => externalPlatforms.id, { onDelete: "restrict" }),
    country: text("country").notNull(),
    /**
     * `null` mientras no esté medido si el Top 10 se publica separado por tipo:
     * 📏 la fuente lo devuelve como «array plano de 10». No se inventa.
     */
    titleType: titleType("title_type"),
    /** Solo para popularidad. `null` en el Top 10 oficial, que no tiene ventana. */
    window: popularityWindow("window"),

    bucketStartAt: timestamp("bucket_start_at", { withTimezone: true }).notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),

    /**
     * Profundidad **pedida** por el job. `null` en el Top 10 oficial, que no
     * admite profundidad. Distingue «la lista se agotó» de «paramos antes».
     */
    requestedDepth: integer("requested_depth"),
    /** Profundidad **obtenida**. Es lo que hace representable el «sin dato». */
    obtainedDepth: integer("obtained_depth").notNull(),
    /**
     * La observación de `hasMore` en el momento de la captura.
     *
     * ⚠️ **No es derivable.** Con `obtained_depth = 100` y nada más, una captura
     * donde la fuente dijo «hay más» y otra donde dijo «esto es todo» quedan
     * indistinguibles para siempre. `null` es «no consta».
     */
    truncated: boolean("truncated"),

    /** RESTRICT: `SET NULL` haría `UPDATE` y el trigger lo abortaría. */
    syncRunId: bigint("sync_run_id", { mode: "number" }).references(
      () => opsSyncRuns.id,
      { onDelete: "restrict" },
    ),
  },
  (t) => [
    unique("external_list_captures_key")
      .on(t.listKind, t.platformId, t.country, t.titleType, t.window, t.bucketStartAt)
      .nullsNotDistinct(),
    check(
      "external_list_captures_obtained_depth_no_negativo",
      sql`${t.obtainedDepth} >= 0`,
    ),
    check(
      "external_list_captures_requested_depth_positivo",
      sql`${t.requestedDepth} IS NULL OR ${t.requestedDepth} >= 1`,
    ),
    // La popularidad siempre tiene ventana; el Top 10 oficial nunca.
    check(
      "external_list_captures_ventana_coherente",
      sql`(${t.listKind} = 'popularity' AND ${t.window} IS NOT NULL) OR (${t.listKind} = 'official_top' AND ${t.window} IS NULL)`,
    ),
  ],
);

/**
 * Las posiciones de una captura.
 *
 * **Ninguna columna de puntuación.** Una posición es un **ordinal**, y no puede
 * dejar de serlo por descuido: añadir una puntuación aquí exigiría hacerlo a
 * propósito (invariante 5). El Top 10 tampoco trae campo de posición en la
 * fuente: el puesto es el índice del array.
 *
 * `capture_id` es **RESTRICT y no CASCADE**: la retención de 180 días borra en
 * dos pasos explícitos —primero posiciones, luego capturas—, sin depender del
 * comportamiento de un trigger dentro de una cascada.
 */
export const externalListPositions = pgTable(
  "external_list_positions",
  {
    captureId: bigint("capture_id", { mode: "number" })
      .notNull()
      .references(() => externalListCaptures.id, { onDelete: "restrict" }),
    position: integer("position").notNull(),
    titleId: bigint("title_id", { mode: "number" })
      .notNull()
      .references(() => externalTitles.id, { onDelete: "restrict" }),
  },
  (t) => [
    primaryKey({
      name: "external_list_positions_pkey",
      columns: [t.captureId, t.position],
    }),
    unique("external_list_positions_title_key").on(t.captureId, t.titleId),
    index("external_list_positions_title_id_idx").on(t.titleId),
    check("external_list_positions_position_positiva", sql`${t.position} >= 1`),
  ],
);
