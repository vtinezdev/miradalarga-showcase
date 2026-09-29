/**
 * Configuración de drizzle-kit.
 *
 * **Sin `dbCredentials` a propósito.** `drizzle-kit generate` no necesita
 * conexión: lee el esquema de TypeScript y escribe SQL. Omitirlas hace
 * imposible que este fichero lea `DATABASE_URL`, y por tanto que el build
 * arrastre un secreto a `dist/server/.dev.vars` (docs/SECURITY.md).
 *
 * Cuando exista la rama de validación en Neon se añadirán aquí, leyendo
 * `DATABASE_URL_DIRECT`, junto con el script `db:migrate`. Hoy no.
 *
 * **Sin `casing`:** cada columna declara su nombre SQL literal en
 * `src/db/schema/`. Una sola fuente de verdad para el nombre de una columna.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  strict: true,
  verbose: true,
});
