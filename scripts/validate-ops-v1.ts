/**
 * ¿Se comporta Neon como PostgreSQL 18.6 estándar donde este diseño lo
 * necesita? **Medirlo, no suponerlo.**
 *
 *   pnpm db:validate:ops            todas las comprobaciones y limpieza
 *   pnpm db:validate:ops --limpiar  solo la limpieza, para recuperar un fallo
 *
 * Todo `jobs/ops/` descansa en tres afirmaciones que ningún test offline puede
 * probar, porque no son sobre nuestro código sino sobre el servidor:
 *
 *   1. `pg_advisory_xact_lock` **serializa de verdad** dos transacciones, que
 *      es lo único que impide que dos jobs se pasen del techo entre los dos.
 *   2. `pg_try_advisory_lock` de **sesión** sigue en pie mientras la conexión
 *      vive, y se suelta al cerrarla — la prueba de vida de la que depende el
 *      cierre de huérfanas.
 *   3. Una reserva confirmada es visible desde **otra** conexión aunque la
 *      transacción de datos reviente después.
 *
 * ⚠️ **CERO llamadas a Streaming Availability.** Este script no importa
 * `transporte.ts` ni toca la red. Solo base de datos.
 *
 * ⚠️ Escribe en `ops_sync_runs` y **confirma**, porque demostrar que un COMMIT
 * es visible desde otra sesión exige confirmarlo. Si el proceso muere a mitad
 * quedan filas: el script lo dice y `--limpiar` las recupera. Nunca lo oculta.
 */
import { Client, neonConfig } from "@neondatabase/serverless";

import type { EjecutorSql, Presupuesto } from "../jobs/ops/contratos.ts";
import {
  NS_CICLO,
  NS_PIPELINE,
  PIPELINE_ID,
  calcularCiclo,
  ejecutarJob,
  leerPresupuesto,
  tomarLockDePipeline,
} from "../jobs/ops/index.ts";

/** Marca de las filas de este script. Nada fuera de ella se toca jamás. */
const MARCA = "validate-ops-v1";
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
      "\n        pnpm db:validate:ops --limpiar\n",
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

  console.log("VALIDACIÓN DE LA INFRAESTRUCTURA DE EJECUCIÓN Y PRESUPUESTO\n");
  console.log(`  hostname          ${destino.hostname}`);
  console.log(`  conexión directa  sí (sin "-pooler")`);
  console.log(`  MIGRATION_TARGET  ${destino.rama}`);
  console.log(`  red externa       ninguna · cero requests a la API`);

  // Dos sesiones: es el mínimo para probar que un lock excluye a alguien.
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

  const a = envolver(clienteA);
  const b = envolver(clienteB);

  async function limpiar(): Promise<number> {
    const r = await a.ejecutar<{ id: number }>(
      `DELETE FROM ops_sync_runs WHERE commit_sha = $1 RETURNING id`,
      [MARCA],
    );
    return r.length;
  }

  async function contarMarcadas(): Promise<number> {
    const r = await a.ejecutar<{ n: number }>(
      `SELECT count(*)::int AS n FROM ops_sync_runs WHERE commit_sha = $1`,
      [MARCA],
    );
    return r[0]?.n ?? -1;
  }

  async function fila(id: number) {
    const r = await a.ejecutar<{
      status: string;
      finished_at: Date | null;
      requests_made: number;
      budget_limit: number | null;
      error_count: number;
      error_samples: unknown;
      rows_affected: unknown;
      multi_link_offers: number;
      far_future_expiries: number;
    }>(`SELECT * FROM ops_sync_runs WHERE id = $1`, [id]);
    return r[0];
  }

  if (soloLimpieza) {
    seccion("Limpieza explícita");
    const borradas = await limpiar();
    console.log(`  ${String(borradas)} filas borradas`);
    const resto = await contarMarcadas();
    if (resto === 0) bien("no queda ninguna fila de este script");
    else mal("rastro cero", "0 filas", String(resto));
    await clienteA.end();
    await clienteB.end();
    if (fallos > 0) process.exitCode = 1;
    return;
  }

  let hayEstadoConfirmado = false;

  try {
    seccion("1 · Punto de partida");
    const marcadasAlEmpezar = await contarMarcadas();
    if (marcadasAlEmpezar === 0)
      bien("no hay filas de ejecuciones anteriores de este script");
    else
      mal(
        "no hay filas de ejecuciones anteriores",
        "0 filas",
        `${String(marcadasAlEmpezar)} — lanza --limpiar`,
      );

    // ⚠️ Configuración INYECTADA, no la del repositorio. Los valores por
    //    defecto tienen todos los topes a 0 porque ningún job está aprobado
    //    para gastar API; aquí se abren a propósito para demostrar el
    //    mecanismo, y solo dentro de este proceso.
    const presupuesto: Presupuesto = leerPresupuesto({
      STREAMING_API_MONTHLY_BUDGET: "1000",
      STREAMING_API_MONTHLY_PIPELINE_BUDGETS: "seed=900",
      STREAMING_API_PER_RUN_CAPS: "seed=900",
    });
    const ciclo = calcularCiclo(new Date(), presupuesto.diaDeCiclo);
    console.log(
      `  ciclo vigente     [${ciclo.inicio.toISOString()}, ${ciclo.fin.toISOString()}) clave ${String(ciclo.clave)}`,
    );
    console.log(
      `  umbral global     ${String(presupuesto.umbralGlobal)} de ${String(presupuesto.presupuestoMensual)}`,
    );

    // ── 2 · El lock de sesión excluye de verdad ────────────────────────────
    seccion("2 · Lock de pipeline: exclusión mutua entre sesiones");
    const primeroA = await tomarLockDePipeline(a, PIPELINE);
    if (primeroA) bien("la sesión A toma el lock del pipeline");
    else mal("la sesión A toma el lock", "true", "false");

    const segundoB = await tomarLockDePipeline(b, PIPELINE);
    if (!segundoB) bien("la sesión B NO lo consigue mientras A lo sostiene");
    else mal("la sesión B es rechazada", "false", "true");

    const reentranteA = await tomarLockDePipeline(a, PIPELINE);
    if (reentranteA) {
      bien(
        "los locks de sesión son reentrantes para su propio dueño (hay que soltar dos veces)",
      );
      await a.ejecutar("SELECT pg_advisory_unlock($1, $2)", [
        NS_PIPELINE,
        PIPELINE_ID[PIPELINE],
      ]);
    } else {
      mal("reentrancia del lock de sesión", "true", "false");
    }

    await a.ejecutar("SELECT pg_advisory_unlock($1, $2)", [
      NS_PIPELINE,
      PIPELINE_ID[PIPELINE],
    ]);
    const trasSoltar = await tomarLockDePipeline(b, PIPELINE);
    if (trasSoltar) bien("soltado por A, la sesión B ya puede tomarlo");
    else mal("B lo toma tras soltarlo A", "true", "false");
    await b.ejecutar("SELECT pg_advisory_unlock($1, $2)", [
      NS_PIPELINE,
      PIPELINE_ID[PIPELINE],
    ]);

    // ── 3 · El lock de transacción SERIALIZA ───────────────────────────────
    seccion("3 · Lock de ciclo: una transacción espera a la otra");
    await a.ejecutar("BEGIN");
    await a.ejecutar("SELECT pg_advisory_xact_lock($1, $2)", [NS_CICLO, ciclo.clave]);

    await b.ejecutar("BEGIN");
    const bEspera = b.ejecutar("SELECT pg_advisory_xact_lock($1, $2)", [
      NS_CICLO,
      ciclo.clave,
    ]);
    const carrera = await conPlazo(bEspera, 1500);
    if (carrera.vencio)
      bien("B se queda esperando mientras A sostiene el lock del ciclo");
    else mal("B espera", "bloqueada 1,5 s", "obtuvo el lock de inmediato");

    await a.ejecutar("COMMIT");
    const trasCommit = await conPlazo(bEspera, 5000);
    if (!trasCommit.vencio)
      bien("el COMMIT de A suelta el lock y B continúa: _xact_ se libera solo");
    else mal("B continúa tras el COMMIT de A", "desbloqueada", "sigue esperando");
    await b.ejecutar("ROLLBACK");

    // ── 4 · Una ejecución completa, de principio a fin ─────────────────────
    seccion("4 · Una ejecución completa escribe su fila");
    let idFeliz = -1;
    const feliz = await ejecutarJob(
      a,
      { pipeline: PIPELINE, presupuesto, commitSha: MARCA },
      async (ctx) => {
        idFeliz = ctx.runId;
        hayEstadoConfirmado = true;
        await ctx.pedirCuota();
        await ctx.pedirCuota();
        ctx.medidor.filasTocadas("external_titles", 764);
        ctx.medidor.observar({ multiLinkOffers: 340, farFutureExpiries: 3 });
      },
    );

    if (feliz.ejecutado && feliz.estado === "succeeded") bien("termina como succeeded");
    else mal("estado final", "succeeded", JSON.stringify(feliz));

    const f = await fila(idFeliz);
    if (f === undefined) {
      mal("la fila existe", "1 fila", "ninguna");
    } else {
      if (f.budget_limit === 900)
        bien("budget_limit guarda el umbral operativo (900), no el bruto (1000)");
      else mal("budget_limit", "900", String(f.budget_limit));

      if (f.requests_made === 2) bien("requests_made cuenta las dos reservas");
      else mal("requests_made", "2", String(f.requests_made));

      if (f.finished_at !== null) bien("finished_at deja de ser null al cerrar");
      else mal("finished_at", "una marca de tiempo", "null");

      if (f.multi_link_offers === 340 && f.far_future_expiries === 3)
        bien("los dos contadores de observabilidad llegan a la fila");
      else
        mal(
          "contadores",
          "340 y 3",
          `${String(f.multi_link_offers)} y ${String(f.far_future_expiries)}`,
        );

      if (JSON.stringify(f.rows_affected) === JSON.stringify({ external_titles: 764 }))
        bien("rows_affected guarda el recuento por tabla");
      else
        mal("rows_affected", "el recuento por tabla", JSON.stringify(f.rows_affected));
    }

    // ── 5 · La reserva sobrevive al rollback de los datos ──────────────────
    seccion("5 · La contabilidad no depende de la transacción del pipeline");
    let idSuperviviente = -1;
    await ejecutarJob(
      a,
      { pipeline: PIPELINE, presupuesto, commitSha: MARCA },
      async (ctx) => {
        idSuperviviente = ctx.runId;
        // La conexión de DATOS es la otra, y revierte todo lo suyo.
        await b.ejecutar("BEGIN");
        await ctx.pedirCuota();
        await b.ejecutar("ROLLBACK");
      },
    );
    const superviviente = await fila(idSuperviviente);
    if (superviviente?.requests_made === 1)
      bien("la request reservada sigue contada tras revertir la transacción de datos");
    else mal("requests_made tras rollback", "1", String(superviviente?.requests_made));

    const desdeB = await b.ejecutar<{ n: number }>(
      `SELECT coalesce(sum(requests_made), 0)::int AS n FROM ops_sync_runs WHERE commit_sha = $1`,
      [MARCA],
    );
    if ((desdeB[0]?.n ?? -1) === 3)
      bien("las 3 reservas son visibles desde otra sesión: el COMMIT es de verdad");
    else mal("suma vista desde B", "3", String(desdeB[0]?.n));

    // ── 6 · Corte de presupuesto ───────────────────────────────────────────
    seccion("6 · El corte al umbral");
    const presupuestoMinimo = leerPresupuesto({
      STREAMING_API_MONTHLY_BUDGET: "3",
      STREAMING_API_BUDGET_STOP_FRACTION: "1",
      STREAMING_API_MONTHLY_PIPELINE_BUDGETS: "seed=3",
      STREAMING_API_PER_RUN_CAPS: "seed=3",
    });
    let idCortada = -1;
    let concedidas = 0;
    const cortada = await ejecutarJob(
      a,
      { pipeline: PIPELINE, presupuesto: presupuestoMinimo, commitSha: MARCA },
      async (ctx) => {
        idCortada = ctx.runId;
        for (let i = 0; i < 10; i++) {
          await ctx.pedirCuota();
          concedidas++;
        }
      },
    );
    if (cortada.ejecutado && cortada.estado === "budget_stopped")
      bien("una denegación cierra la fila como budget_stopped, no como failed");
    else mal("estado final", "budget_stopped", JSON.stringify(cortada));

    // Ya había 3 gastadas y el umbral es 3: no cabe ni una más.
    if (concedidas === 0) bien("no se concede ni una request por encima del umbral");
    else mal("requests concedidas por encima del umbral", "0", String(concedidas));

    const cortadaFila = await fila(idCortada);
    if (cortadaFila?.error_count === 1)
      bien("el corte queda contado en error_count con su muestra");
    else mal("error_count del corte", "1", String(cortadaFila?.error_count));

    // ── 7 · Huérfanas ──────────────────────────────────────────────────────
    seccion("7 · Cierre de ejecuciones huérfanas");
    const insertada = await a.ejecutar<{ id: number }>(
      `INSERT INTO ops_sync_runs
         (pipeline, status, started_at, requests_made, budget_limit, commit_sha)
       VALUES ($1, 'running', now(), 17, 900, $2) RETURNING id`,
      [PIPELINE, MARCA],
    );
    const idHuerfana = insertada[0]?.id ?? -1;

    await ejecutarJob(a, { pipeline: PIPELINE, presupuesto, commitSha: MARCA }, () =>
      Promise.resolve(),
    );

    const huerfana = await fila(idHuerfana);
    if (huerfana?.status === "failed") bien("la huérfana queda en failed");
    else mal("estado de la huérfana", "failed", String(huerfana?.status));

    if (huerfana !== undefined && huerfana.finished_at !== null)
      bien("se le pone finished_at — que marca la DETECCIÓN, no la muerte");
    else mal("finished_at de la huérfana", "una marca de tiempo", "null");

    if (huerfana?.requests_made === 17)
      bien("sus 17 requests siguen intactas: esa cuota se gastó de verdad");
    else mal("requests_made de la huérfana", "17", String(huerfana?.requests_made));

    if (
      huerfana?.error_count === 1 &&
      JSON.stringify(huerfana.error_samples).includes("huerfana")
    )
      bien("queda contada y con su muestra explicando por qué");
    else
      mal(
        "evidencia de la huérfana",
        "error_count 1 y una muestra",
        JSON.stringify(huerfana?.error_samples),
      );

    const segundaPasada = await ejecutarJob(
      a,
      { pipeline: PIPELINE, presupuesto, commitSha: MARCA },
      () => Promise.resolve(),
    );
    if (segundaPasada.ejecutado && segundaPasada.huerfanasCerradas.length === 0)
      bien("la reconciliación es idempotente: la segunda pasada no encuentra ninguna");
    else
      mal(
        "idempotencia de la reconciliación",
        "0 huérfanas",
        JSON.stringify(segundaPasada),
      );
  } finally {
    seccion("8 · Limpieza y rastro");
    try {
      const borradas = await limpiar();
      console.log(`     ${String(borradas)} filas borradas`);
      const resto = await contarMarcadas();
      if (resto === 0) bien("rastro cero: no queda ninguna fila de este script");
      else mal("rastro cero", "0 filas", String(resto));
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
