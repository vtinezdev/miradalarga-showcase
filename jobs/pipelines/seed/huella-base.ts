/**
 * **La huella canónica del catálogo, leída desde PostgreSQL** (ADR 0009 §9).
 *
 * Construye, con `SELECT` y nada más, las mismas `FilasCanonicas` que
 * `filasCanonicasDesdeSeed` calcula offline desde el crudo, y las pasa por la
 * misma `huellaCanonicaDelCatalogo`. Si la carga dejó exactamente lo que el
 * crudo dice, las dos huellas coinciden; cualquier fila de más, de menos o con
 * un valor distinto las separa.
 *
 *   · **La identidad viaja por clave natural**: cada tabla hija se une a
 *     `external_titles` para llevar `imdb_id`, y las opciones además a su
 *     oferta. Ningún id interno entra en la huella.
 *   · **Fuera**: ids, `created_at`, `external_titles.updated_at`,
 *     `sync_run_id`, `last_seen_run_id` y `missing_streak` —lo que difiere
 *     legítimamente entre destinos o la carga no escribe—.
 *   · **Tipos**: los enums y `numeric` se leen como texto, y los
 *     `timestamptz` se normalizan a ISO. Así la forma es la del cálculo
 *     offline, sin depender de cómo tipe cada driver.
 *
 * **Solo lectura.** No importa ningún driver: habla con un `EjecutorSql`.
 */
import type { EjecutorSql } from "../../ops/contratos.ts";
import type { FilasCanonicas } from "./huella-catalogo.ts";
import { COLUMNAS_CANONICAS, huellaCanonicaDelCatalogo } from "./huella-catalogo.ts";

type Fila = Readonly<Record<string, unknown>>;
type Tabla = keyof FilasCanonicas;

/** Una consulta por tabla, con exactamente las columnas canónicas. */
export const SQL_FILAS_CANONICAS: Readonly<Record<Tabla, string>> = {
  external_platforms: `
    SELECT id, name, source, source_id, public_slug, is_active
      FROM external_platforms`,
  external_platform_capabilities: `
    SELECT platform_id, country, capability::text AS capability, status::text AS status
      FROM external_platform_capabilities`,
  external_genres: `
    SELECT id, name FROM external_genres`,
  external_titles: `
    SELECT imdb_id, type::text AS type, tmdb_id, source, source_id, title,
           original_title, overview, rating, year, end_year, runtime_minutes,
           season_count, episode_count, cast_members, directors
      FROM external_titles`,
  external_title_genres: `
    SELECT t.imdb_id, tg.genre_id
      FROM external_title_genres tg
      JOIN external_titles t ON t.id = tg.title_id`,
  external_title_images: `
    SELECT t.imdb_id, i.type::text AS type, i.width, i.language, i.observed_url,
           i.url_expires_at, i.captured_at, i.is_placeholder
      FROM external_title_images i
      JOIN external_titles t ON t.id = i.title_id`,
  external_availability: `
    SELECT t.imdb_id, a.platform_id, a.country, a.offer_type::text AS offer_type,
           a.addon, a.last_checked_at
      FROM external_availability a
      JOIN external_titles t ON t.id = a.title_id`,
  external_availability_options: `
    SELECT t.imdb_id, a.platform_id, a.country, a.offer_type::text AS offer_type,
           a.addon, o.link, o.quality::text AS quality, o.video_link,
           o.price_amount::text AS price_amount, o.price_currency,
           o.audio_languages, o.subtitle_languages, o.available_since,
           o.expires_at, o.first_seen_at, o.last_seen_at
      FROM external_availability_options o
      JOIN external_availability a ON a.id = o.availability_id
      JOIN external_titles t ON t.id = a.title_id`,
};

/** Un valor tal y como lo entrega el driver, en la forma del cálculo offline. */
function canonizarValor(valor: unknown): unknown {
  if (valor instanceof Date) return valor.toISOString();
  if (Array.isArray(valor)) return valor.map(canonizarValor);
  return valor ?? null;
}

/**
 * Las filas de una tabla con **exactamente** sus columnas canónicas. Una
 * columna ausente es un error de la consulta, no un `null`: callarlo sería
 * hacer coincidir dos huellas por accidente.
 */
export function canonizarFilas(tabla: Tabla, filas: readonly Fila[]): Fila[] {
  const columnas = COLUMNAS_CANONICAS[tabla];
  return filas.map((fila) => {
    const salida: Record<string, unknown> = {};
    for (const c of columnas) {
      if (!Object.hasOwn(fila, c)) {
        throw new Error(`La lectura de ${tabla} no trae la columna ${c}.`);
      }
      salida[c] = canonizarValor(fila[c]);
    }
    return salida;
  });
}

/** Las tablas de estado del destino, en forma canónica. Solo `SELECT`. */
export async function leerFilasCanonicas(
  ejecutor: EjecutorSql,
): Promise<FilasCanonicas> {
  const leidas: Partial<Record<Tabla, Fila[]>> = {};
  for (const tabla of Object.keys(SQL_FILAS_CANONICAS) as Tabla[]) {
    const filas = await ejecutor.ejecutar<Fila>(SQL_FILAS_CANONICAS[tabla]);
    leidas[tabla] = canonizarFilas(tabla, filas);
  }
  return leidas as FilasCanonicas;
}

export interface HuellaDelDestino {
  readonly huella: string;
  /** Filas por tabla canónica: para el resumen, no para la comparación. */
  readonly filas: Readonly<Record<Tabla, number>>;
}

/** La huella canónica del catálogo **tal y como está en la base**. */
export async function huellaCanonicaDelDestino(
  ejecutor: EjecutorSql,
): Promise<HuellaDelDestino> {
  const filas = await leerFilasCanonicas(ejecutor);
  const recuento = Object.fromEntries(
    (Object.keys(filas) as Tabla[]).map((t) => [t, filas[t].length]),
  ) as Record<Tabla, number>;
  return { huella: huellaCanonicaDelCatalogo(filas), filas: recuento };
}
