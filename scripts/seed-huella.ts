/**
 * `pnpm production:huella <crudo>` — **la prueba de identidad** del ADR 0009 §9:
 * la huella canónica del catálogo, calculada tres veces, tiene que coincidir.
 *
 *   1. **offline**, desde el crudo (`seed:verificar`);
 *   2. **validación**, la leída de PostgreSQL en la rama del seed real tras su
 *      carga (el recibo de aceptación: después, el primer `deltas` la cambia);
 *   3. **`production`**, leída ahora de PostgreSQL en una transacción
 *      `READ ONLY`.
 *
 * Solo tiene sentido **entre la carga y el primer `deltas`** de `production`:
 * el primer `deltas` cambia el catálogo. **0 API, sin escrituras**, sin
 * autorización en código (es una lectura).
 *
 * Salida: `0` las tres coinciden · `1` no.
 */
import { resolve } from "node:path";

import { conectar } from "../jobs/ops/conexion.ts";
import { huellaCanonicaDelDestino } from "../jobs/pipelines/seed/huella-base.ts";
import { leerReciboDeAceptacion } from "./production-comun.ts";
import { crudoCargable, destinoDelSeed } from "./seed-comun.ts";

async function principal(argumentos: readonly string[]): Promise<number> {
  const directorio = argumentos[0];
  if (directorio === undefined || argumentos.length !== 1 || directorio.trim() === "") {
    console.error("Uso: pnpm production:huella <directorio del crudo>");
    return 1;
  }
  console.log("PRODUCTION:HUELLA — solo lectura, 0 API\n");
  const destino = await destinoDelSeed(true);
  const crudo = crudoCargable(resolve(directorio));
  const recibo = leerReciboDeAceptacion(resolve(directorio));

  const conexion = await conectar(destino.url);
  let deProduction: string;
  try {
    const e = conexion.ejecutor;
    await e.ejecutar("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      deProduction = (await huellaCanonicaDelDestino(e)).huella;
    } finally {
      await e.ejecutar("ROLLBACK");
    }
  } finally {
    await conexion.cerrar();
  }

  const deValidacion =
    recibo !== null && recibo.huella === crudo.huella
      ? recibo.carga.huellaCanonicaLeida
      : null;
  console.log(`\n  1 · crudo (offline)        ${crudo.huellaCanonica}`);
  console.log(
    `  2 · validación (recibo)    ${deValidacion ?? "— sin recibo de este crudo"}`,
  );
  console.log(`  3 · production (ahora)     ${deProduction}`);
  const ok =
    deValidacion === crudo.huellaCanonica && deProduction === crudo.huellaCanonica;
  console.log(`\n  ${ok ? "✅ las tres coinciden" : "❌ NO coinciden"}`);
  return ok ? 0 : 1;
}

principal(process.argv.slice(2)).then(
  (codigo) => {
    process.exitCode = codigo;
  },
  (error: unknown) => {
    console.error(`${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
