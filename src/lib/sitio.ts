/**
 * Constantes del sitio. La URL canónica es la del dominio decidido en la
 * Fase 0 (`PRODUCT.md` §8); el sitio **no es indexable** hasta el lanzamiento
 * de la Fase 3 (salida: web publicada y Search Console verificado).
 */
export const NOMBRE = "Mirada Larga";
export const LEMA = "Qué merece la pena ver, y dónde verlo";
export const DESCRIPCION =
  "Guía editorial del streaming en España: qué merece la pena ver, con criterio firmado, y dónde verlo hoy, con fecha de comprobación.";
export const URL_BASE = "https://miradalarga.com";

/** Interruptor único de indexación: `robots`, metadatos y sitemap lo leen. */
export const INDEXABLE = false;

/** Fuente de disponibilidad, que se atribuye siempre (docs/DATA-SOURCES.md §1.11). */
export const FUENTE_DE_DISPONIBILIDAD = "Streaming Availability (Movie of the Night)";
