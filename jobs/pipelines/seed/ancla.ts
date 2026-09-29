/**
 * **El ancla del seed** (ADR 0009 §7): el instante `S` desde el que la primera
 * ventana de `deltas` cubre, sin hueco, todo lo que cambió después de observar
 * el catálogo inicial.
 *
 *   · **`S` = `T0` truncado al segundo − 1 h**, fijado una vez al abrir la
 *     captura. El mismo en validación y en `production`.
 *   · **Vive en el checkpoint de la carga** (`fase = 'carga'`, `estado =
 *     'cargada'`), escrito como última sentencia de su transacción: **no se
 *     escribe ninguna fila falsa de `deltas`**.
 *   · **Plazo: 72 h desde `S`.** Pasado, la carga y el primer `deltas` se
 *     niegan (`ancla_caducada`) y hace falta una captura nueva.
 *
 * Solo lectura: la escritura es de `carga.ts`.
 */
import type { EjecutorSql } from "../../ops/contratos.ts";
import { idDeEjecucion } from "../../ops/contratos.ts";
import { PLAZO_DEL_ANCLA_SEGUNDOS } from "./crudo/formato.ts";
import type { CheckpointDeCarga } from "./fases.ts";
import { leerCheckpointDelSeed } from "./fases.ts";

export const PLAZO_DEL_ANCLA_MS = PLAZO_DEL_ANCLA_SEGUNDOS * 1000;

/** El ancla vigente de un destino, tal y como la dejó su carga. */
export interface AnclaDelSeed {
  /** La fila de la carga que la escribió. */
  readonly runId: number;
  readonly status: string;
  readonly checkpoint: CheckpointDeCarga;
  /** `S`. */
  readonly ancla: Date;
}

/**
 * La última carga **confirmada** del seed: fase `carga`, estado `cargada`. Una
 * fila `failed` u huérfana con `cargada` cuenta: su `COMMIT` ocurrió.
 */
export const SQL_ANCLA_DEL_SEED = `
  SELECT id, status, checkpoint
    FROM ops_sync_runs
   WHERE pipeline = 'seed'
     AND checkpoint ->> 'fase' = 'carga'
     AND checkpoint ->> 'estado' = 'cargada'
   ORDER BY id DESC
   LIMIT 1`;

/**
 * Lee el ancla. `null` si el destino no tiene ninguna carga confirmada. Un
 * checkpoint ilegible **no se salta**: lanza `ArranqueDenegado`, igual que un
 * checkpoint roto de `deltas`.
 */
export async function leerAnclaDelSeed(
  ejecutor: EjecutorSql,
): Promise<AnclaDelSeed | null> {
  const filas = await ejecutor.ejecutar<{
    id: unknown;
    status: string;
    checkpoint: unknown;
  }>(SQL_ANCLA_DEL_SEED);
  const fila = filas[0];
  if (fila === undefined) return null;
  const runId = idDeEjecucion(fila.id);
  const checkpoint = leerCheckpointDelSeed(fila.checkpoint, runId);
  if (checkpoint.fase !== "carga" || checkpoint.estado !== "cargada") {
    // El SQL ya filtra: llegar aquí sería un doble o una consulta mal cambiada.
    throw new Error(`La fila ${String(runId)} no es una carga confirmada.`);
  }
  return { runId, status: fila.status, checkpoint, ancla: new Date(checkpoint.ancla) };
}

/** El instante a partir del cual el ancla ya no vale: `S + 72 h`. */
export function vencimientoDelAncla(ancla: Date): Date {
  return new Date(ancla.getTime() + PLAZO_DEL_ANCLA_MS);
}

/** `ahora ≥ S + 72 h`. El borde exacto ya está caducado. */
export function anclaCaducada(ancla: Date, ahora: Date): boolean {
  return ahora.getTime() >= vencimientoDelAncla(ancla).getTime();
}

/**
 * **El primer `deltas` completo** del destino: `succeeded`, con checkpoint y
 * sin página pendiente, **con su `finished_at`**. El de id más bajo: dos
 * `deltas` nunca corren a la vez (lock A), así que también es el primero en
 * terminar. Un `failed` o un `budget_stopped` —aunque lleve checkpoint— no
 * cuenta.
 */
export const SQL_PRIMER_DELTAS_COMPLETO = `
  SELECT id, status, finished_at, checkpoint
    FROM ops_sync_runs
   WHERE pipeline = 'deltas'
     AND status = 'succeeded'
     AND checkpoint IS NOT NULL
     AND checkpoint ->> 'pendiente' IS NULL
   ORDER BY id ASC
   LIMIT 1`;

export interface PrimerDeltasCompleto {
  readonly runId: number;
  readonly status: string;
  /** `finished_at`: el `now()` del servidor al cerrarse. `null` si no consta. */
  readonly finishedAt: Date | null;
  /** Sin validar: lo interpreta `deltas/checkpoint.ts`, que conoce su forma. */
  readonly checkpoint: unknown;
}

function comoInstante(valor: unknown): Date | null {
  if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? null : valor;
  if (typeof valor === "string") {
    const d = new Date(valor);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * El primer `deltas` completo, **sin interpretar su checkpoint**. `null` si no
 * lo hay. Que valide el bootstrap —ventana desde `S` y `finished_at < S + 72 h`—
 * lo decide `evaluarBootstrap` (`deltas/checkpoint.ts`).
 */
export async function leerPrimerDeltasCompleto(
  ejecutor: EjecutorSql,
): Promise<PrimerDeltasCompleto | null> {
  const [fila] = await ejecutor.ejecutar<{
    id: unknown;
    status: string;
    finished_at: unknown;
    checkpoint: unknown;
  }>(SQL_PRIMER_DELTAS_COMPLETO);
  if (fila === undefined) return null;
  return {
    runId: idDeEjecucion(fila.id),
    status: fila.status,
    finishedAt: comoInstante(fila.finished_at),
    checkpoint: fila.checkpoint,
  };
}
