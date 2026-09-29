/**
 * `pnpm seed:verificar <directorio>` — comprueba un crudo del seed (ADR 0009 §4).
 *
 * **0 API y sin base de datos.** Lee el directorio, verifica hashes, formatos,
 * rondas, cursores, instantes y ancla, y calcula la huella del crudo y la huella
 * canónica del catálogo. No necesita ninguna variable de entorno ni credencial.
 *
 * Salida: `0` crudo íntegro · `1` crudo con problemas · `2` uso incorrecto o
 * directorio ilegible.
 */
import { leerDirectorioDelCrudo } from "../jobs/pipelines/seed/crudo/disco.ts";
import {
  describirVerificacion,
  verificarCrudo,
} from "../jobs/pipelines/seed/crudo/verificar.ts";

function principal(argumentos: readonly string[]): number {
  const directorio = argumentos[0];
  if (directorio === undefined || directorio.trim() === "" || argumentos.length !== 1) {
    console.error("Uso: pnpm seed:verificar <directorio del crudo>");
    return 2;
  }
  let contenido;
  try {
    contenido = leerDirectorioDelCrudo(directorio);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const resultado = verificarCrudo(contenido);
  for (const linea of describirVerificacion(resultado)) console.log(linea);
  if (resultado.ok && resultado.crudo !== null && !resultado.crudo.cargable) {
    console.log("⚠️  Íntegro pero NO cargable: la captura terminó failed.");
  }
  return resultado.ok ? 0 : 1;
}

process.exitCode = principal(process.argv.slice(2));
