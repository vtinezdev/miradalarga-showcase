/**
 * **Cuándo un anuncio sigue vigente para el producto** (ADR 0007). Derivado,
 * nunca almacenado: sin `status`, sin `cancelled`, sin `missing_streak`.
 *
 * ⚖️ **`announced_for > now()` no basta** (2026-09-24). Una fila de
 * `external_availability_announcements` puede tener fecha futura y llevar
 * semanas sin que el proveedor la liste: se canceló, se aplazó fuera del
 * horizonte o cambió de forma. No sabemos cuál, así que no se borra ni se
 * marca; pero tampoco se publica como si siguiera en pie.
 *
 * ── La regla ────────────────────────────────────────────────────────────────
 *
 * Un anuncio es **vigente** si su fecha es futura **y** lo observó el último
 * **recorrido de referencia** de `upcoming`, o alguno posterior:
 *
 *     announced_for > ahora  AND  last_seen_run_id >= <recorrido de referencia>
 *
 * El recorrido de referencia es la última ejecución de `upcoming` que:
 *
 *   · cerró `succeeded`;
 *   · recorrió el horizonte **completo** (`checkpoint.pendiente = null`);
 *   · **no registró ningún error** (`error_count = 0`). Un aviso sin su show
 *     se registra como error (`avisos_sin_show`, `deltas/job.ts`): no se pudo
 *     atribuir, así que ese recorrido no demuestra que falte nada.
 *
 * **`>=` y no `=`**, porque un recorrido **incompleto** posterior también
 * escribe `last_seen_run_id`. Si la regla fuera «visto en el de referencia»,
 * un recorrido cortado que vuelve a ver un anuncio lo invalidaría —justo lo
 * que no puede hacer un recorrido incompleto—. Con `>=`, verlo después
 * cuenta, y no verlo en un recorrido incompleto no descuenta nada: la
 * referencia sigue siendo el último completo. Los `id` de `ops_sync_runs` son
 * una identidad creciente y `upcoming` nunca corre dos veces a la vez (lock de
 * pipeline): su orden es el orden de las ejecuciones.
 *
 * **Casos de borde, declarados:**
 *
 *   · **Sin recorrido de referencia** (nunca hubo uno completo): ningún
 *     anuncio de plataforma cubierta es vigente. No se sabe nada.
 *   · `last_seen_run_id` **`NULL`** —la ejecución se borró (`SET NULL`), o es
 *     de un ensayo, que nunca confirma—: no vigente.
 *   · ⚠️ Un recorrido completo **sin ningún aviso** retiraría todo de
 *     «Próximamente». Es lo que dice el proveedor; 📏 no ha pasado nunca.
 *   · **SkyShowtime no se interpreta con esta señal**: el endpoint no la cubre
 *     (ADR 0003), así que no aparecer en un recorrido no dice nada. Su
 *     vigencia es solo la fecha. Que se publique o no lo decide la matriz de
 *     capacidades (`upcoming` ❌ para SkyShowtime), no esta regla.
 *
 * Es la misma frontera que las desapariciones (`horizonte.ts`): lo que un
 * recorrido completo no observa es lo que deja de ser vigente.
 */
import type { EjecutorSql } from "../../ops/contratos.ts";
import { PAIS } from "../deltas/contratos.ts";
import { PIPELINE_UPCOMING } from "./checkpoint.ts";
import { PLATAFORMAS_SIN_UPCOMING } from "./horizonte.ts";

export type MotivoDeVigencia =
  /** Fecha futura y observado por el recorrido de referencia o uno posterior. */
  | "observado"
  /** Fecha futura en una plataforma que el endpoint no cubre: solo la fecha. */
  | "sin_cobertura"
  /** La fecha ya llegó. */
  | "vencido"
  /** El último recorrido completo no lo observó. La fila sigue guardada. */
  | "no_observado"
  /** Nunca hubo un recorrido completo válido: no se sabe nada. */
  | "sin_referencia";

export interface Vigencia {
  readonly vigente: boolean;
  readonly motivo: MotivoDeVigencia;
}

/** La regla, sobre una fila. Función pura: `SQL_ANUNCIOS_VIGENTES` la repite. */
export function vigenciaDeAnuncio(
  anuncio: {
    readonly platformId: string;
    readonly announcedFor: Date;
    readonly lastSeenRunId: number | null;
  },
  referencia: number | null,
  ahora: Date,
): Vigencia {
  if (anuncio.announcedFor.getTime() <= ahora.getTime()) {
    return { vigente: false, motivo: "vencido" };
  }
  if (PLATAFORMAS_SIN_UPCOMING.has(anuncio.platformId)) {
    return { vigente: true, motivo: "sin_cobertura" };
  }
  if (referencia === null) return { vigente: false, motivo: "sin_referencia" };
  if (anuncio.lastSeenRunId !== null && anuncio.lastSeenRunId >= referencia) {
    return { vigente: true, motivo: "observado" };
  }
  return { vigente: false, motivo: "no_observado" };
}

/**
 * El último recorrido de referencia de `upcoming`: `succeeded`, completo y sin
 * errores. `$1` el pipeline.
 */
export const SQL_RECORRIDO_DE_REFERENCIA = `
  SELECT id FROM ops_sync_runs
   WHERE pipeline = $1
     AND status = 'succeeded'
     AND finished_at IS NOT NULL
     AND error_count = 0
     AND jsonb_typeof(checkpoint) = 'object'
     AND checkpoint -> 'pendiente' = 'null'::jsonb
   ORDER BY id DESC
   LIMIT 1`;

export async function leerRecorridoDeReferencia(
  ejecutor: EjecutorSql,
): Promise<number | null> {
  const [fila] = await ejecutor.ejecutar<{ id: string | number }>(
    SQL_RECORRIDO_DE_REFERENCIA,
    [PIPELINE_UPCOMING],
  );
  return fila === undefined ? null : Number(fila.id);
}

/**
 * Los anuncios vigentes: la fuente de «Próximamente». `$1` país · `$2` ahora ·
 * `$3` plataformas sin cobertura · `$4` el recorrido de referencia (`NULL` si
 * no lo hay: entonces `>=` es `NULL` y solo quedan las sin cobertura).
 *
 * ⚠️ El alias es `proximo`: `anuncio` y `vigente` son los de las otras dos
 * lecturas de la tabla, y los dobles de los tests las distinguen así.
 */
export const SQL_ANUNCIOS_VIGENTES = `
  SELECT t.imdb_id, proximo.platform_id, proximo.offer_type, proximo.addon,
         proximo.announced_for, proximo.link
    FROM external_availability_announcements proximo
    JOIN external_titles t ON t.id = proximo.title_id
   WHERE proximo.country = $1
     AND proximo.announced_for > $2::timestamptz
     AND (proximo.platform_id = ANY($3::text[])
          OR proximo.last_seen_run_id >= $4::bigint)
   ORDER BY proximo.announced_for, t.imdb_id, proximo.platform_id`;

export interface AnuncioVigente {
  readonly imdbId: string;
  readonly plataforma: string;
  readonly tipoOferta: string;
  readonly addon: string | null;
  readonly anunciadoPara: Date;
  readonly enlace: string | null;
}

/**
 * Los anuncios vigentes en `ahora`. `datos` lee la tabla de anuncios; `ops`,
 * `ops_sync_runs`. En producción son la misma base: van separados para que
 * el ensayo y los tests puedan tener el libro en memoria.
 */
export async function leerAnunciosVigentes(
  ejecutores: { readonly datos: EjecutorSql; readonly ops: EjecutorSql },
  ahora: Date,
): Promise<readonly AnuncioVigente[]> {
  const referencia = await leerRecorridoDeReferencia(ejecutores.ops);
  const filas = await ejecutores.datos.ejecutar<{
    imdb_id: string;
    platform_id: string;
    offer_type: string;
    addon: string | null;
    announced_for: Date | string;
    link: string | null;
  }>(SQL_ANUNCIOS_VIGENTES, [PAIS, ahora, [...PLATAFORMAS_SIN_UPCOMING], referencia]);
  return filas.map((f) => ({
    imdbId: f.imdb_id,
    plataforma: f.platform_id,
    tipoOferta: f.offer_type,
    addon: f.addon,
    anunciadoPara:
      f.announced_for instanceof Date ? f.announced_for : new Date(f.announced_for),
    enlace: f.link,
  }));
}
