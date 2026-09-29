/**
 * El job de `expiring`: el job de un recorrido del horizonte
 * (`horizonte/job.ts`) —el mismo job de `/changes` que `deltas`, con la
 * estrategia **horizonte hacia delante**— y su medición al terminar.
 *
 * Lo propio de `expiring`:
 *
 *   · **La ventana**: `[ahora − 60 s, ahora + 31 días]`, desde la primera
 *     página en cada ejecución (`checkpoint.ts`).
 *   · **Ninguna ausencia se interpreta** (`interpretarAusencias: false`): las
 *     presencias ponen `missing_streak` a cero; las ausencias no lo suben.
 *   · **La medición del horizonte** al terminar (`horizonte.ts`), solo si el
 *     recorrido fue completo.
 *
 * Un aviso `expiring` nunca estrena histórico sin estado previo: la regla de
 * `deltas/index.ts` solo deja hacerlo a los avisos de alta (`new`, `upcoming`).
 * Sobre una oferta que no conocíamos, `expiring` escribe **línea base**.
 *
 * **Registrado en `pnpm job expiring`** (2026-09-24) vía `programado.ts`, con
 * tope **12** por ejecución y techo mensual **60** (`jobs/ops/presupuesto.ts`).
 * Como escritor de catálogo, nunca corre a la vez que `deltas` (`bloqueo.ts`).
 */
import type {
  EstrategiaDeVentana,
  OpcionesDelJobDeCambios,
  ResultadoDelJobDeCambios,
} from "../deltas/job.ts";
import {
  ejecutarJobDeHorizonte,
  estrategiaDeHorizonte,
  terminoBien,
} from "../horizonte/job.ts";
import type { RegimenDeArranque } from "../arranque.ts";
import { REGIMEN_POR_DEFECTO, conCompuertaDeBootstrap } from "../arranque.ts";
import type { CheckpointDeExpiring } from "./checkpoint.ts";
import { CHECKPOINTS_DE_EXPIRING, HORIZONTE_POR_DEFECTO_DIAS } from "./checkpoint.ts";
import type { MedicionDelHorizonte } from "./horizonte.ts";
import { medirHorizonte } from "./horizonte.ts";

/**
 * La estrategia **horizonte hacia delante**, con la compuerta del bootstrap
 * delante salvo que se declare el régimen `historico` (`arranque.ts`).
 */
export function estrategiaDeExpiring(
  horizonteDias: number = HORIZONTE_POR_DEFECTO_DIAS,
  regimen: RegimenDeArranque = REGIMEN_POR_DEFECTO,
): EstrategiaDeVentana<CheckpointDeExpiring> {
  return conCompuertaDeBootstrap(
    estrategiaDeHorizonte(CHECKPOINTS_DE_EXPIRING, horizonteDias),
    regimen,
  );
}

export interface OpcionesDelJobDeExpiring extends OpcionesDelJobDeCambios {
  /** Por defecto, 31. */
  readonly horizonteDias?: number;
  /**
   * El régimen de arranque del destino (`arranque.ts`). **Por defecto, el
   * estricto** (`REGIMEN_POR_DEFECTO`): `"historico"` solo si se declara.
   */
  readonly regimen?: RegimenDeArranque;
}

export interface ResultadoDelJobDeExpiring extends ResultadoDelJobDeCambios<CheckpointDeExpiring> {
  /** `null` si la ejecución no llegó a correr (ya había una viva). */
  readonly horizonte: MedicionDelHorizonte | null;
}

export async function ejecutarJobDeExpiring(
  opciones: OpcionesDelJobDeExpiring,
): Promise<ResultadoDelJobDeExpiring> {
  const { horizonteDias, regimen, ...comunes } = opciones;
  const { salida, medicion } = await ejecutarJobDeHorizonte(
    comunes,
    estrategiaDeExpiring(horizonteDias, regimen ?? REGIMEN_POR_DEFECTO),
    (s) =>
      medirHorizonte(comunes.ejecutorDatos, {
        checkpoint: s.checkpoint,
        informe: s.informe,
        terminado: terminoBien(s),
      }),
    (registro, horizonte) => registro.anotarHorizonte(horizonte),
  );
  return { ...salida, horizonte: medicion };
}
