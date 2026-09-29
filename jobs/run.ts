/**
 * Punto de entrada de los jobs de ingesta: `pnpm job <nombre>`.
 *
 * **Registrados: `deltas`** (Paso 5, 2026-09-23), **`expiring` y `upcoming`**
 * (2026-09-24). Los demás pipelines —seed, updated, popularity, reconcile,
 * enrich, scoring— siguen bloqueados: registrarlos exige una aprobación propia,
 * con su techo mensual y su tope por ejecución decididos por separado. `changes_validation`
 * es técnico y no se registra nunca.
 *
 * ── El orden de un arranque ─────────────────────────────────────────────────
 *
 *   1. el nombre tiene que estar registrado;
 *   2. `verificarDestino` (las mismas guardas que las migraciones): directa,
 *      hostname exacto de la rama de validación, `MIGRATION_TARGET` nombrado;
 *   3. las guardas propias del job: destino, presupuesto sin overrides en
 *      GitHub Actions, credencial de la API;
 *   4. **solo entonces** se abre una conexión.
 *
 * Códigos de salida: 0 bien o aviso · 1 fallo · 2 requiere atención
 * (`jobs/pipelines/programado.ts`; `deltas` añade el retraso >72 h).
 */
import { sanearTexto } from "./ops/diagnostico.ts";
import { PIPELINES_REGISTRADOS } from "./registro.ts";

async function main(): Promise<void> {
  const nombre = process.argv[2];
  const disponibles = Object.keys(PIPELINES_REGISTRADOS);
  // `Object.hasOwn`: un nombre como `toString` no puede encontrar un método
  // heredado de `Object.prototype` y ejecutarlo como si fuera un pipeline.
  const ejecutar =
    nombre !== undefined && Object.hasOwn(PIPELINES_REGISTRADOS, nombre)
      ? PIPELINES_REGISTRADOS[nombre]
      : undefined;

  if (ejecutar === undefined) {
    console.error(
      `Uso: pnpm job <nombre>\nDisponibles: ${disponibles.join(", ")}\n` +
        "Los demás pipelines siguen bloqueados: registrarlos exige aprobación explícita.",
    );
    process.exitCode = 1;
    return;
  }

  try {
    process.exitCode = await ejecutar(process.env);
  } catch (error) {
    // Guardas, conexión o una excepción fuera del job: nunca se imprime la
    // cadena de conexión ni la clave.
    const m = error instanceof Error ? error.message : String(error);
    console.error(sanearTexto(m));
    if (process.env.GITHUB_ACTIONS === "true") {
      console.log(
        `::error title=${nombre ?? "job"}: no arrancó::${sanearTexto(m).split("\n")[0] ?? ""}`,
      );
    }
    process.exitCode = 1;
  }
}

await main();
