/**
 * Tipos del pipeline de *seed*.
 *
 * El pipeline **no conoce ningún driver**: habla con un `EjecutorSql`, que es
 * lo mínimo que necesita. Así la lógica se prueba sin base de datos y el día
 * que cambie el cliente de PostgreSQL no hay que tocarla.
 */

/**
 * Lo único que el pipeline necesita de una conexión.
 *
 * Vive en `jobs/ops/contratos.ts` y aquí solo se reexporta: la dependencia va
 * de un pipeline hacia la infraestructura, nunca al revés.
 */
export type { EjecutorSql } from "../../ops/contratos.ts";

/** Resultado de escribir un lote de filas en una tabla. */
export interface ResultadoDeTabla {
  readonly tabla: string;
  /** Filas que el pipeline quiso escribir, ya deduplicadas por clave natural. */
  readonly intentadas: number;
  /** Filas nuevas: `xmax = 0` en el `RETURNING`. */
  readonly insertadas: number;
  /** Filas que ya existían y el `ON CONFLICT` actualizó. */
  readonly actualizadas: number;
  /** Filas que `ON CONFLICT DO NOTHING` descartó por existir ya. */
  readonly ignoradas: number;
  /**
   * Filas del corpus que colapsaron contra otra **antes** de llegar a la base
   * de datos, por compartir clave natural. Cada una es una pérdida potencial.
   */
  readonly colapsadas: number;
}

/** Una opción del corpus que no se carga, y por qué. */
export interface Descarte {
  readonly imdbId: string;
  readonly plataforma: string;
  readonly tipoOferta: string;
  readonly motivo: string;
}

/** Informe completo de una pasada del seed. */
export interface InformeDeSeed {
  readonly tablas: readonly ResultadoDeTabla[];
  readonly descartes: readonly Descarte[];
  /**
   * Ofertas lógicas con más de una opción. Va a `ops_sync_runs.multi_link_offers`.
   * 📏 340 de 1.857 en el corpus B del Spike 1.
   */
  readonly multiLinkOffers: number;
  /**
   * Marcas de expiración que no son fechas, ya neutralizadas.
   * Va a `ops_sync_runs.far_future_expiries`. 📏 La fuente emite el año 9998.
   */
  readonly farFutureExpiries: number;
  /** `imdb_id → id`, para comprobar que los identificadores no bailan. */
  readonly idsDeTitulo: ReadonlyMap<string, string>;
  /** Clave natural de la oferta → `id`. */
  readonly idsDeOferta: ReadonlyMap<string, string>;
}
