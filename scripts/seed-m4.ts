/**
 * `pnpm seed:m4 <crudo> <directorio de deltas> [<directorio de deltas>…]` —
 * **M4** (ADR 0009 §7, `jobs/pipelines/seed/m4.ts`). **0 API, sin base**: dos
 * crudos ya guardados, el del seed y el del primer `deltas` de la rama
 * (`.deltas-runs/…-primer-deltas/`; varios si se reanudó).
 *
 * Deja el informe en `.seed-cargas/` y, al lado del crudo, `<capturaId>.m4.json`:
 * es lo que el bloque de `production` tiene que leer antes de cargar ese crudo
 * (`m4PermiteProduction`).
 *
 * Salida: `0` compatible o sin muestras (no bloquea) · `1` **refutado**: el
 * crudo no va a `production` con este ancla · `2` uso o entrada ilegible.
 */
import { writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { m4PermiteProduction } from "../jobs/pipelines/seed/m4.ts";
import { m4DesdeDisco } from "./m4-desde-disco.ts";
import { guardarInforme } from "./seed-comun.ts";

function principal(argumentos: readonly string[]): number {
  const [dirCrudo, ...dirsDeltas] = argumentos;
  if (argumentos.some((x) => x.trim() === "")) {
    console.error("Una ruta vacía resolvería al directorio actual: se niega.");
    return 2;
  }
  if (dirCrudo === undefined || dirsDeltas.length === 0) {
    console.error(
      "Uso: pnpm seed:m4 <crudo> <directorio de deltas> [<directorio de deltas>…]",
    );
    return 2;
  }
  let calculado: ReturnType<typeof m4DesdeDisco>;
  try {
    calculado = m4DesdeDisco(dirCrudo, dirsDeltas);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const { crudo, informe, ventanas } = calculado;
  console.log(`M4 · ${informe.resultado.toUpperCase()}`);
  console.log(
    `  S ${informe.ancla} · T1 ${informe.T1} · margen ${String(informe.margenSegundos)} s`,
  );
  console.log(
    `  avisos ${String(informe.avisosLeidos)} · en [S, T1] ${String(informe.avisosEnVentana)} · sin identidad ` +
      `${String(informe.avisosSinIdentidad)} · sin página ${String(informe.avisosSinPagina)}`,
  );
  console.log(
    `  casos ${JSON.stringify(informe.casos)} · muestras ${String(informe.muestras)}`,
  );
  console.log(
    `  retraso máximo observado ${informe.retrasoMaximoObservadoSegundos === null ? "—" : `${String(informe.retrasoMaximoObservadoSegundos)} s`}`,
  );
  console.log(`  ${informe.nota}`);
  const completo = {
    capturaId: crudo.plan.capturaId,
    huellaDelCrudo: crudo.huella,
    deltas: dirsDeltas.map((d) => basename(resolve(d))),
    ventanas,
    permiteProduction: m4PermiteProduction(informe),
    ...informe,
  };
  const d = resolve(dirCrudo);
  writeFileSync(
    join(dirname(d), `${basename(d)}.m4.json`),
    `${JSON.stringify(completo, null, 2)}\n`,
    "utf8",
  );
  console.log(`  informe: ${guardarInforme("m4", completo)}`);
  return m4PermiteProduction(informe) ? 0 : 1;
}

try {
  process.exitCode = principal(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
