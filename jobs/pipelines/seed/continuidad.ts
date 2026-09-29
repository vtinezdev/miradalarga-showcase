/**
 * **Continuidad entre el ancla y `deltas`** (ADR 0009 §7, «Cómo se valida que
 * no hay hueco»): función pura sobre lo que un validador de solo lectura saca
 * de `ops_sync_runs`.
 *
 *   · El **primer** `deltas` del destino con checkpoint empieza **exactamente**
 *     en `S`, en segundos: `ventana.from === ancla.to`.
 *   · Cada ejecución siguiente parte de la anterior (ADR 0006): si la anterior
 *     dejó página pendiente, **reanuda la misma ventana**; si no, empieza en su
 *     `to` (`[prev.to, ahora]`).
 *
 * Las filas sin checkpoint no cuentan: una ejecución denegada al arrancar
 * (`sin_seed`, `ancla_caducada`, lock…) no pidió ninguna ventana.
 *
 * Mientras no haya ningún `deltas`, el resultado es `sin_deltas`: la
 * comprobación queda **preparada**, no superada.
 */

/** Una fila de `deltas`, con el checkpoint ya validado por `deltas/checkpoint.ts`. */
export interface EjecucionDeDeltas {
  readonly runId: number;
  readonly status: string;
  readonly ventana: { readonly from: number; readonly to: number };
  readonly pendiente: boolean;
}

export type ProblemaDeContinuidad =
  | {
      readonly tipo: "primer_deltas_no_empieza_en_el_ancla";
      readonly runId: number;
      readonly from: number;
      readonly ancla: number;
    }
  | {
      readonly tipo: "reanudacion_con_otra_ventana";
      readonly runId: number;
      readonly anterior: number;
    }
  | {
      readonly tipo: "hueco_o_solape";
      readonly runId: number;
      readonly anterior: number;
      readonly from: number;
      readonly toAnterior: number;
    };

export type ResultadoDeContinuidad =
  | { readonly estado: "sin_ancla" }
  | { readonly estado: "sin_deltas"; readonly ancla: number }
  | {
      readonly estado: "continua" | "rota";
      readonly ancla: number;
      readonly primerRunId: number;
      readonly primerFrom: number;
      readonly ejecuciones: number;
      readonly problemas: readonly ProblemaDeContinuidad[];
    };

/** `S` en segundos UNIX, la unidad de las ventanas de `/changes`. */
export function anclaEnSegundos(ancla: Date): number {
  return Math.floor(ancla.getTime() / 1000);
}

export function comprobarContinuidad(
  ancla: Date | null,
  ejecuciones: readonly EjecucionDeDeltas[],
): ResultadoDeContinuidad {
  if (ancla === null) return { estado: "sin_ancla" };
  const S = anclaEnSegundos(ancla);
  const ordenadas = [...ejecuciones].sort((a, b) => a.runId - b.runId);
  const primera = ordenadas[0];
  if (primera === undefined) return { estado: "sin_deltas", ancla: S };

  const problemas: ProblemaDeContinuidad[] = [];
  if (primera.ventana.from !== S) {
    problemas.push({
      tipo: "primer_deltas_no_empieza_en_el_ancla",
      runId: primera.runId,
      from: primera.ventana.from,
      ancla: S,
    });
  }
  for (let i = 1; i < ordenadas.length; i++) {
    const previa = ordenadas[i - 1];
    const actual = ordenadas[i];
    if (previa === undefined || actual === undefined) continue;
    if (previa.pendiente) {
      if (
        actual.ventana.from !== previa.ventana.from ||
        actual.ventana.to !== previa.ventana.to
      ) {
        problemas.push({
          tipo: "reanudacion_con_otra_ventana",
          runId: actual.runId,
          anterior: previa.runId,
        });
      }
    } else if (actual.ventana.from !== previa.ventana.to) {
      problemas.push({
        tipo: "hueco_o_solape",
        runId: actual.runId,
        anterior: previa.runId,
        from: actual.ventana.from,
        toAnterior: previa.ventana.to,
      });
    }
  }
  return {
    estado: problemas.length === 0 ? "continua" : "rota",
    ancla: S,
    primerRunId: primera.runId,
    primerFrom: primera.ventana.from,
    ejecuciones: ordenadas.length,
    problemas,
  };
}
