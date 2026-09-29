/**
 * El **checkpoint** de `upcoming`: el checkpoint v1 de un recorrido del
 * horizonte (`horizonte/checkpoint.ts`) con el tipo `upcoming`. Mismo formato
 * que el de `expiring`, pero **no intercambiable**: el tipo va en `tipos` y en
 * `pendiente.changeType`, y el esquema lo exige.
 *
 * Cada ejecución recorre `[ahora − 60 s, ahora + 31 días]` **desde su primera
 * página**. Un recorrido cortado no se reanuda: el siguiente recorre el
 * horizonte de SU `ahora` desde el principio. `pendiente = null` al terminar
 * es la única señal de que el horizonte se recorrió **completo**.
 */
import type { NombreDePipeline } from "../../ops/contratos.ts";
import type { RegistroDePagina } from "../deltas/index.ts";
import type { CheckpointDeHorizonte } from "../horizonte/checkpoint.ts";
import {
  HORIZONTE_MAXIMO_DIAS,
  checkpointsDeHorizonte,
} from "../horizonte/checkpoint.ts";

export const PIPELINE_UPCOMING: NombreDePipeline = "upcoming";

/**
 * ⚖️ **31 días** (decidido el 2026-09-24): el máximo que acepta `/changes`, y
 * el mismo horizonte que `expiring`. 📏 Recorrerlo entero cuesta **3
 * requests** (`ops_sync_runs` fila 50: 3 páginas, 63 avisos;
 * `docs/DATA-SOURCES.md` §1.9 bis).
 */
export const HORIZONTE_POR_DEFECTO_DIAS = HORIZONTE_MAXIMO_DIAS;

export const CHECKPOINTS_DE_UPCOMING = checkpointsDeHorizonte(
  PIPELINE_UPCOMING,
  "upcoming",
);

/** **Checkpoint v1 de `upcoming`.** Estricto. */
export const checkpointDeUpcomingV1 = CHECKPOINTS_DE_UPCOMING.esquema;

export type CheckpointDeUpcoming = CheckpointDeHorizonte<"upcoming">;

/** Valida un checkpoint leído de la base. **Nunca repara nada.** */
export function leerCheckpointDeUpcoming(
  valor: unknown,
  runId: number,
): CheckpointDeUpcoming {
  return CHECKPOINTS_DE_UPCOMING.leer(valor, runId);
}

/** El checkpoint con el que nace un recorrido: nada confirmado todavía. */
export function checkpointInicialDeUpcoming(entrada: {
  readonly ventana: { readonly from: number; readonly to: number };
  readonly horizonteDias: number;
}): CheckpointDeUpcoming {
  return CHECKPOINTS_DE_UPCOMING.inicial(entrada);
}

/** El plan de un recorrido nuevo: `[ahora − 60 s, ahora + horizonte]`. Pura. */
export function planificarUpcoming(
  ahora: Date,
  horizonteDias: number = HORIZONTE_POR_DEFECTO_DIAS,
): CheckpointDeUpcoming {
  return CHECKPOINTS_DE_UPCOMING.planificar(ahora, horizonteDias);
}

/** El checkpoint **tras confirmar** una página. Función pura. */
export function avanzarCheckpointDeUpcoming(
  actual: CheckpointDeUpcoming,
  pagina: RegistroDePagina,
): CheckpointDeUpcoming {
  return CHECKPOINTS_DE_UPCOMING.avanzar(actual, pagina);
}
