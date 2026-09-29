/**
 * Plano `derived_*` — los rankings que calculamos. **Solo la ingesta escribe.**
 *
 * ⚖️ **El Ranking C no vive aquí.** No hay columna discriminadora de tipo de
 * lista: la selección editorial es humana y vive entera en el plano editorial,
 * en la Fase 3. Una separación **física** es más fuerte que una columna, y la
 * regla es que las tres listas no se mezclan nunca.
 *
 * **Sin histórico de generaciones:** la histéresis lee las filas vigentes antes
 * de reemplazarlas, en la misma transacción. Límite declarado y aceptado: no
 * habrá auditoría de órdenes publicados, pero son reconstruibles desde las
 * capturas.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

import { externalTitles } from "./catalogo.ts";
import { titleType } from "./enums.ts";

/**
 * El desglose de por qué un título ocupa su posición.
 *
 * Forma **discriminada**: `{"1month":{"state":"no_data"}}` frente a
 * `{"1month":{"position":14}}`. **Nunca un `null` ambiguo ni un 0.** El «sin
 * dato» tiene que ser representable; es un requisito, no un detalle de
 * presentación (`docs/RANKINGS.md`).
 *
 * La validación con Zod ocurre al escribir, en el pipeline de scoring.
 */
export type SenalDeRanking =
  | { readonly state: "no_data" }
  | { readonly position: number }
  | { readonly rating: number };

export type DesgloseDeRanking = Readonly<Record<string, SenalDeRanking>>;

/**
 * Definición **pública** de cada lista algorítmica.
 *
 * Se conserva desde V1 a propósito: pasar a fórmula ponderada será **un cambio
 * de pesos y una versión nueva**, no una reescritura.
 */
export const derivedRankingDefinitions = pgTable("derived_ranking_definitions", {
  /** Clave pública y estable: `mejor-valoradas-peliculas`, `popular-semana-series`… */
  id: text("id").primaryKey(),

  /**
   * Ámbito territorial de la definición.
   *
   * A y B dependen de disponibilidad y de señales específicas de país, así que
   * no es un valor derivable. Extensión deliberada del invariante 6, que
   * enumeraba ofertas, capacidades y capturas pero no rankings.
   */
  country: text("country").notNull(),
  /** `null` en una lista mixta. A y B van siempre separadas por tipo. */
  titleType: titleType("title_type"),

  /** Señal de origen: `rating`, `popularity_1week`, `popularity_alltime`… */
  sourceSignal: text("source_signal").notNull(),
  /** Filtros aplicados, para publicarlos en `/metodologia` sin reescribirlos. */
  filters: jsonb("filters"),

  formulaVersion: integer("formula_version").notNull(),
  /** `null` en V1: todavía no hay fórmula ponderada, y no se inventa una. */
  weights: jsonb("weights"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Materialización nocturna de una lista.
 *
 * **Ninguna columna de puntuación.** La posición es el ordinal, y el desglose va
 * en `score_breakdown` con forma discriminada.
 */
export const derivedRankingEntries = pgTable(
  "derived_ranking_entries",
  {
    rankingId: text("ranking_id")
      .notNull()
      .references(() => derivedRankingDefinitions.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    titleId: bigint("title_id", { mode: "number" })
      .notNull()
      .references(() => externalTitles.id, { onDelete: "restrict" }),

    scoreBreakdown: jsonb("score_breakdown").$type<DesgloseDeRanking>().notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({
      name: "derived_ranking_entries_pkey",
      columns: [t.rankingId, t.position],
    }),
    unique("derived_ranking_entries_title_key").on(t.rankingId, t.titleId),
    check("derived_ranking_entries_position_positiva", sql`${t.position} >= 1`),
  ],
);
