/**
 * Plano `ops_*` — ejecuciones de pipelines. **Solo los jobs escriben aquí.**
 *
 * `ops_sync_runs` no es opcional: el **corte automático al 90 % del presupuesto**
 * (Plan §8.5) se contabiliza en esta tabla. Sin ella, la salvaguarda de cuota no
 * existe.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { syncRunStatus } from "./enums.ts";

/** Recuento de filas tocadas por tabla: `{ "external_titles": 412, … }`. */
export type FilasAfectadas = Readonly<Record<string, number>>;

/** Un error representativo de la ejecución. Forma libre: la fija el pipeline. */
export type MuestraDeError = Readonly<Record<string, unknown>>;

/** Un punto de reanudación. Forma libre y versionada: la fija el pipeline. */
export type PuntoDeControl = Readonly<Record<string, unknown>>;

export const opsSyncRuns = pgTable(
  "ops_sync_runs",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),

    /** Nombre del pipeline: `seed`, `deltas`, `upcoming`, `scoring`… */
    pipeline: text("pipeline").notNull(),
    status: syncRunStatus("status").notNull(),

    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    /** `null` mientras la ejecución sigue viva. */
    finishedAt: timestamp("finished_at", { withTimezone: true }),

    /** Requests gastadas contra la API externa en esta ejecución. */
    requestsMade: integer("requests_made").notNull().default(0),
    /**
     * **El techo OPERATIVO vigente al arrancar: el umbral de corte ya aplicado.**
     *
     * Con `STREAMING_API_MONTHLY_BUDGET=1000` y una fracción de 0,90, aquí se
     * graba **900**, no 1000. Es el techo que de verdad gobernó la ejecución:
     * el bruto contractual nunca llega a gastarse, así que guardarlo daría un
     * margen que no existe.
     *
     * **No hay `budget_remaining`:** es `budget_limit - requests_made`, y nada
     * derivable se almacena (invariante 1). Con este criterio esa resta es el
     * margen **realmente utilizable**, no uno que incluye las 100 intocables.
     */
    budgetLimit: integer("budget_limit"),

    /** Filas tocadas por tabla. No es derivable de nada: es el efecto medido. */
    rowsAffected: jsonb("rows_affected").$type<FilasAfectadas>(),

    /** Ofertas lógicas con más de una opción. 📏 340 de 1.857 en el corpus B. */
    multiLinkOffers: integer("multi_link_offers").notNull().default(0),
    /**
     * Fechas de expiración absurdamente lejanas.
     *
     * 📏 La fuente emite valores del año 9998. Este contador hace que un
     * centinela nuevo aparezca como número y no como sorpresa.
     */
    farFutureExpiries: integer("far_future_expiries").notNull().default(0),

    /** Total **real** de errores de la ejecución. */
    errorCount: integer("error_count").notNull().default(0),
    /**
     * Muestra **acotada** de errores representativos, nunca la lista completa:
     * una ejecución con miles de fallos no puede reventar la fila.
     *
     * Por eso `error_count` no es derivable de aquí. Que la muestra esté
     * truncada se deduce comparando su tamaño con `error_count`, así que
     * tampoco hace falta un `errors_truncated`.
     *
     * El tamaño máximo es **política de los jobs** (Fase 2), no una constraint:
     * el número exacto todavía no está decidido.
     */
    errorSamples: jsonb("error_samples").$type<readonly MuestraDeError[]>(),

    /** Commit de GitHub Actions que produjo la ejecución. `null` en local. */
    commitSha: text("commit_sha"),

    /**
     * **Punto de reanudación persistente** (ADR 0006, migración `0002`).
     *
     * El último punto **confirmado** de la ejecución: la ventana exacta, la
     * lista y el `cursorDeEntrada` de la primera página no confirmada. Un
     * runner de GitHub Actions es efímero y el cursor del proveedor es opaco:
     * no se puede reconstruir desde ninguna otra tabla, y sin él una ejecución
     * cortada no se reanuda, se recalcula.
     *
     * `null` = la ejecución no lleva checkpoint (todas las anteriores a `0002`
     * y cualquier pipeline que no lo use). **Forma libre para la base**, igual
     * que `error_samples`: la fija el pipeline y la valida al leerla, con
     * versión propia. El `CHECK` solo exige que sea un objeto.
     *
     * ⚠️ Se escribe **en la misma transacción que los datos de la página**, no
     * por la conexión de la cuota: tiene que deshacerse con ellos. Es lo
     * contrario que `requests_made`, que no puede deshacerse nunca.
     */
    checkpoint: jsonb("checkpoint").$type<PuntoDeControl>(),
  },
  (t) => [
    index("ops_sync_runs_pipeline_started_at_idx").on(t.pipeline, t.startedAt),
    check("ops_sync_runs_error_count_no_negativo", sql`${t.errorCount} >= 0`),
    check(
      "ops_sync_runs_checkpoint_objeto",
      sql`${t.checkpoint} IS NULL OR jsonb_typeof(${t.checkpoint}) = 'object'`,
    ),
  ],
);
