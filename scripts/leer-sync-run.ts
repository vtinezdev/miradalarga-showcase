/**
 * Lee **una** fila de `ops_sync_runs` y la imprime saneada.
 *
 *   pnpm db:leer:sync-run 19
 *
 * Existe porque la primera ejecución real del harness de `/changes` terminó
 * `failed` sin decir por qué: el motivo estaba en `error_samples` y no había
 * forma de mirarlo sin abrir un cliente a mano.
 *
 * ⚠️ **Solo `SELECT`.** No escribe, no borra y no toca la red externa. Las
 * guardas son las mismas de la migración, así que `production` es inalcanzable
 * por construcción.
 *
 * ⚠️ `error_samples` guarda mensajes de excepciones reales, que es uno de los
 * sitios por los que se escapa una credencial. Todo sale por `sanearTexto`.
 */
import { Client, neonConfig } from "@neondatabase/serverless";

import { describirFallo, sanearTexto } from "../jobs/ops/diagnostico.ts";
import type { EstadoFinal, MuestraDeError } from "../jobs/ops/contratos.ts";

interface FilaDeEjecucion {
  readonly id: string | number;
  readonly pipeline: string;
  readonly status: string;
  readonly started_at: Date | string;
  readonly finished_at: Date | string | null;
  readonly requests_made: number;
  readonly budget_limit: number | null;
  readonly rows_affected: unknown;
  readonly multi_link_offers: number;
  readonly far_future_expiries: number;
  readonly error_count: number;
  readonly error_samples: readonly MuestraDeError[] | null;
  readonly commit_sha: string | null;
}

const SQL = `
  SELECT id, pipeline, status, started_at, finished_at,
         requests_made, budget_limit, rows_affected,
         multi_link_offers, far_future_expiries,
         error_count, error_samples, commit_sha
    FROM ops_sync_runs
   WHERE id = $1`;

function instante(valor: Date | string | null): string {
  if (valor === null) return "— (sigue viva o no se cerró)";
  return (valor instanceof Date ? valor : new Date(valor)).toISOString();
}

async function principal(): Promise<void> {
  const bruto = process.argv[2];
  if (bruto === undefined || !/^\d+$/.test(bruto)) {
    throw new Error("Uso: pnpm db:leer:sync-run <id>   (un entero, p. ej. 19)");
  }

  const { verificarDestino } = await import("../drizzle.migrate.config.ts");
  const destino = verificarDestino();

  if (typeof WebSocket === "undefined") {
    throw new Error("Este Node no expone WebSocket global y Neon lo necesita.");
  }
  neonConfig.webSocketConstructor = WebSocket;

  console.log(`  hostname          ${destino.hostname}`);
  console.log(`  MIGRATION_TARGET  ${destino.rama}`);
  console.log(`  operación         SELECT · sin escrituras · sin red externa\n`);

  const cliente = new Client(destino.url);
  cliente.on("error", () => undefined);
  await cliente.connect();

  try {
    const r: { rows: unknown[] } = await cliente.query(SQL, [Number(bruto)]);
    const fila = r.rows[0] as FilaDeEjecucion | undefined;

    if (fila === undefined) {
      console.log(`No existe ninguna fila con id ${bruto}.`);
      process.exitCode = 1;
      return;
    }

    console.log(`ops_sync_runs id ${String(fila.id)}`);
    console.log(`  pipeline             ${fila.pipeline}`);
    console.log(`  status               ${fila.status}`);
    console.log(`  started_at           ${instante(fila.started_at)}`);
    console.log(`  finished_at          ${instante(fila.finished_at)}`);
    console.log(`  requests_made        ${String(fila.requests_made)}`);
    console.log(`  budget_limit         ${String(fila.budget_limit ?? "—")}`);
    console.log(`  error_count          ${String(fila.error_count)}`);
    console.log(`  multi_link_offers    ${String(fila.multi_link_offers)}`);
    console.log(`  far_future_expiries  ${String(fila.far_future_expiries)}`);
    console.log(`  commit_sha           ${fila.commit_sha ?? "—"}`);
    console.log(
      `  rows_affected        ${
        fila.rows_affected === null
          ? "—"
          : sanearTexto(JSON.stringify(fila.rows_affected))
      }`,
    );

    console.log("");
    const muestras = fila.error_samples ?? [];
    for (const linea of describirFallo({
      estado: fila.status as EstadoFinal,
      runId: Number(fila.id),
      requestsReservadas: fila.requests_made,
      metricas: {
        rowsAffected: null,
        multiLinkOffers: fila.multi_link_offers,
        farFutureExpiries: fila.far_future_expiries,
        errorCount: fila.error_count,
        errorSamples: muestras,
      },
    })) {
      console.log(linea);
    }
  } finally {
    await cliente.end().catch(() => undefined);
  }
}

principal().catch((error: unknown) => {
  const m = error instanceof Error ? error.message : String(error);
  console.error(`\n${sanearTexto(m)}`);
  process.exitCode = 1;
});
