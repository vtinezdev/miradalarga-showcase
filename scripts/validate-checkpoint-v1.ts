/**
 * ¿Se porta Neon como el checkpoint persistente necesita? **Medirlo, no
 * suponerlo** (ADR 0006).
 *
 *   pnpm db:validate:checkpoint            todas las comprobaciones y limpieza
 *   pnpm db:validate:checkpoint --limpiar  solo la limpieza, para recuperar un fallo
 *
 * Los tests offline prueban la lógica con un doble. Esto prueba lo que solo el
 * servidor puede decir, con **dos sesiones reales**: la de ops (lock y cuota) y
 * la de datos (páginas y checkpoint).
 *
 *   1. El checkpoint existe desde el `INSERT` y **otra conexión lo ve**.
 *   2. Checkpoint y datos se confirman juntos y **se revierten juntos**.
 *   3. `requests_made` **no** se revierte con la transacción de datos.
 *   4. En el orden del pipeline —reservar, pedir, escribir la página,
 *      confirmar, reservar la siguiente— **nadie espera a nadie**. Y, medido
 *      aparte, que una reserva hecha con el checkpoint sin confirmar **sí**
 *      esperaría: es la razón de ese orden.
 *   5. Una huérfana conserva su checkpoint y es el que se lee después.
 *   6. **Rastro cero** al terminar.
 *
 * ⚠️ **CERO llamadas a Streaming Availability.** No importa `transporte.ts` ni
 * toca la red: solo base de datos.
 *
 * ⚠️ **Nunca escribe filas de `deltas`.** Usa el pipeline `seed`, marcado con
 * su `commit_sha`: si la limpieza fallara, un checkpoint suelto bajo `deltas`
 * cambiaría la ventana de la siguiente ejecución real. Bajo `seed` no lo lee
 * nadie. Lo comprueba al terminar.
 *
 * ⚠️ Confirma escrituras a propósito —demostrar que un `COMMIT` es visible
 * desde otra sesión exige confirmarlo—. Si el proceso muere a mitad, quedan
 * filas: el script lo dice y `--limpiar` las recupera.
 */
import { Client, neonConfig } from "@neondatabase/serverless";

import { escribirCheckpoint, leerUltimoCheckpoint } from "../jobs/ops/checkpoint.ts";
import type { EjecutorSql, Presupuesto } from "../jobs/ops/contratos.ts";
import { ejecutarJob, leerPresupuesto } from "../jobs/ops/index.ts";
import type { CheckpointDeDeltas } from "../jobs/pipelines/deltas/checkpoint.ts";
import {
  checkpointInicial,
  planificarDesde,
} from "../jobs/pipelines/deltas/checkpoint.ts";
import { ventanaDesdeSegundos } from "../jobs/pipelines/deltas/manifiesto.ts";
import { compararCheckpoints, describirId, mismoRunId } from "./comparar-checkpoint.ts";

/** Marca de las filas de este script. Nada fuera de ella se toca jamás. */
const MARCA = "validate-checkpoint-v1";
const PIPELINE = "seed" as const;

let fallos = 0;
let pruebas = 0;

function bien(d: string): void {
  pruebas++;
  console.log(`  ✅ ${d}`);
}
function mal(d: string, esperado: string, observado: string): void {
  pruebas++;
  fallos++;
  console.log(`  ❌ ${d} — esperado ${esperado}, observado ${observado}`);
}
function comprobar(d: string, ok: boolean, esperado: string, observado: string): void {
  if (ok) bien(d);
  else mal(d, esperado, observado);
}
function seccion(t: string): void {
  console.log(`\n${t}`);
}
function sanearCredenciales(m: string): string {
  return m
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "<cadena de conexión redactada>")
    .replace(/(['"])[^'"]*\1/g, "'<redactado>'");
}

function avisoDeEstadoResidual(): void {
  console.error(
    "\n⚠️  PUEDE HABER QUEDADO ESTADO DE PRUEBA EN drizzle-schema-v1-test.\n" +
      "    Este script confirma sus escrituras a propósito, así que un fallo\n" +
      "    posterior a un COMMIT deja filas. No se oculta: límpialas con\n" +
      "\n        pnpm db:validate:checkpoint --limpiar\n",
  );
}

function envolver(cliente: Client): EjecutorSql {
  return {
    async ejecutar<T>(texto: string, valores: readonly unknown[] = []) {
      const r: { rows: unknown[] } = await cliente.query(texto, [...valores]);
      return r.rows as readonly T[];
    },
  };
}

/**
 * ¿El checkpoint leído de Neon es el esperado? Validado con el schema v1 y
 * comparado campo a campo (`comparar-checkpoint.ts`): `jsonb` reordena las
 * claves, y un `JSON.stringify` compararía la forma, no el significado.
 */
function mismo(observado: unknown, esperado: CheckpointDeDeltas): boolean {
  return compararCheckpoints(esperado, observado).iguales;
}

/** Qué campo difiere, para el informe. Nunca el volcado entero. */
function diferencia(observado: unknown, esperado: CheckpointDeDeltas): string {
  const c = compararCheckpoints(esperado, observado);
  return c.iguales ? "idéntico" : c.diferencias.join(" | ");
}

/** Espera a que una promesa gane o a que venza el plazo. Sin bucles de sondeo. */
async function conPlazo<T>(
  promesa: Promise<T>,
  ms: number,
): Promise<{ readonly vencio: boolean }> {
  let temporizador: ReturnType<typeof setTimeout> | undefined;
  const plazo = new Promise<"plazo">((resolver) => {
    temporizador = setTimeout(() => {
      resolver("plazo");
    }, ms);
  });
  try {
    const quien = await Promise.race([promesa.then(() => "promesa" as const), plazo]);
    return { vencio: quien === "plazo" };
  } finally {
    if (temporizador !== undefined) clearTimeout(temporizador);
  }
}

/** Tres checkpoints v1 distintos: el de nacer, uno confirmado y uno revertido. */
function checkpoints(): readonly [
  CheckpointDeDeltas,
  CheckpointDeDeltas,
  CheckpointDeDeltas,
] {
  const ventana = { from: 1_790_000_000, to: 1_790_086_400 };
  const c0 = checkpointInicial({ ventana, tipos: ["removed", "new"] });
  const c1: CheckpointDeDeltas = {
    ...c0,
    pendiente: { changeType: "new", cursorDeEntrada: null },
    paginasConfirmadas: 1,
  };
  const c2: CheckpointDeDeltas = {
    ...c1,
    pendiente: { changeType: "new", cursorDeEntrada: "1790000000:42" },
    ultimoTimestampConfirmado: "2026-09-23T09:00:00.000Z",
    paginasConfirmadas: 2,
  };
  return [c0, c1, c2];
}

async function principal(): Promise<void> {
  const soloLimpieza = process.argv.includes("--limpiar");

  // Las mismas guardas que la migración: directa sin -pooler, hostname exacto
  // y MIGRATION_TARGET. `production` es inalcanzable por construcción.
  const { verificarDestino } = await import("../drizzle.migrate.config.ts");
  const destino = verificarDestino();

  if (typeof WebSocket === "undefined") {
    throw new Error(
      "Este Node no expone WebSocket global, y hacen falta sesiones reales.",
    );
  }
  neonConfig.webSocketConstructor = WebSocket;

  console.log("VALIDACIÓN DEL CHECKPOINT PERSISTENTE (ADR 0006)\n");
  console.log(`  hostname          ${destino.hostname}`);
  console.log(`  conexión directa  sí (sin "-pooler")`);
  console.log(`  MIGRATION_TARGET  ${destino.rama}`);
  console.log(`  red externa       ninguna · cero requests a la API`);
  console.log(`  pipeline          ${PIPELINE} (nunca deltas) · marca ${MARCA}`);

  // Dos sesiones: ops (A) y datos (B), como el job real.
  const clienteA = new Client(destino.url);
  const clienteB = new Client(destino.url);
  clienteA.on("error", () => undefined);
  clienteB.on("error", () => undefined);
  try {
    await clienteA.connect();
    await clienteB.connect();
  } catch (error) {
    const m = error instanceof Error ? error.message : String(error);
    throw new Error(`No se pudieron abrir las sesiones: ${sanearCredenciales(m)}`);
  }
  const ops = envolver(clienteA);
  const datos = envolver(clienteB);

  const idDeGenero = (n: number) => `${MARCA}:${String(n)}`;

  async function limpiar(): Promise<{ filas: number; generos: number }> {
    const generos = await ops.ejecutar<{ id: string }>(
      `DELETE FROM external_genres WHERE id LIKE $1 RETURNING id`,
      [`${MARCA}:%`],
    );
    const filas = await ops.ejecutar<{ id: number }>(
      `DELETE FROM ops_sync_runs WHERE commit_sha = $1 RETURNING id`,
      [MARCA],
    );
    return { filas: filas.length, generos: generos.length };
  }

  async function rastro(): Promise<{ filas: number; generos: number }> {
    const f = await ops.ejecutar<{ n: number }>(
      `SELECT count(*)::int AS n FROM ops_sync_runs WHERE commit_sha = $1`,
      [MARCA],
    );
    const g = await ops.ejecutar<{ n: number }>(
      `SELECT count(*)::int AS n FROM external_genres WHERE id LIKE $1`,
      [`${MARCA}:%`],
    );
    return { filas: f[0]?.n ?? -1, generos: g[0]?.n ?? -1 };
  }

  /** La fila vista desde una conexión concreta: es lo que se está midiendo. */
  async function filaDesde(ejecutor: EjecutorSql, id: number) {
    const r = await ejecutor.ejecutar<{
      status: string;
      requests_made: number;
      checkpoint: unknown;
    }>(`SELECT status, requests_made, checkpoint FROM ops_sync_runs WHERE id = $1`, [
      id,
    ]);
    return r[0];
  }

  async function hayGenero(ejecutor: EjecutorSql, n: number): Promise<boolean> {
    const r = await ejecutor.ejecutar<{ n: number }>(
      `SELECT count(*)::int AS n FROM external_genres WHERE id = $1`,
      [idDeGenero(n)],
    );
    return (r[0]?.n ?? 0) === 1;
  }

  const filasDeDeltas = async (): Promise<number> =>
    (
      await ops.ejecutar<{ n: number }>(
        `SELECT count(*)::int AS n FROM ops_sync_runs WHERE pipeline = 'deltas'`,
      )
    )[0]?.n ?? -1;

  if (soloLimpieza) {
    seccion("Limpieza explícita");
    const borrado = await limpiar();
    console.log(
      `  ${String(borrado.filas)} filas y ${String(borrado.generos)} géneros borrados`,
    );
    const resto = await rastro();
    comprobar(
      "no queda nada de este script",
      resto.filas === 0 && resto.generos === 0,
      "0 y 0",
      JSON.stringify(resto),
    );
    await clienteA.end();
    await clienteB.end();
    if (fallos > 0) process.exitCode = 1;
    return;
  }

  let hayEstadoConfirmado = false;
  const deltasAlEmpezar = await filasDeDeltas();

  try {
    seccion("0 · Punto de partida");
    const inicio = await rastro();
    comprobar(
      "no hay restos de ejecuciones anteriores de este script",
      inicio.filas === 0 && inicio.generos === 0,
      "0 y 0",
      `${JSON.stringify(inicio)} — lanza --limpiar`,
    );

    // Solo lectura: lo que haría HOY la próxima `deltas` real. No es una
    // comprobación, es información para decidir la siguiente autorización.
    try {
      const ultimo = await leerUltimoCheckpoint(ops, "deltas");
      const plan = planificarDesde({
        ultimo,
        ahora: new Date(),
        sinCheckpoint: "ventana_de_validacion",
        tipos: ["removed", "new"],
      });
      const v = ventanaDesdeSegundos(plan.ventana);
      console.log(
        `  ℹ️  próxima deltas real: ${ultimo === null ? "sin checkpoint → ventana de validación" : `último checkpoint en la fila ${String(ultimo.runId)}`}`,
      );
      console.log(`      ${v.desde.toISOString()} → ${v.hasta.toISOString()}`);
    } catch (error) {
      const m = error instanceof Error ? error.message : String(error);
      console.log(`  ℹ️  próxima deltas real: NO ARRANCARÍA — ${m}`);
    }

    const presupuesto: Presupuesto = leerPresupuesto({
      STREAMING_API_MONTHLY_BUDGET: "1000",
      STREAMING_API_MONTHLY_PIPELINE_BUDGETS: "seed=900",
      STREAMING_API_PER_RUN_CAPS: "seed=900",
    });
    const [c0, c1, c2] = checkpoints();

    let runId = -1;
    const resultado = await ejecutarJob(
      ops,
      {
        pipeline: PIPELINE,
        presupuesto,
        commitSha: MARCA,
        checkpointInicial: () => Promise.resolve(c0),
      },
      async (ctx) => {
        runId = ctx.runId;
        hayEstadoConfirmado = true;

        // ── 1 ────────────────────────────────────────────────────────────
        seccion("1 · El checkpoint nace con la fila");
        const alNacer = await filaDesde(datos, runId);
        comprobar(
          "la conexión de DATOS ve el checkpoint inicial antes de ninguna reserva",
          mismo(alNacer?.checkpoint, c0) && alNacer?.requests_made === 0,
          "c0 y 0 requests",
          `${diferencia(alNacer?.checkpoint, c0)} · ${String(alNacer?.requests_made)}`,
        );

        // ── 2 ────────────────────────────────────────────────────────────
        seccion("2 · Una página confirmada: datos y checkpoint juntos");
        await ctx.pedirCuota();
        await datos.ejecutar("BEGIN");
        await datos.ejecutar(`INSERT INTO external_genres (id, name) VALUES ($1, $2)`, [
          idDeGenero(1),
          "confirmado",
        ]);
        await escribirCheckpoint(datos, runId, c1);
        await datos.ejecutar("COMMIT");
        const trasCommit = await filaDesde(ops, runId);
        comprobar(
          "la conexión de OPS ve el checkpoint confirmado por la de datos",
          mismo(trasCommit?.checkpoint, c1),
          "c1",
          diferencia(trasCommit?.checkpoint, c1),
        );
        comprobar(
          "y ve los datos de la misma transacción",
          await hayGenero(ops, 1),
          "el género 1",
          "ausente",
        );
        comprobar(
          "requests_made cuenta la reserva",
          trasCommit?.requests_made === 1,
          "1",
          String(trasCommit?.requests_made),
        );

        // ── 3 ────────────────────────────────────────────────────────────
        seccion("3 · Una página revertida: datos y checkpoint se van juntos");
        await ctx.pedirCuota();
        await datos.ejecutar("BEGIN");
        await datos.ejecutar(`INSERT INTO external_genres (id, name) VALUES ($1, $2)`, [
          idDeGenero(2),
          "revertido",
        ]);
        await escribirCheckpoint(datos, runId, c2);

        // Con la transacción abierta: la otra sesión lee lo confirmado, y lo
        // lee SIN esperar —MVCC—, que es lo que hace `reservar()` al sumar.
        const lectura = filaDesde(ops, runId);
        const lecturaEspera = await conPlazo(lectura, 3000);
        const aMitad = await lectura;
        comprobar(
          "leer la fila desde ops no espera a la transacción abierta",
          !lecturaEspera.vencio,
          "respuesta inmediata",
          "bloqueada 3 s",
        );
        comprobar(
          "y ve el checkpoint confirmado, no el que está a medio escribir",
          mismo(aMitad?.checkpoint, c1),
          "c1",
          diferencia(aMitad?.checkpoint, c1),
        );

        await datos.ejecutar("ROLLBACK");
        const trasRollback = await filaDesde(ops, runId);
        comprobar(
          "tras el ROLLBACK el checkpoint sigue en c1: no avanzó",
          mismo(trasRollback?.checkpoint, c1),
          "c1",
          diferencia(trasRollback?.checkpoint, c1),
        );
        comprobar(
          "y los datos de esa página tampoco existen",
          !(await hayGenero(ops, 2)),
          "sin género 2",
          "presente",
        );
        comprobar(
          "requests_made NO se revierte: las 2 reservas siguen contadas",
          trasRollback?.requests_made === 2,
          "2",
          String(trasRollback?.requests_made),
        );

        // ── 4 ────────────────────────────────────────────────────────────
        seccion("4 · Sin bloqueos cruzados entre ops y datos");
        let esperas = 0;
        for (let pagina = 0; pagina < 3; pagina++) {
          // El orden del pipeline: reservar (ops) → página (datos) → COMMIT.
          if ((await conPlazo(ctx.pedirCuota(), 5000)).vencio) esperas++;
          await datos.ejecutar("BEGIN");
          await escribirCheckpoint(datos, runId, c1);
          await datos.ejecutar("COMMIT");
        }
        comprobar(
          "en el orden del pipeline, 3 páginas seguidas sin una sola espera",
          esperas === 0,
          "0 esperas",
          String(esperas),
        );

        // Medido aparte, a propósito: reservar CON el checkpoint sin
        // confirmar. Es el orden que el pipeline no usa nunca, y aquí se ve por
        // qué: el UPDATE de requests_made espera al lock de fila de la otra
        // sesión. No es un interbloqueo —la de datos no espera a nadie—, pero
        // en un solo proceso sí lo sería.
        await datos.ejecutar("BEGIN");
        await escribirCheckpoint(datos, runId, c2);
        const reservaDentro = ctx.pedirCuota();
        const dentro = await conPlazo(reservaDentro, 1500);
        comprobar(
          "una reserva con el checkpoint SIN confirmar espera al lock de fila",
          dentro.vencio,
          "bloqueada 1,5 s",
          "continuó",
        );
        await datos.ejecutar("ROLLBACK");
        const libre = await conPlazo(reservaDentro, 5000);
        await reservaDentro;
        comprobar(
          "y continúa en cuanto la de datos termina: se espera, no se interbloquea",
          !libre.vencio,
          "desbloqueada",
          "sigue esperando",
        );
        const tras4 = await filaDesde(datos, runId);
        comprobar(
          "la contabilidad cuadra: 2 + 3 + 1 = 6 requests",
          tras4?.requests_made === 6,
          "6",
          String(tras4?.requests_made),
        );
      },
    );

    comprobar(
      "la ejecución cierra succeeded",
      resultado.ejecutado && resultado.estado === "succeeded",
      "succeeded",
      JSON.stringify(resultado.ejecutado ? resultado.estado : resultado),
    );
    const cerrada = await filaDesde(datos, runId);
    comprobar(
      "al cerrar, la fila conserva el último checkpoint CONFIRMADO",
      mismo(cerrada?.checkpoint, c1),
      "c1",
      diferencia(cerrada?.checkpoint, c1),
    );

    let rechazada = false;
    try {
      await escribirCheckpoint(datos, runId, c2);
    } catch {
      rechazada = true;
    }
    comprobar(
      "sobre una fila ya cerrada, avanzar el checkpoint se rechaza",
      rechazada,
      "una excepción",
      "se escribió",
    );

    // ── 5 ──────────────────────────────────────────────────────────────────
    seccion("5 · Una huérfana conserva su checkpoint");
    const insertada = await ops.ejecutar<{ id: number }>(
      `INSERT INTO ops_sync_runs
         (pipeline, status, started_at, requests_made, budget_limit, commit_sha, checkpoint)
       VALUES ($1, 'running', now(), 3, 900, $2, $3::jsonb) RETURNING id`,
      [PIPELINE, MARCA, JSON.stringify(c2)],
    );
    const idHuerfana = insertada[0]?.id ?? -1;

    let leidoAlPlanificar: { runId: number; checkpoint: unknown } | null = null;
    await ejecutarJob(
      ops,
      {
        pipeline: PIPELINE,
        presupuesto,
        commitSha: MARCA,
        async checkpointInicial(ejecutor) {
          leidoAlPlanificar = await leerUltimoCheckpoint(ejecutor, PIPELINE);
          return c0;
        },
      },
      () => Promise.resolve(),
    );
    const huerfana = await filaDesde(datos, idHuerfana);
    comprobar(
      "la huérfana queda en failed…",
      huerfana?.status === "failed",
      "failed",
      String(huerfana?.status),
    );
    comprobar(
      "…con su checkpoint intacto y sus 3 requests",
      mismo(huerfana?.checkpoint, c2) && huerfana?.requests_made === 3,
      "c2 y 3",
      `${diferencia(huerfana?.checkpoint, c2)} · ${String(huerfana?.requests_made)}`,
    );
    const leido = leidoAlPlanificar as { runId: number; checkpoint: unknown } | null;
    // ⚠️ `idHuerfana` viene de un `RETURNING id` sobre `bigint`: el driver lo
    // da como TEXTO ("33"), y `leerUltimoCheckpoint` como número (33). Se
    // comparan como ids, no con `===` (falso negativo del 2026-09-23).
    comprobar(
      "y es el checkpoint que lee la ejecución siguiente al planificar",
      mismoRunId(leido?.runId, idHuerfana) && mismo(leido?.checkpoint, c2),
      `fila ${describirId(idHuerfana)} con c2`,
      `fila ${describirId(leido?.runId)} · ${diferencia(leido?.checkpoint, c2)}`,
    );
  } finally {
    seccion("6 · Limpieza y rastro");
    try {
      const borrado = await limpiar();
      console.log(
        `     ${String(borrado.filas)} filas y ${String(borrado.generos)} géneros borrados`,
      );
      const resto = await rastro();
      comprobar(
        "rastro cero: ni filas ni datos de este script",
        resto.filas === 0 && resto.generos === 0,
        "0 y 0",
        JSON.stringify(resto),
      );
      const deltasAlTerminar = await filasDeDeltas();
      comprobar(
        "las filas de deltas no se han tocado",
        deltasAlTerminar === deltasAlEmpezar,
        String(deltasAlEmpezar),
        String(deltasAlTerminar),
      );
      hayEstadoConfirmado = false;
    } catch (error) {
      const m = error instanceof Error ? error.message : String(error);
      console.error(`  ❌ la limpieza falló: ${sanearCredenciales(m)}`);
      fallos++;
    }
    if (hayEstadoConfirmado) avisoDeEstadoResidual();
    await clienteA.end();
    await clienteB.end();
  }

  console.log("");
  if (fallos === 0)
    console.log(`✅ ${String(pruebas)} comprobaciones, todas correctas.`);
  else {
    console.log(`❌ ${String(fallos)} de ${String(pruebas)} comprobaciones fallaron.`);
    process.exitCode = 1;
  }
}

principal().catch((error: unknown) => {
  const crudo = error instanceof Error ? error.message : String(error);
  console.error(`\n${sanearCredenciales(crudo)}\n`);
  avisoDeEstadoResidual();
  process.exitCode = 1;
});
