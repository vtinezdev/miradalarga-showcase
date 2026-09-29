/**
 * **Cómo arranca cada destino** (ADR 0009 §7): el destino histórico, tal como
 * funciona hoy, o un destino nuevo sujeto al bootstrap del seed.
 *
 * ── Dos regímenes, declarados en código ──────────────────────────────────────
 *
 *   · `bootstrap_del_seed` — **el régimen por defecto, de cualquier destino.**
 *     `deltas` arranca desde el ancla (`ancla_del_seed`: `[S, ahora]`,
 *     `sin_seed`, `ancla_caducada`), y `expiring`, `upcoming` y `updated`
 *     **no arrancan** hasta que el primer `deltas` haya terminado `succeeded`
 *     con su ventana completa (`bootstrap_incompleto`, 0 requests).
 *   · `historico` — **excepción explícita**, solo para `drizzle-schema-v1-test`.
 *     No es virgen y es evidencia (filas 19–60 de `ops_sync_runs`, 298
 *     títulos): opera desde antes del ADR 0009 y nunca tendrá ancla. Sin
 *     compuerta, y `deltas` sin checkpoint conserva `ventana_de_validacion`.
 *     Solo lo obtiene quien lo **pide**: `regimenDelDestino` con ese nombre
 *     exacto, o `"historico"` escrito en la llamada.
 *
 * ⚖️ **Fail-safe.** Las estrategias de `expiring`, `upcoming` y `updated`, y
 * sus jobs, nacen con `REGIMEN_POR_DEFECTO`: quien olvida pasar el régimen
 * queda en el estricto y nunca se salta `sin_seed` ni la compuerta. La
 * excepción vive en un mapa cerrado y por nombre, no en una variable de
 * entorno: añadir otra es un diff revisable, y no debería haber más.
 */
import type { AutorizacionDelSeed } from "../ops/autorizacion-del-seed.ts";
import {
  AUTORIZACIONES_DEL_SEED,
  autorizacionVigente,
} from "../ops/autorizacion-del-seed.ts";
import { leerUltimoCheckpoint } from "../ops/checkpoint.ts";
import { leerPresupuesto } from "../ops/presupuesto.ts";
import type { EjecutorSql, NombreDePipeline } from "../ops/contratos.ts";
import { ArranqueDenegado } from "../ops/contratos.ts";
import type {
  CheckpointDeCambios,
  EstadoDelBootstrap,
  PoliticaSinCheckpoint,
} from "./deltas/checkpoint.ts";
import { evaluarBootstrap } from "./deltas/checkpoint.ts";
import type { EstrategiaDeVentana } from "./deltas/job.ts";

export type RegimenDeArranque = "historico" | "bootstrap_del_seed";

/** Lo que usa todo el que no declara otra cosa: el estricto. */
export const REGIMEN_POR_DEFECTO: RegimenDeArranque = "bootstrap_del_seed";

/** La excepción: los destinos que operaban antes del ADR 0009. **Solo uno.** */
export const DESTINOS_HISTORICOS: Readonly<Record<string, RegimenDeArranque>> = {
  "drizzle-schema-v1-test": "historico",
};

/** El régimen de un destino, por su nombre de rama. Lo desconocido, estricto. */
export function regimenDelDestino(rama: string): RegimenDeArranque {
  return Object.hasOwn(DESTINOS_HISTORICOS, rama)
    ? (DESTINOS_HISTORICOS[rama] ?? REGIMEN_POR_DEFECTO)
    : REGIMEN_POR_DEFECTO;
}

/**
 * **La rama histórica se congela en el ciclo de la captura** (ADR 0009 §9.3,
 * ADR 0010). Mientras exista una autorización de `captura` para el ciclo de
 * `ahora`, ningún job ni script manual escribe en el destino histórico ni gasta
 * cuota en su libro: la captura y sus primeros `deltas` son el único libro que
 * gasta. No es un recordatorio del runbook: la misma entrada que autoriza la
 * captura congela la rama, y la congelación caduca con su ciclo.
 *
 * ⚖️ **Con el día de ciclo del llamador Y con el del repositorio**: la
 * captura calcula su ciclo con el del repositorio (`seed:capturar` ignora
 * `STREAMING_API_BUDGET_CYCLE_DAY`), así que un override local del día no
 * puede dejar un hueco en el que los dos libros gasten a la vez. Ante la duda,
 * congelada.
 *
 * Devuelve la autorización que la congela, o `null` si el destino puede
 * operar. Solo afecta al régimen histórico: las ramas del seed y `production`
 * nunca se congelan por esto.
 */
export function congelacionDelDestino(
  rama: string,
  ahora: Date,
  diaDeCiclo: number,
  lista: readonly AutorizacionDelSeed[] = AUTORIZACIONES_DEL_SEED,
): AutorizacionDelSeed | null {
  if (regimenDelDestino(rama) !== "historico") return null;
  for (const dia of new Set([diaDeCiclo, leerPresupuesto({}).diaDeCiclo])) {
    const a = autorizacionVigente("captura", ahora, dia, lista);
    if (a !== null) return a;
  }
  return null;
}

/** El texto común de la negativa, para la consola y el resumen de Actions. */
export function explicarCongelacion(rama: string, a: AutorizacionDelSeed): string {
  return (
    `${rama} está congelada en el ciclo ${String(a.ciclo)}: hay una captura del seed ` +
    `autorizada (${a.referencia}). Dos libros no gastan la misma cuota a la vez ` +
    "(ADR 0009 §9.3): no se conecta ni se reserva nada."
  );
}

/** Qué hace `deltas` sin checkpoint propio, según el régimen. */
export function politicaDeDeltasSinCheckpoint(
  regimen: RegimenDeArranque,
): PoliticaSinCheckpoint {
  return regimen === "historico" ? "ventana_de_validacion" : "ancla_del_seed";
}

/**
 * **La compuerta del bootstrap.** Un destino recién cargado solo admite a
 * `deltas`: `expiring`, `upcoming` y `updated` escriben catálogo, y sobre un
 * destino sin seed construirían uno parcial, y sobre uno caducado escribirían
 * encima de un catálogo que `deltas` ya no puede poner al día.
 *
 * ⚖️ **El bootstrap solo termina con el primer `deltas` completo**: cerró
 * `succeeded`, agotó su ventana inicial desde `S`, no dejó cursor ni página
 * pendiente (checkpoint v1 válido con `pendiente = null`) y **terminó antes de
 * `S + 72 h`** (`finished_at`). Uno que terminó tarde deja el destino caducado
 * (`causa: ancla_caducada`): sus datos se quedan y aquí nadie más escribe. Un `failed` o un
 * `budget_stopped` con checkpoint sigue siendo `bootstrap_incompleto`: su
 * ventana `[S, …]` está a medias. Desde ese primer `deltas` completo, régimen
 * normal.
 *
 * Se llama con el lock del pipeline tomado y las huérfanas cerradas, desde
 * `checkpointInicial`: si lanza, la fila cierra `failed` y **0 requests**.
 */
export async function exigirBootstrapCompleto(
  ejecutorOps: EjecutorSql,
  pipeline: NombreDePipeline,
): Promise<void> {
  let estado: EstadoDelBootstrap;
  try {
    estado = await evaluarBootstrap(ejecutorOps);
  } catch (error) {
    throw new ArranqueDenegado(
      "bootstrap_incompleto",
      `${pipeline} no arranca: el estado del bootstrap no se puede leer (checkpoint ilegible).`,
      {
        pipeline,
        causa: error instanceof ArranqueDenegado ? error.motivo : "excepcion",
      },
    );
  }
  if (estado.completo) return;

  if (estado.causa === "sin_primer_deltas_completo") {
    // Para el diagnóstico: ¿no hubo deltas, o lo hubo y no terminó?
    const ultimo = await leerUltimoCheckpoint(ejecutorOps, "deltas");
    throw new ArranqueDenegado(
      "bootstrap_incompleto",
      `${pipeline} no arranca: el primer deltas del destino ` +
        (ultimo === null
          ? "no existe todavía."
          : `(fila ${String(ultimo.runId)}, ${ultimo.status}) no ha completado su ventana.`) +
        " El bootstrap termina con un deltas succeeded, sin página pendiente y antes de S + 72 h" +
        " (ADR 0009 §7).",
      {
        pipeline,
        causa: ultimo === null ? "sin_primer_deltas" : "deltas_sin_completar",
        ...(ultimo === null
          ? {}
          : { deltas_run_id: ultimo.runId, deltas_estado: ultimo.status }),
      },
    );
  }

  // Un primer deltas tardío deja el destino caducado: inerte, sin borrar nada.
  const causa =
    estado.causa === "primer_deltas_tardio" ? "ancla_caducada" : estado.causa;
  throw new ArranqueDenegado(
    "bootstrap_incompleto",
    `${pipeline} no arranca: el primer deltas completo no valida el bootstrap (${estado.causa}).`,
    { pipeline, ...estado.detalle, causa },
  );
}

/**
 * La estrategia de `expiring`, `upcoming` o `updated` **con la compuerta**
 * delante, si el régimen lo exige. En el histórico la devuelve tal cual: ni un
 * `SELECT` más.
 *
 * Solo afecta a `planificar`, el camino que gasta cuota. `fijo` —ensayo y
 * reproducción de crudo ya pagado— no reserva nada y no se toca.
 */
export function conCompuertaDeBootstrap<C extends CheckpointDeCambios>(
  estrategia: EstrategiaDeVentana<C>,
  regimen: RegimenDeArranque,
): EstrategiaDeVentana<C> {
  if (regimen === "historico") return estrategia;
  if (estrategia.pipeline === "deltas") {
    throw new Error(
      "deltas no pasa por la compuerta: él es quien termina el bootstrap.",
    );
  }
  return {
    ...estrategia,
    async planificar(ejecutorOps, ahora) {
      await exigirBootstrapCompleto(ejecutorOps, estrategia.pipeline);
      return estrategia.planificar(ejecutorOps, ahora);
    },
  };
}
