/**
 * `pnpm seed:plan <directorio de M1> <capturaId>` — fija el plan de la captura
 * desde un M1 verificado (ADR 0009 §3: «el plan se fija en un commit antes de
 * capturar»). **0 API, sin base.**
 *
 * Escribe en `docs/evidence/seed/`, para versionarlos:
 *
 *   · `<capturaId>.plan.json` — el `plan.json` exacto que la captura escribirá
 *     como primer fichero de su crudo (su sha256 es la huella del plan);
 *   · `<sondaId>.m1.json` — el resultado de M1 tal cual (evaluaciones y
 *     decisiones: **sin contenido del proveedor**; los cuerpos siguen en
 *     `.seed-runs/`).
 *
 * Salida: `0` plan escrito · `1` M1 no verifica o no es utilizable.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { leerDirectorioDelCrudo } from "../jobs/pipelines/seed/crudo/disco.ts";
import { cicloSiguiente } from "../jobs/pipelines/seed/crudo/formato.ts";
import { jsonDeFichero, sha256 } from "../jobs/pipelines/seed/crudo/huella.ts";
import { PREFIJO_DE_ENSAYO } from "../jobs/pipelines/seed/ensayo.ts";
import { FICHERO_DEL_RESULTADO_M1, verificarM1 } from "../jobs/pipelines/seed/m1.ts";
import { construirPlanDesdeM1 } from "../jobs/pipelines/seed/plan.ts";
import { RAIZ, commitActual, externosDeM1 } from "./seed-referencias.ts";

function principal(argumentos: readonly string[]): number {
  const [dirM1, capturaId] = argumentos;
  if (dirM1 === undefined || capturaId === undefined || argumentos.length !== 2) {
    console.error("Uso: pnpm seed:plan <directorio de M1> <capturaId>");
    return 1;
  }
  if (capturaId.startsWith(PREFIJO_DE_ENSAYO)) {
    console.error(`Un plan real no puede llamarse "${PREFIJO_DE_ENSAYO}…".`);
    return 1;
  }
  const v = verificarM1(leerDirectorioDelCrudo(resolve(dirM1)), externosDeM1());
  if (!v.ok || !v.utilizable || v.resultado === null) {
    console.error(
      `M1 no verifica o no es utilizable: ${v.problemas.join("; ") || "incompleto o no succeeded"}`,
    );
    return 1;
  }
  if (v.resultado.sondaId.startsWith(PREFIJO_DE_ENSAYO)) {
    console.error("Un M1 de ensayo no respalda un plan real.");
    return 1;
  }
  const plan = construirPlanDesdeM1(v, { capturaId, commit: commitActual() });
  const destino = join(RAIZ, "docs", "evidence", "seed");
  mkdirSync(destino, { recursive: true });
  const rutaPlan = join(destino, `${capturaId}.plan.json`);
  if (existsSync(rutaPlan)) {
    console.error(`Ya existe ${rutaPlan}: un plan fijado no se reescribe.`);
    return 1;
  }
  const texto = jsonDeFichero(plan);
  writeFileSync(rutaPlan, texto, "utf8");
  copyFileSync(
    join(resolve(dirM1), FICHERO_DEL_RESULTADO_M1),
    join(destino, `${v.resultado.sondaId}.m1.json`),
  );
  console.log(`plan        ${rutaPlan}`);
  console.log(`huella      ${sha256(texto)}`);
  console.log(
    `M1          fila ${v.resultado.runId} · ciclo ${String(v.resultado.cicloClave)} · huella ${v.huella ?? "—"}`,
  );
  for (const d of plan.m1.decisiones ?? []) {
    console.log(
      `  ${d.plataforma.padEnd(12)} ${d.orderBy.padEnd(19)} ${d.fuente} · ${d.motivo}`,
    );
  }
  console.log(
    `\n⚠️  La captura tiene que EMPEZAR en el ciclo ${String(cicloSiguiente(v.resultado.cicloClave))}, ` +
      "con su autorización (≤ 450) en AUTORIZACIONES_DEL_SEED. Si no, M1 caduca y se repite.",
  );
  return 0;
}

process.exitCode = principal(process.argv.slice(2));
