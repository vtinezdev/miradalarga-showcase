/**
 * El **checkpoint de un recorrido del horizonte**: la forma v1 que comparten
 * `expiring` y `upcoming`, cómo nace cada recorrido y cómo avanza. Es la
 * estrategia **horizonte hacia delante** del job de `/changes`
 * (`deltas/job.ts`).
 *
 * ── En qué se diferencia del de `deltas` ─────────────────────────────────────
 *
 * `deltas` mira hacia atrás y sus ventanas son **contiguas**: si una se corta,
 * la siguiente ejecución la reanuda (ADR 0006). Un recorrido del horizonte
 * mira hacia delante —`[ahora, ahora + 31 días]`— y **cada ejecución lo
 * recorre desde el principio**:
 *
 *   · 📏 La lista viene en orden ascendente de fecha (`raw/023`, `raw/024`,
 *     `025`–`036`). Un corte pierde lo **más lejano**, no lo más urgente.
 *   · El horizonte de ayer no es el de hoy. Reanudar su cursor perseguiría la
 *     cola de una lista caducada, y mezclaría en un mismo «recorrido» dos
 *     observaciones de instantes distintos.
 *
 * Por eso `pendiente` **no es un punto de reanudación** aquí: es **dónde se
 * cortó** el recorrido. `pendiente = null` al terminar significa que el
 * recorrido fue **completo** (`hasMore=false` dentro del tope), que es la
 * única condición en la que una ausencia llega a medirse.
 *
 * No lee el checkpoint anterior: ningún recorrido depende de otro.
 *
 * Cada pipeline tiene **su** checkpoint —el tipo va en `tipos` y en
 * `pendiente.changeType`—, así que uno de `expiring` nunca pasa por uno de
 * `upcoming`, ni al revés.
 */
import { z } from "zod";

import type { TipoDeCambio } from "../../adapters/contracts.ts";
import type { NombreDePipeline } from "../../ops/contratos.ts";
import { ArranqueDenegado } from "../../ops/contratos.ts";
import type { RegistroDePagina } from "../deltas/index.ts";
import { ventanaEnSegundos } from "../deltas/manifiesto.ts";
import { VENTANA_MAXIMA_DIAS, ventanaHaciaDelante } from "../deltas/origen.ts";

/** Los dos tipos de `/changes` que miran hacia delante. */
export type TipoDeHorizonte = Extract<TipoDeCambio, "expiring" | "upcoming">;

/**
 * ⚖️ **31 días**: el máximo que acepta `/changes`. Es también el horizonte de
 * las mediciones, que dan el coste de cualquier horizonte menor porque la
 * lista llega ordenada por fecha.
 */
export const HORIZONTE_MAXIMO_DIAS = VENTANA_MAXIMA_DIAS;

export const VERSION_DEL_CHECKPOINT_DE_HORIZONTE = 1;

const segundosUnix = z.number().int().nonnegative();

/** El checkpoint v1 de un recorrido del horizonte de tipo `T`. */
export interface CheckpointDeHorizonte<T extends TipoDeHorizonte> {
  readonly v: typeof VERSION_DEL_CHECKPOINT_DE_HORIZONTE;
  readonly estrategia: "horizonte";
  readonly horizonteDias: number;
  /** Segundos UNIX, tal y como viajan en la query. */
  readonly ventana: { readonly from: number; readonly to: number };
  readonly tipos: readonly [T];
  /**
   * La primera página **no confirmada**. `null` = el recorrido terminó: el
   * horizonte está completo.
   */
  readonly pendiente: {
    readonly changeType: T;
    readonly cursorDeEntrada: string | null;
  } | null;
  /**
   * ISO. El **`timestamp` más lejano** confirmado en este recorrido, o `null`
   * si no se confirmó ninguna página con avisos.
   *
   * Con `pendiente = null` (horizonte completo) es el último que existe
   * dentro de la ventana, **no el fin de la ventana**: 📏 en la fila 44 fue el
   * 23-oct 21:59 con `to` el 25-oct 12:06, porque entre medias no sale nada.
   * Con el recorrido cortado, es hasta dónde llegó: lo que queda más allá no
   * se ha visto.
   */
  readonly ultimoTimestampConfirmado: string | null;
  readonly paginasConfirmadas: number;
  /**
   * Existe solo para cumplir la forma común (`CheckpointDeCambios`) y vale
   * siempre `null`: un recorrido del horizonte nunca reanuda otro.
   */
  readonly reanudaDe: null;
}

/**
 * **Lo que un pipeline del horizonte sabe hacer con su checkpoint.** Todas
 * las funciones son puras salvo `leer`, que lanza `ArranqueDenegado`.
 */
export interface CheckpointsDeHorizonte<T extends TipoDeHorizonte> {
  readonly pipeline: NombreDePipeline;
  readonly tipo: T;
  /** Estricto: una clave de más o de menos lo invalida. */
  readonly esquema: z.ZodType<CheckpointDeHorizonte<T>>;
  /** Valida un checkpoint leído de la base. **Nunca repara nada.** */
  leer(valor: unknown, runId: number): CheckpointDeHorizonte<T>;
  /** El checkpoint con el que nace un recorrido: nada confirmado todavía. */
  inicial(entrada: {
    readonly ventana: { readonly from: number; readonly to: number };
    readonly horizonteDias: number;
  }): CheckpointDeHorizonte<T>;
  /**
   * El plan de un recorrido nuevo: `[ahora − 60 s, ahora + horizonte]`, desde
   * la primera página.
   *
   * 📏 Es `ventanaHaciaDelante`, la forma que respondió 200 en el Spike 1
   * (`raw/023`, `raw/024`) y en `changes_validation` (filas 19–20), con
   * `include_unknown_dates=false` (`deltas/origen.ts`).
   */
  planificar(ahora: Date, horizonteDias?: number): CheckpointDeHorizonte<T>;
  /**
   * El checkpoint **tras confirmar** una página. Con `hasMore` y cursor, la
   * pendiente es la página siguiente; si no, `null`: el recorrido terminó.
   */
  avanzar(
    actual: CheckpointDeHorizonte<T>,
    pagina: RegistroDePagina,
  ): CheckpointDeHorizonte<T>;
}

export function checkpointsDeHorizonte<T extends TipoDeHorizonte>(
  pipeline: NombreDePipeline,
  tipo: T,
): CheckpointsDeHorizonte<T> {
  const literal = z.literal(tipo);
  const esquema = z.strictObject({
    v: z.literal(VERSION_DEL_CHECKPOINT_DE_HORIZONTE),
    estrategia: z.literal("horizonte"),
    horizonteDias: z.number().int().min(1).max(HORIZONTE_MAXIMO_DIAS),
    ventana: z
      .strictObject({ from: segundosUnix, to: segundosUnix })
      .refine((v) => v.from < v.to, "ventana vacía o invertida: from >= to"),
    tipos: z.tuple([literal]),
    pendiente: z
      .strictObject({
        changeType: literal,
        cursorDeEntrada: z.string().min(1).nullable(),
      })
      .nullable(),
    ultimoTimestampConfirmado: z.iso.datetime().nullable(),
    paginasConfirmadas: z.number().int().nonnegative(),
    reanudaDe: z.null(),
  }) as unknown as z.ZodType<CheckpointDeHorizonte<T>>;

  const inicial: CheckpointsDeHorizonte<T>["inicial"] = (entrada) =>
    // Se pasa por el schema también al CONSTRUIR: lo que se escribe tiene que
    // poder leerse después.
    esquema.parse({
      v: VERSION_DEL_CHECKPOINT_DE_HORIZONTE,
      estrategia: "horizonte",
      horizonteDias: entrada.horizonteDias,
      ventana: { from: entrada.ventana.from, to: entrada.ventana.to },
      tipos: [tipo],
      pendiente: { changeType: tipo, cursorDeEntrada: null },
      ultimoTimestampConfirmado: null,
      paginasConfirmadas: 0,
      reanudaDe: null,
    });

  return {
    pipeline,
    tipo,
    esquema,
    leer(valor, runId) {
      const version =
        typeof valor === "object" && valor !== null && "v" in valor
          ? valor.v
          : undefined;
      if (version !== VERSION_DEL_CHECKPOINT_DE_HORIZONTE) {
        throw new ArranqueDenegado(
          "checkpoint_version_desconocida",
          `el checkpoint de ${pipeline} de la ejecución ${String(runId)} no es ` +
            `v${String(VERSION_DEL_CHECKPOINT_DE_HORIZONTE)}.`,
          { checkpoint_run_id: runId, version_leida: version ?? null },
        );
      }
      const r = esquema.safeParse(valor);
      if (!r.success) {
        throw new ArranqueDenegado(
          "checkpoint_invalido",
          `el checkpoint de ${pipeline} de la ejecución ${String(runId)} no cumple el formato v1.`,
          {
            checkpoint_run_id: runId,
            problemas: r.error.issues
              .slice(0, 5)
              .map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`),
          },
        );
      }
      return r.data;
    },
    inicial,
    planificar(ahora, horizonteDias = HORIZONTE_MAXIMO_DIAS) {
      return inicial({
        ventana: ventanaEnSegundos(ventanaHaciaDelante(ahora, horizonteDias)),
        horizonteDias: Math.min(horizonteDias, HORIZONTE_MAXIMO_DIAS),
      });
    },
    avanzar(actual, pagina) {
      if (pagina.tipo !== tipo) {
        throw new Error(`${pipeline} no recorre la lista "${pagina.tipo}".`);
      }
      return esquema.parse({
        ...actual,
        pendiente:
          pagina.hayMas && pagina.cursorSiguiente !== null
            ? { changeType: tipo, cursorDeEntrada: pagina.cursorSiguiente }
            : null,
        ultimoTimestampConfirmado: pagina.ultimoTimestamp?.toISOString() ?? null,
        paginasConfirmadas: actual.paginasConfirmadas + 1,
      });
    },
  };
}
