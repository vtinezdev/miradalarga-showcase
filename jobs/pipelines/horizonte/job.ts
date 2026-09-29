/**
 * El job de un **recorrido del horizonte**: el mismo job de `/changes` que
 * `deltas` (`deltas/job.ts`), con la estrategia **horizonte hacia delante**.
 * Lo comparten `expiring` y `upcoming`.
 *
 * Reutiliza sin cambios la paginación, el adaptador, la comparación de
 * estados, la reconciliación de opciones, los eventos idempotentes, las dos
 * guardias de cuota, el lock, las huérfanas y el checkpoint por página. Lo
 * único propio:
 *
 *   · **La ventana**: `[ahora − 60 s, ahora + N días]`, desde la primera
 *     página en cada ejecución (`checkpoint.ts`). Nunca reanuda.
 *   · **Ninguna ausencia se interpreta** (`interpretarAusencias: false`): las
 *     presencias ponen `missing_streak` a cero; las ausencias no lo suben.
 *   · **Una medición al terminar**, que pone cada pipeline y se anota en el
 *     manifiesto. Solo mide: nunca escribe en el catálogo.
 */
import type { EjecutorSql } from "../../ops/contratos.ts";
import type { ResultadoDeJob } from "../../ops/ejecucion.ts";
import type {
  EstrategiaDeVentana,
  OpcionesDelJobDeCambios,
  ResultadoDelJobDeCambios,
} from "../deltas/job.ts";
import { ejecutarJobDeCambios } from "../deltas/job.ts";
import type { RegistroLocal } from "../deltas/manifiesto.ts";
import type {
  CheckpointDeHorizonte,
  CheckpointsDeHorizonte,
  TipoDeHorizonte,
} from "./checkpoint.ts";
import { HORIZONTE_MAXIMO_DIAS } from "./checkpoint.ts";

/** La estrategia **horizonte hacia delante** para los checkpoints dados. */
export function estrategiaDeHorizonte<T extends TipoDeHorizonte>(
  checkpoints: CheckpointsDeHorizonte<T>,
  horizonteDias: number = HORIZONTE_MAXIMO_DIAS,
): EstrategiaDeVentana<CheckpointDeHorizonte<T>> {
  return {
    pipeline: checkpoints.pipeline,
    interpretarAusencias: false,
    // No lee el checkpoint anterior: ningún recorrido depende de otro.
    planificar: (_ejecutorOps: EjecutorSql, ahora: Date) =>
      Promise.resolve(checkpoints.planificar(ahora, horizonteDias)),
    fijo(ventana, reanudarEn) {
      if (reanudarEn !== undefined) {
        throw new Error(
          `${checkpoints.pipeline} no reanuda: cada recorrido del horizonte empieza por su primera página.`,
        );
      }
      return checkpoints.inicial({ ventana, horizonteDias });
    },
    avanzar: (actual, pagina) => checkpoints.avanzar(actual, pagina),
  };
}

export type ResultadoDeRecorrido<T extends TipoDeHorizonte> = ResultadoDelJobDeCambios<
  CheckpointDeHorizonte<T>
>;

/** El recorrido cerró `succeeded`: condición necesaria para medir ausencias. */
export function terminoBien(salida: { readonly resultado: ResultadoDeJob }): boolean {
  return salida.resultado.ejecutado && salida.resultado.estado === "succeeded";
}

/**
 * Corre el recorrido y, **si llegó a ejecutarse**, su medición. `medicion` es
 * `null` si ya había una ejecución viva o el catálogo estaba ocupado: no hubo
 * recorrido que medir.
 */
export async function ejecutarJobDeHorizonte<T extends TipoDeHorizonte, M>(
  opciones: OpcionesDelJobDeCambios,
  estrategia: EstrategiaDeVentana<CheckpointDeHorizonte<T>>,
  medir: (salida: ResultadoDeRecorrido<T>) => Promise<M>,
  anotar: (registro: RegistroLocal, medicion: M) => void,
): Promise<{ readonly salida: ResultadoDeRecorrido<T>; readonly medicion: M | null }> {
  // El manifiesto lo crea el job; aquí solo se captura para anotar en él la
  // medición, que llega cuando la ejecución ya está cerrada.
  let registro: RegistroLocal | null = null;
  const crear = opciones.crearRegistro;

  const salida = await ejecutarJobDeCambios(
    {
      ...opciones,
      crearRegistro:
        crear === null
          ? null
          : (cabecera) => {
              registro = crear(cabecera);
              return registro;
            },
    },
    estrategia,
  );

  if (!salida.resultado.ejecutado) return { salida, medicion: null };

  const medicion = await medir(salida);
  // TS no ve la asignación dentro del callback: se lee a través de una variable.
  const final = registro as RegistroLocal | null;
  if (final !== null) anotar(final, medicion);
  return { salida, medicion };
}
