/**
 * `pnpm production:compuerta <crudo>` — **¿puede este crudo ir a
 * `production`?** (ADR 0010). **0 API, sin base, sin escrituras.**
 *
 * Comprueba, sin conectar a nada, lo mismo que `production:cargar` antes de
 * abrir un socket: el crudo verifica y es cargable, es real, tiene sus dos
 * copias (una fuera del equipo), la rama del seed real lo aceptó (recibo) y
 * **M4, recalculado** desde los crudos del primer `deltas`, no lo refuta.
 *
 * Si todo pasa, imprime **las entradas de `AUTORIZACIONES_DE_PRODUCTION`**
 * atadas a su huella, listas para el commit de aprobación. No las escribe:
 * autorizar es una decisión humana, en un diff revisable.
 *
 * Salida: `0` compuerta abierta · `1` cerrada.
 */
import { resolve } from "node:path";

import { AUTORIZACIONES_DE_PRODUCTION } from "../jobs/ops/autorizacion-de-production.ts";
import { comprobarCopias } from "../jobs/pipelines/seed/crudo/copias.ts";
import { vencimientoDelAncla } from "../jobs/pipelines/seed/ancla.ts";
import { compuertaDesdeDisco } from "./production-comun.ts";
import { crudoCargable } from "./seed-comun.ts";

function principal(argumentos: readonly string[]): number {
  const directorio = argumentos[0];
  if (directorio === undefined || argumentos.length !== 1 || directorio.trim() === "") {
    console.error("Uso: pnpm production:compuerta <directorio del crudo>");
    return 1;
  }
  console.log("PRODUCTION:COMPUERTA — 0 API, sin base\n");
  const dir = resolve(directorio);
  const crudo = crudoCargable(dir);
  const problemas: string[] = [];
  const copias = comprobarCopias(dir);
  console.log(
    `  copias            ${String(copias.copiasValidas)} verificadas · ${String(copias.fueraDelEquipo)} fuera del equipo`,
  );
  problemas.push(...copias.problemas);
  const c = compuertaDesdeDisco(dir, crudo);
  console.log(`  M4 recalculado    ${JSON.stringify(c.m4Recalculado)}`);
  problemas.push(...c.problemas);

  console.log(`  huella del crudo  ${crudo.huella}`);
  console.log(`  S (ancla)         ${crudo.ancla.toISOString()}`);
  console.log(`  vence             ${vencimientoDelAncla(crudo.ancla).toISOString()}`);
  if (problemas.length > 0) {
    console.log("\n  ⛔ compuerta CERRADA:");
    for (const p of problemas) console.log(`    ✗ ${p}`);
    return 1;
  }
  const ya = AUTORIZACIONES_DE_PRODUCTION.filter(
    (a) => a.huellaDelCrudo === crudo.huella,
  );
  console.log(
    `\n  ✅ compuerta ABIERTA · autorizaciones ya presentes para esta huella: ${String(ya.length)}`,
  );
  console.log(
    "\n  Entradas para AUTORIZACIONES_DE_PRODUCTION (jobs/ops/autorizacion-de-production.ts),\n" +
      "  SOLO tras la aprobación explícita:\n",
  );
  for (const operacion of ["cargar", "primer_deltas"]) {
    console.log(
      `    {\n      operacion: "${operacion}",\n      huellaDelCrudo: "${crudo.huella}",\n` +
        `      aprobadaEl: "<AAAA-MM-DD>",\n      referencia: "<aprobacion-production-${crudo.plan.capturaId}>",\n    },`,
    );
  }
  return 0;
}

try {
  process.exitCode = principal(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
