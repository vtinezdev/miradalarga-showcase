/**
 * `pnpm seed:capturar --real <plan.json> <directorio de M1>` y
 * `pnpm seed:capturar --reanudar <directorio del crudo> <directorio de M1>` —
 * **la captura real del seed** (ADR 0009 §1, §4, §5, §7). **Gasta cuota.**
 *
 * **Antes de abrir un socket:** el destino es **solo** la rama limpia del seed
 * real (`seed-real-v1-test`: hostname exacto, conexión directa, régimen
 * estricto); la credencial está y no hay overrides de presupuesto ni de host;
 * el plan es v1, real y trae las decisiones de M1; **M1 verifica**, es
 * utilizable y su huella es la del plan; y existe la **autorización del seed
 * para la fase `captura` en el ciclo actual** (`AUTORIZACIONES_DEL_SEED`).
 *
 * **Con la conexión:** migraciones exactamente `0000`–`0004`; `T0` =
 * `clock_timestamp()` del servidor inmediatamente antes de la primera reserva
 * (`m1_caducada` si no es el ciclo siguiente al de M1). **Una sola conexión, la
 * de ops**: la captura no escribe ni una fila de catálogo.
 *
 * **Al terminar:** `seed:verificar` sobre el crudo escrito y un barrido de la
 * credencial en cada fichero. El crudo queda en `.seed-runs/<capturaId>/` y su
 * diario en `.seed-runs/<capturaId>.diario/`.
 *
 * Salida (ADR 0009 §5): `0` succeeded · `1` failed o precondición incumplida ·
 * `2` budget_stopped por cualquier motivo —no hay cron que reanude— o lock.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  autorizacionVigente,
  presupuestoDelSeed,
} from "../jobs/ops/autorizacion-del-seed.ts";
import type { Conexion } from "../jobs/ops/conexion.ts";
import { calcularCiclo, leerPresupuesto } from "../jobs/ops/presupuesto.ts";
import { regimenDelDestino } from "../jobs/pipelines/arranque.ts";
import { ejecutarCaptura } from "../jobs/pipelines/seed/captura.ts";
import {
  crearAlmacenEnDisco,
  directorioDelDiario,
} from "../jobs/pipelines/seed/crudo/almacen.ts";
import { leerDirectorioDelCrudo } from "../jobs/pipelines/seed/crudo/disco.ts";
import type { PlanDelSeed } from "../jobs/pipelines/seed/crudo/formato.ts";
import { FICHERO_DEL_PLAN, planV1 } from "../jobs/pipelines/seed/crudo/formato.ts";
import {
  describirVerificacion,
  verificarCrudo,
} from "../jobs/pipelines/seed/crudo/verificar.ts";
import { PREFIJO_DE_ENSAYO } from "../jobs/pipelines/seed/ensayo.ts";
import { crearFuenteReal } from "../jobs/pipelines/seed/fuente-real.ts";
import { verificarM1 } from "../jobs/pipelines/seed/m1.ts";
import {
  DIRECTORIO_DE_CRUDOS,
  commitActual,
  credencialSinOverrides,
  exigirSinCredencial,
  externosDeM1,
  relojDelServidor,
  relojDesplazado,
} from "./seed-api-comun.ts";
import { comprobarMigraciones } from "./seed-comun.ts";

function leerPlan(ruta: string): PlanDelSeed {
  const plan = planV1.parse(JSON.parse(readFileSync(ruta, "utf8")));
  if (plan.capturaId.startsWith(PREFIJO_DE_ENSAYO))
    throw new Error("Es un plan de ensayo.");
  if (plan.m1.huellaDelResultado === undefined || plan.m1.decisiones === undefined) {
    throw new Error(
      "El plan no lleva el resultado de M1 (huella y decisiones): no es un plan real.",
    );
  }
  return plan;
}

async function principal(argumentos: readonly string[]): Promise<number> {
  const [modo, objetivo, dirM1] = argumentos;
  if (
    (modo !== "--real" && modo !== "--reanudar") ||
    objetivo === undefined ||
    dirM1 === undefined ||
    argumentos.length !== 3
  ) {
    console.error(
      "Uso: pnpm seed:capturar --real <plan.json> <directorio de M1>\n" +
        "     pnpm seed:capturar --reanudar <directorio del crudo> <directorio de M1>",
    );
    return 1;
  }
  const reanudar = modo === "--reanudar";
  console.log(`SEED:CAPTURAR ${modo} — GASTA CUOTA\n`);

  // ── Guardas sin red ──────────────────────────────────────────────────────
  const clave = credencialSinOverrides();
  const { RAMA_DEL_SEED_REAL, verificarDestino } =
    await import("../drizzle.migrate.config.ts");
  const destino = verificarDestino(process.env, [RAMA_DEL_SEED_REAL]);
  if (regimenDelDestino(destino.rama) !== "bootstrap_del_seed") {
    throw new Error(`${destino.rama} no está en el régimen estricto.`);
  }
  const plan = reanudar
    ? leerPlan(join(resolve(objetivo), FICHERO_DEL_PLAN))
    : leerPlan(resolve(objetivo));
  const directorio = reanudar
    ? resolve(objetivo)
    : join(DIRECTORIO_DE_CRUDOS, plan.capturaId);
  if (
    !reanudar &&
    (existsSync(directorio) || existsSync(directorioDelDiario(directorio)))
  ) {
    throw new Error(
      `Ya existe ${directorio}: una captura nueva empieza en un directorio vacío.`,
    );
  }
  if (reanudar && !existsSync(directorioDelDiario(directorio))) {
    throw new Error("Sin el diario de la captura no se reanuda (crudo_incoherente).");
  }
  const m1 = verificarM1(leerDirectorioDelCrudo(resolve(dirM1)), externosDeM1());
  if (!m1.ok || !m1.utilizable || m1.resultado === null) {
    throw new Error(`M1 no verifica o no es utilizable: ${m1.problemas.join("; ")}`);
  }
  if (
    m1.huella !== plan.m1.huellaDelResultado ||
    m1.resultado.runId !== plan.m1.runId ||
    m1.resultado.cicloClave !== plan.m1.cicloClave
  ) {
    throw new Error(
      "El M1 dado no es el que respalda el plan (huella, fila o ciclo distintos).",
    );
  }
  const base = leerPresupuesto({});
  const autorizacion = autorizacionVigente("captura", new Date(), base.diaDeCiclo);
  if (autorizacion === null) {
    console.error(
      "❌ Sin autorización del seed para la fase captura en el ciclo actual " +
        `(${String(calcularCiclo(new Date(), base.diaDeCiclo).clave)}). 0 requests.`,
    );
    return 1;
  }
  console.log(`  destino           ${destino.rama} (${destino.hostname})`);
  console.log(
    `  plan              ${plan.capturaId} · M1 fila ${plan.m1.runId}, ciclo ${String(plan.m1.cicloClave)}`,
  );
  console.log(
    `  autorización      ciclo ${String(autorizacion.ciclo)} · tope ${String(autorizacion.tope)} · techo ${String(autorizacion.techo)}`,
  );
  console.log(`  directorio        ${directorio}\n`);

  // ── Con conexión: una sola, la de ops ─────────────────────────────────────
  const { conectar } = await import("../jobs/ops/conexion.ts");
  let conexion: Conexion | null = null;
  let salida;
  try {
    conexion = await conectar(destino.url);
    const ops = conexion.ejecutor;
    const migraciones = await comprobarMigraciones(ops);
    if (!migraciones.exactas) {
      console.error(`❌ Migraciones: ${migraciones.problemas.join("; ")}`);
      return 1;
    }
    const reloj = await relojDesplazado(ops);
    salida = await ejecutarCaptura({
      ejecutorOps: ops,
      presupuesto: presupuestoDelSeed(base, "captura", reloj()),
      plan,
      fuente: crearFuenteReal({ apiKey: clave }),
      almacen: crearAlmacenEnDisco(directorio),
      reloj,
      relojDeT0: () => relojDelServidor(ops),
      destino: destino.rama,
      commitSha: commitActual(),
      reanudar,
      comprobarCuotaDelProveedor: true,
    });
  } finally {
    await conexion?.cerrar();
  }

  const r = salida.resultado;
  if (!r.ejecutado) {
    console.log(`⚠️  No se ejecutó: ${r.motivo}.`);
    return 2;
  }
  console.log(
    `  ops_sync_runs ${String(r.runId)} · ${r.estado} · ${JSON.stringify(r.metricas.errorSamples[0] ?? {})}`,
  );
  if (salida.reanudacion !== null)
    console.log(`  reanudación ${JSON.stringify(salida.reanudacion)}`);
  if (salida.manifiesto === null) {
    console.log("  La captura no llegó a empezar: el crudo no se ha tocado.");
    return r.estado === "budget_stopped" ? 2 : 1;
  }
  const contenido = leerDirectorioDelCrudo(directorio);
  exigirSinCredencial(contenido, clave);
  const v = verificarCrudo(contenido);
  console.log("");
  for (const linea of describirVerificacion(v)) console.log(`  ${linea}`);
  const cuota = salida.manifiesto.paginas.at(-1)?.cuota;
  if (cuota != null) {
    console.log(
      `  proveedor ${String(cuota.usada)} / ${String(cuota.concedida)} · reinicia ${cuota.reinicio}`,
    );
  }
  if (!v.ok) return 1;
  if (r.estado === "succeeded" || v.crudo?.cargable === true) {
    console.log(
      "\n  Siguiente: dos copias verificadas —una fuera del equipo— con `pnpm seed:archivar`, " +
        "y después `pnpm seed:post-captura`. Todo antes de S + 72 h.",
    );
  }
  return r.estado === "succeeded" ? 0 : r.estado === "budget_stopped" ? 2 : 1;
}

principal(process.argv.slice(2)).then(
  (codigo) => {
    process.exitCode = codigo;
  },
  (error: unknown) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
