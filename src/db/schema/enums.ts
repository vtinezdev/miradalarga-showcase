/**
 * Vocabularios cerrados del esquema v1.
 *
 * Nombres de tipo y valores **en inglés**: son identificadores SQL. El modelo
 * canónico de `jobs/adapters/contracts.ts` sigue en español, y la traducción
 * ocurre en esta capa, que es una frontera más y no una inconsistencia
 * (`docs/DATA-MODEL.md`).
 *
 * Un enum entra aquí solo si su vocabulario está **medido**. Ninguno se amplía
 * «por si acaso»: añadir un valor es `ALTER TYPE … ADD VALUE`, aditivo y barato.
 */
import { pgEnum } from "drizzle-orm/pg-core";

/** Tipo de obra. Determina la ruta pública: /peliculas/… o /series/… */
export const titleType = pgEnum("title_type", ["movie", "series"]);

/**
 * Cómo se accede a un título en una plataforma.
 * 📏 Los cinco valores documentados aparecen de verdad en las respuestas de ES.
 */
export const offerType = pgEnum("offer_type", [
  "subscription",
  "rent",
  "buy",
  "free",
  "addon",
]);

/** Calidad máxima ofrecida. Llega en el 74 % de las ofertas; el resto es `null`. */
export const quality = pgEnum("quality", ["sd", "hd", "uhd"]);

/** Los cuatro conjuntos de imágenes que emite la fuente. */
export const imageType = pgEnum("image_type", [
  "vertical_poster",
  "horizontal_poster",
  "vertical_backdrop",
  "horizontal_backdrop",
]);

/**
 * Qué puede publicarse de una plataforma.
 *
 * Las cuatro primeras son las columnas de la matriz medida
 * (`docs/DATA-SOURCES.md` §1.4, ADR 0003).
 *
 * ⚠️ **`popularity_order` amplía deliberadamente esa matriz.** Es la compuerta
 * de publicación del Ranking B: `docs/RANKINGS.md` declara que la ordenación
 * por popularidad **solo se ha medido en Netflix**, y sin esta capacidad ese
 * límite no tiene dónde vivir. Pendiente de reflejarlo en el ADR 0003.
 */
export const capability = pgEnum("capability", [
  "expiring",
  "upcoming",
  "official_top",
  "prices",
  "popularity_order",
]);

/**
 * **Cuatro estados, no dos.**
 *
 * Un booleano colapsaría ⚪ y ❌ en el mismo valor, y esa es justo la distinción
 * que protege el ADR 0003: *un cero observado no se comunica como una ausencia*.
 */
export const capabilityStatus = pgEnum("capability_status", [
  "supported_with_data",
  "supported_no_data_in_sample",
  "not_supported",
  "unknown",
]);

/**
 * Eventos de disponibilidad. Se emiten **a nivel de oferta lógica, nunca por
 * opción**: la rotación de deeplinks, calidades y precios es `changed`, y no
 * genera falsas altas ni bajas del padre.
 */
export const eventType = pgEnum("event_type", [
  "announced",
  "added",
  "changed",
  "removed",
]);

/**
 * Qué clase de lista ordenada es una captura.
 *
 * Columna explícita en vez de deducir el Top 10 de `window IS NULL`: el origen
 * de la lista y su alcance temporal son dos hechos distintos, y sobrecargar un
 * `NULL` para codificar el primero los confunde.
 */
export const listKind = pgEnum("list_kind", ["popularity", "official_top"]);

/**
 * Ventanas de popularidad. 📏 El enum real de `order_by` de la fuente.
 *
 * Las ventanas **no son versiones suaves de lo mismo**: `1week` y `alltime` no
 * comparten ni un título en películas. Solo `1month` sirve para enriquecer la
 * semanal (`docs/RANKINGS.md`).
 */
export const popularityWindow = pgEnum("popularity_window", [
  "1week",
  "1month",
  "1year",
  "alltime",
]);

/**
 * Estado de una ejecución de pipeline.
 *
 * `budget_stopped` **es** el corte automático al 90 % del presupuesto: no hay
 * además un booleano, que sería redundante.
 */
export const syncRunStatus = pgEnum("sync_run_status", [
  "running",
  "succeeded",
  "failed",
  "budget_stopped",
]);
