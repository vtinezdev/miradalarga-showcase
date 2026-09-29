/**
 * Esquema v1 de Mirada Larga. **15 tablas**, cinco planos por prefijo.
 *
 * Es lo que lee `drizzle.config.ts` para generar las migraciones, y lo que
 * importará `src/db/queries/` en la Fase 2.
 *
 * Diseño congelado el 2026-09-22 en `docs/DATA-MODEL.md`, que es la fuente de
 * verdad: **no se reabre una decisión de ese documento salvo por imposibilidad
 * técnica o contradicción demostrable con los datos**. Las 14 originales más
 * `external_availability_announcements` (ADR 0007, migración 0003).
 *
 * | Prefijo       | Contenido                                  | Quién escribe |
 * |---------------|--------------------------------------------|---------------|
 * | `external_*`  | Catálogo y disponibilidad, tal y como llegan | La ingesta   |
 * | `derived_*`   | Rankings que calculamos                     | La ingesta    |
 * | `ops_*`       | Ejecuciones de pipelines, cuota, errores    | Los jobs      |
 *
 * `editorial_*` y `site_*` están **diferidos a la Fase 3**: no hay todavía
 * ninguna tabla suya, y por eso tampoco hay dos roles escritores distintos
 * (motivo por el que los planos son prefijos y no schemas de PostgreSQL).
 */
export * from "./enums.ts";
export * from "./catalogo.ts";
export * from "./disponibilidad.ts";
export * from "./senales.ts";
export * from "./derivado.ts";
export * from "./operacion.ts";
export * from "./relaciones.ts";
