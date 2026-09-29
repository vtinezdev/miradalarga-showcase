/**
 * `ops_sync_runs.checkpoint`: **leer el último y avanzar el propio.** Nada más.
 *
 * Este fichero no sabe qué hay dentro de un checkpoint: la forma la fija y la
 * valida cada pipeline (ADR 0006). Aquí solo viven las dos sentencias y la
 * regla de con qué conexión se ejecuta cada una.
 *
 * ── Dos conexiones, dos atomicidades opuestas ───────────────────────────────
 *
 *   · `requests_made` va por la conexión de **ops**, en una transacción propia
 *     que se confirma al instante: **no puede deshacerse nunca**.
 *   · `checkpoint` va por la conexión de **datos**, **dentro** de la
 *     transacción de la página: se confirma con ella o se deshace con ella.
 *     Nunca describe trabajo que no existe ni queda por detrás de trabajo
 *     confirmado.
 *
 * ⚠️ **Sin interbloqueo solo por el ORDEN.** El `UPDATE` del checkpoint toma
 * el lock de fila de la ejecución hasta el `COMMIT` de la página. Si durante
 * ese intervalo se pidiera cuota —que actualiza la misma fila por la otra
 * conexión—, el proceso se esperaría a sí mismo. No ocurre porque la reserva
 * de la página N+1 sale después del `COMMIT` de la página N, y porque el
 * checkpoint se escribe **lo último** dentro de la transacción. Lo mide
 * `pnpm db:validate:checkpoint`, no se supone.
 */
import type { EjecutorSql, NombreDePipeline, PuntoDeControl } from "./contratos.ts";
import { idDeEjecucion } from "./contratos.ts";

/** El último checkpoint de un pipeline, **tal y como está en la fila**. */
export interface CheckpointRegistrado {
  readonly runId: number;
  readonly status: string;
  /** Sin validar: lo interpreta el pipeline, que es quien conoce su forma. */
  readonly checkpoint: unknown;
}

const SQL_ULTIMO = `
  SELECT id, status, checkpoint
    FROM ops_sync_runs
   WHERE pipeline = $1 AND checkpoint IS NOT NULL
   ORDER BY id DESC
   LIMIT 1`;

/**
 * El checkpoint de la ejecución **más reciente que dejó uno**, sea cual sea
 * su estado: una huérfana o una `failed` conservan el último punto confirmado,
 * y es justo el que hay que reanudar.
 *
 * ⚠️ **Se llama con el lock del pipeline ya tomado y las huérfanas ya
 * reconciliadas**, desde `ejecutarJob`. Así ninguna otra ejecución de este
 * pipeline puede estar avanzando un checkpoint mientras se lee.
 *
 * Una fila con checkpoint ilegible **no se salta**: el pipeline la rechaza y
 * la ejecución falla. Saltarla haría empezar una ventana nueva y abandonaría en
 * silencio la lista que quedó a medias.
 */
export async function leerUltimoCheckpoint(
  ejecutorOps: EjecutorSql,
  pipeline: NombreDePipeline,
): Promise<CheckpointRegistrado | null> {
  const filas = await ejecutorOps.ejecutar<{
    id: unknown;
    status: string;
    checkpoint: unknown;
  }>(SQL_ULTIMO, [pipeline]);
  const fila = filas[0];
  if (fila === undefined) return null;
  return {
    runId: idDeEjecucion(fila.id),
    status: fila.status,
    checkpoint: fila.checkpoint,
  };
}

const SQL_AVANZAR = `
  UPDATE ops_sync_runs
     SET checkpoint = $2::jsonb
   WHERE id = $1 AND status = 'running' AND finished_at IS NULL
  RETURNING id`;

/**
 * Avanza el checkpoint de **la propia** ejecución.
 *
 * Se ejecuta con la conexión de datos y **dentro de la transacción de la
 * página**, como su última sentencia.
 *
 * Exige que la fila siga viva: si no afecta a exactamente una fila, lanza, y
 * la página entera se revierte. Escribir un checkpoint en una fila cerrada —o
 * en la de otra ejecución— sería peor que no escribirlo.
 */
export async function escribirCheckpoint(
  ejecutor: EjecutorSql,
  runId: number,
  checkpoint: PuntoDeControl,
): Promise<void> {
  const filas = await ejecutor.ejecutar<{ id: number | string }>(SQL_AVANZAR, [
    runId,
    JSON.stringify(checkpoint),
  ]);
  if (filas.length !== 1) {
    throw new Error(
      `El checkpoint de la ejecución ${String(runId)} no se escribió: ` +
        `la fila no existe o ya no está en running (${String(filas.length)} filas).`,
    );
  }
}
