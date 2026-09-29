/**
 * El **checkpoint** de `expiring`: el checkpoint v1 de un recorrido del
 * horizonte (`horizonte/checkpoint.ts`) con el tipo `expiring`.
 *
 * Cada ejecución recorre `[ahora − 60 s, ahora + 31 días]` **desde su primera
 * página**: `pendiente` no es un punto de reanudación, es **dónde se cortó**
 * el recorrido, y `pendiente = null` al terminar significa que el horizonte
 * se recorrió **completo**. No lee el checkpoint anterior: ningún recorrido
 * depende de otro. El porqué está en la cabecera de `horizonte/checkpoint.ts`.
 */
import type { NombreDePipeline } from "../../ops/contratos.ts";
import type { RegistroDePagina } from "../deltas/index.ts";
import type { CheckpointDeHorizonte } from "../horizonte/checkpoint.ts";
import {
  HORIZONTE_MAXIMO_DIAS,
  VERSION_DEL_CHECKPOINT_DE_HORIZONTE,
  checkpointsDeHorizonte,
} from "../horizonte/checkpoint.ts";

export const PIPELINE_EXPIRING: NombreDePipeline = "expiring";

/**
 * ⚖️ **31 días** (decidido el 2026-09-24): el máximo que acepta `/changes`.
 * Es también el horizonte de la medición inicial, que dará el coste de
 * cualquier horizonte menor porque la lista llega ordenada por fecha.
 */
export const HORIZONTE_POR_DEFECTO_DIAS = HORIZONTE_MAXIMO_DIAS;

export const VERSION_DEL_CHECKPOINT_DE_EXPIRING = VERSION_DEL_CHECKPOINT_DE_HORIZONTE;

export const CHECKPOINTS_DE_EXPIRING = checkpointsDeHorizonte(
  PIPELINE_EXPIRING,
  "expiring",
);

/**
 * **Checkpoint v1 de `expiring`.** Estricto como el de `deltas`: una clave de
 * más o de menos lo invalida, y un checkpoint que no se entiende no se
 * interpreta «lo mejor posible».
 */
export const checkpointDeExpiringV1 = CHECKPOINTS_DE_EXPIRING.esquema;

export type CheckpointDeExpiring = CheckpointDeHorizonte<"expiring">;

/** Valida un checkpoint leído de la base. **Nunca repara nada.** */
export function leerCheckpointDeExpiring(
  valor: unknown,
  runId: number,
): CheckpointDeExpiring {
  return CHECKPOINTS_DE_EXPIRING.leer(valor, runId);
}

/** El checkpoint con el que nace un recorrido: nada confirmado todavía. */
export function checkpointInicialDeExpiring(entrada: {
  readonly ventana: { readonly from: number; readonly to: number };
  readonly horizonteDias: number;
}): CheckpointDeExpiring {
  return CHECKPOINTS_DE_EXPIRING.inicial(entrada);
}

/** El plan de un recorrido nuevo: `[ahora − 60 s, ahora + horizonte]`. Pura. */
export function planificarExpiring(
  ahora: Date,
  horizonteDias: number = HORIZONTE_POR_DEFECTO_DIAS,
): CheckpointDeExpiring {
  return CHECKPOINTS_DE_EXPIRING.planificar(ahora, horizonteDias);
}

/** El checkpoint **tras confirmar** una página. Función pura. */
export function avanzarCheckpointDeExpiring(
  actual: CheckpointDeExpiring,
  pagina: RegistroDePagina,
): CheckpointDeExpiring {
  return CHECKPOINTS_DE_EXPIRING.avanzar(actual, pagina);
}
