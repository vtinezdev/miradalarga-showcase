/**
 * El **checkpoint persistente** de `deltas`: su forma v1, cómo avanza y cómo
 * decide cada ejecución qué ventana pedir (ADR 0006).
 *
 * `ops_sync_runs.checkpoint` es la **fuente autoritativa** para reanudar entre
 * runners. El manifiesto local de `.deltas-runs/` sigue existiendo, pero solo
 * para auditar y reproducir: ya no decide nada.
 *
 * ── Qué hace cada ejecución al arrancar ─────────────────────────────────────
 *
 * Con el lock del pipeline tomado y las huérfanas cerradas, lee el último
 * checkpoint de `deltas`:
 *
 *   · `pendiente ≠ null`  → **reanuda** esa ventana y ese cursor, exactos.
 *   · `pendiente = null`  → **ventana nueva contigua**: `[prev.to, ahora]`.
 *   · no hay ninguno      → en un destino sujeto al bootstrap del seed,
 *     **`[S, ahora]`** desde el ancla (`sin_seed` o `ancla_caducada` si no
 *     vale, ADR 0009); en el destino histórico, `[ahora − 24 h, ahora]`.
 *   · en bootstrap, **hasta el primer `deltas` `succeeded` y completo**, el
 *     plazo del ancla (`S + 72 h`) manda también para reanudar: pasado,
 *     `ancla_caducada` con 0 requests, aunque haya checkpoint reanudable.
 *   · hueco que `/changes` ya no cubre, o checkpoint ilegible → `failed`,
 *     **sin llamar a la API**.
 *
 * Una ejecución cubre **una sola ventana**: si reanuda, la ventana siguiente
 * queda para la próxima. Como empezará en `prev.to`, no se pierde nada; solo
 * se retrasa.
 */
import { z } from "zod";

import type { TipoDeCambio } from "../../adapters/contracts.ts";
import type { EjecutorSql, NombreDePipeline } from "../../ops/contratos.ts";
import { ArranqueDenegado } from "../../ops/contratos.ts";
import { leerUltimoCheckpoint } from "../../ops/checkpoint.ts";
import type { CheckpointRegistrado } from "../../ops/checkpoint.ts";
import type { AnclaDelSeed } from "../seed/ancla.ts";
import {
  anclaCaducada,
  leerAnclaDelSeed,
  leerPrimerDeltasCompleto,
  vencimientoDelAncla,
} from "../seed/ancla.ts";
import type { RegistroDePagina } from "./index.ts";
import type { PuntoDeReanudacion } from "./manifiesto.ts";
import { ventanaEnSegundos } from "./manifiesto.ts";
import {
  MARGEN_DE_RELOJ_MS,
  VENTANA_MAXIMA_DIAS,
  ventanaHaciaAtras,
} from "./origen.ts";

export const VERSION_DEL_CHECKPOINT = 1;

/** Los dos tipos de `deltas`. El checkpoint no admite ningún otro. */
export const tipoDeDeltas = z.enum(["removed", "new"]);
export type TipoDeDeltas = z.infer<typeof tipoDeDeltas>;

const segundosUnix = z.number().int().nonnegative();

/**
 * **Checkpoint v1 de una ventana contigua hacia atrás**, para los tipos de
 * `tipo`. Estricto: una clave de más, una de menos o un tipo distinto lo
 * invalidan. Un checkpoint que no se entiende no se interpreta «lo mejor
 * posible»: la ejecución falla sin llamar a nadie.
 *
 * La forma es **la misma** para `deltas` y `updated`; lo que cambia es qué
 * tipos admite, así que uno de `deltas` nunca pasa por uno de `updated`.
 */
function esquemaContiguoV1<T extends z.ZodEnum>(tipo: T) {
  return z
    .strictObject({
      v: z.literal(VERSION_DEL_CHECKPOINT),
      /** Segundos UNIX, tal y como viajan en la query. */
      ventana: z
        .strictObject({ from: segundosUnix, to: segundosUnix })
        .refine((v) => v.from < v.to, "ventana vacía o invertida: from >= to"),
      /** El orden en que se recorren. Sin repetidos. */
      tipos: z
        .array(tipo)
        .min(1)
        .refine((t) => new Set(t).size === t.length, "tipos repetidos"),
      /**
       * La **primera página NO confirmada**: su lista y el cursor con el que se
       * pedirá. `null` = la ventana está agotada.
       */
      pendiente: z
        .strictObject({
          changeType: tipo,
          cursorDeEntrada: z.string().min(1).nullable(),
        })
        .nullable(),
      /** ISO. El mayor `timestamp` confirmado de la lista pendiente, o `null`. */
      ultimoTimestampConfirmado: z.iso.datetime().nullable(),
      paginasConfirmadas: z.number().int().nonnegative(),
      /** La ejecución cuyo `pendiente` retomó esta. `null` si no reanuda. */
      reanudaDe: z.number().int().positive().nullable(),
    })
    .refine(
      // El tipo genérico no deja a TS ver `changeType`; en ejecución está.
      (c) =>
        c.pendiente === null ||
        (c.tipos as readonly unknown[]).includes(
          (c.pendiente as { readonly changeType: unknown }).changeType,
        ),
      "la lista pendiente no está entre los tipos del checkpoint",
    );
}

/** **Checkpoint v1 de `deltas`.** Ver `esquemaContiguoV1`. */
export const checkpointV1 = esquemaContiguoV1(tipoDeDeltas);

export type CheckpointDeDeltas = z.infer<typeof checkpointV1>;

/**
 * Un checkpoint contiguo de tipos `T`: la forma de `CheckpointDeDeltas` con
 * otro conjunto de tipos.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type CheckpointContiguo<T extends TipoDeCambio> = {
  v: typeof VERSION_DEL_CHECKPOINT;
  ventana: { from: number; to: number };
  tipos: T[];
  pendiente: { changeType: T; cursorDeEntrada: string | null } | null;
  ultimoTimestampConfirmado: string | null;
  paginasConfirmadas: number;
  reanudaDe: number | null;
};

/**
 * Qué hacer cuando **no existe ningún checkpoint** previo del pipeline.
 *
 *   · `ventana_de_validacion` — `[ahora − 24 h, ahora]`, la query medida en
 *     H2. **Solo para el destino histórico `drizzle-schema-v1-test`**
 *     (`arranque.ts`, régimen `historico`): quien la pide tiene que haber
 *     verificado antes que el destino es esa rama. ADR 0009 la retira para
 *     todo destino nuevo.
 *   · `prohibido` — `failed` sin llamar a la API.
 *   · `ancla_del_seed` — el de todo destino sujeto al bootstrap (ADR 0009
 *     §7): la primera ventana es **`[S, ahora]`**, con `S` el ancla de la carga
 *     del seed. Sin ancla, `sin_seed`; pasado `S + 72 h`, `ancla_caducada`; las
 *     dos con 0 requests. Con checkpoint propio el ancla se ignora.
 */
export type PoliticaSinCheckpoint =
  "ventana_de_validacion" | "prohibido" | "ancla_del_seed";

/**
 * **Margen para que `from` siga dentro de los 31 días de `/changes` durante
 * TODA la ejecución**, no solo al empezar.
 *
 * ⚖️ No es una medida: es un cerrojo conservador. Cubre la duración de una
 * ejecución y el desfase de reloj (📏 60 s ya costaron un 400, `raw/019`).
 * Denegar el arranque una hora antes del borde cuesta 0 requests; pasarse a
 * mitad de ejecución cuesta un 400, que se paga igual que una respuesta.
 */
export const MARGEN_DEL_HUECO_MS = 60 * 60_000;

/** El `from` más antiguo que `/changes` aceptará durante toda la ejecución. */
export function fromMasAntiguoAdmisible(ahora: Date): number {
  return Math.ceil(
    (ahora.getTime() -
      VENTANA_MAXIMA_DIAS * 86_400_000 +
      Math.max(MARGEN_DEL_HUECO_MS, MARGEN_DE_RELOJ_MS)) /
      1000,
  );
}

/**
 * **Lo que un pipeline de ventana contigua hacia atrás sabe hacer con su
 * checkpoint**: `deltas` y `updated`. Puras salvo `leer` y `planificarDesde`,
 * que lanzan `ArranqueDenegado`, y `planificar`, que además lee la base.
 */
export interface CheckpointsContiguos<T extends TipoDeCambio> {
  readonly pipeline: NombreDePipeline;
  readonly esquema: z.ZodType<CheckpointContiguo<T>>;
  /**
   * Valida un checkpoint leído de la base. **Nunca repara nada.** La versión
   * se mira antes que la forma: una versión desconocida es otra cosa que un
   * v1 roto, y la muestra tiene que decir cuál de las dos es.
   */
  leer(valor: unknown, runId: number): CheckpointContiguo<T>;
  /** El checkpoint con el que nace una ejecución: nada confirmado todavía. */
  inicial(entrada: {
    readonly ventana: { readonly from: number; readonly to: number };
    readonly tipos: readonly T[];
    /** Desde dónde empezar. Por defecto, la primera lista desde su principio. */
    readonly pendiente?: {
      readonly changeType: T;
      readonly cursorDeEntrada: string | null;
    };
    readonly reanudaDe?: number | null;
  }): CheckpointContiguo<T>;
  /**
   * El checkpoint **tras confirmar** una página. La pendiente pasa a ser la
   * página siguiente de la misma lista si hay `hasMore` con cursor; si no, la
   * primera página del tipo siguiente; si no queda tipo, `null`: la ventana
   * está agotada.
   *
   * ⚠️ El cursor nuevo es el `nextCursor` de la página **confirmada**. Nunca el
   * de una que falló: esa no llega aquí, porque se revirtió.
   */
  avanzar(
    actual: CheckpointContiguo<T>,
    pagina: RegistroDePagina,
  ): CheckpointContiguo<T>;
  /**
   * Dado el último checkpoint registrado, el plan de esta ejecución como su
   * checkpoint inicial. Lanza `ArranqueDenegado` si no hay plan posible.
   */
  planificarDesde(entrada: {
    readonly ultimo: CheckpointRegistrado | null;
    readonly ahora: Date;
    readonly sinCheckpoint: PoliticaSinCheckpoint;
    readonly tipos: readonly T[];
    /** Solo con `ancla_del_seed`: el ancla del destino, o `null`. */
    readonly ancla?: AnclaDelSeed | null;
    /**
     * Solo con `ancla_del_seed`: si ya existe un primer `deltas` `succeeded`
     * y sin página pendiente. **Por defecto, no**: mientras no conste, el
     * destino sigue en bootstrap y el ancla caduca también para reanudar.
     */
    readonly bootstrapCompleto?: boolean;
    /** Por qué el bootstrap no está completo, para la muestra de error. */
    readonly detalleDelBootstrap?: Readonly<Record<string, unknown>>;
  }): CheckpointContiguo<T>;
  /**
   * Lee el último checkpoint **de este pipeline** y planifica. Con
   * `ancla_del_seed` lee también si el bootstrap terminó y, si no, el ancla.
   */
  planificar(
    ejecutorOps: EjecutorSql,
    entrada: {
      readonly ahora: Date;
      readonly sinCheckpoint: PoliticaSinCheckpoint;
      readonly tipos: readonly T[];
    },
  ): Promise<CheckpointContiguo<T>>;
}

export function checkpointsContiguos<T extends TipoDeCambio>(
  pipeline: NombreDePipeline,
  tipo: z.ZodEnum,
): CheckpointsContiguos<T> {
  const esquema = esquemaContiguoV1(tipo) as unknown as z.ZodType<
    CheckpointContiguo<T>
  >;

  const leer: CheckpointsContiguos<T>["leer"] = (valor, runId) => {
    const version =
      typeof valor === "object" && valor !== null && "v" in valor ? valor.v : undefined;
    if (version !== VERSION_DEL_CHECKPOINT) {
      throw new ArranqueDenegado(
        "checkpoint_version_desconocida",
        `el checkpoint de ${pipeline} de la ejecución ${String(runId)} no es ` +
          `v${String(VERSION_DEL_CHECKPOINT)}.`,
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
  };

  const inicial: CheckpointsContiguos<T>["inicial"] = (entrada) => {
    const primero = entrada.tipos[0];
    if (primero === undefined)
      throw new Error("Un checkpoint necesita al menos un tipo.");
    // Se pasa por el schema también al CONSTRUIR: lo que se escribe tiene que
    // poder leerse después, o la siguiente ejecución fallaría por culpa de esta.
    return esquema.parse({
      v: VERSION_DEL_CHECKPOINT,
      ventana: { from: entrada.ventana.from, to: entrada.ventana.to },
      tipos: [...entrada.tipos],
      pendiente: entrada.pendiente ?? { changeType: primero, cursorDeEntrada: null },
      ultimoTimestampConfirmado: null,
      paginasConfirmadas: 0,
      reanudaDe: entrada.reanudaDe ?? null,
    });
  };

  const avanzar: CheckpointsContiguos<T>["avanzar"] = (actual, pagina) => {
    const t = tipo.parse(pagina.tipo) as T;
    let pendiente: CheckpointContiguo<T>["pendiente"];
    if (pagina.hayMas && pagina.cursorSiguiente !== null) {
      pendiente = { changeType: t, cursorDeEntrada: pagina.cursorSiguiente };
    } else {
      const siguiente = actual.tipos[actual.tipos.indexOf(t) + 1];
      pendiente =
        siguiente === undefined
          ? null
          : { changeType: siguiente, cursorDeEntrada: null };
    }

    const ultimo = pagina.ultimoTimestamp?.toISOString() ?? null;
    return {
      ...actual,
      pendiente,
      // Si la pendiente cambió de lista, de la nueva todavía no hay nada
      // confirmado. Con la ventana agotada se conserva el de la última página.
      ultimoTimestampConfirmado:
        pendiente === null || pendiente.changeType === t ? ultimo : null,
      paginasConfirmadas: actual.paginasConfirmadas + 1,
    };
  };

  const planificarDesde: CheckpointsContiguos<T>["planificarDesde"] = (entrada) => {
    const { ultimo, ahora } = entrada;
    const limite = fromMasAntiguoAdmisible(ahora);

    const exigirCubrible = (from: number, caso: string): void => {
      if (from < limite) {
        throw new ArranqueDenegado(
          "hueco_irrecuperable",
          `${caso}: from=${new Date(from * 1000).toISOString()} queda fuera de los ` +
            `${String(VENTANA_MAXIMA_DIAS)} días que acepta /changes. Los cambios de ese ` +
            "hueco ya no se pueden pedir: hace falta una reconciliación y una decisión humana.",
          {
            from,
            from_mas_antiguo_admisible: limite,
            checkpoint_run_id: ultimo?.runId ?? null,
          },
        );
      }
    };

    /**
     * **El ancla, vigente o nada.** Sin ancla, `sin_seed`; con `ahora ≥ S + 72 h`,
     * `ancla_caducada`. Las dos antes de ninguna reserva: la fila cierra
     * `failed` con 0 requests, y **no se toca ni catálogo ni checkpoint** —el
     * del `deltas` interrumpido sigue ahí, sin reanudar—. El destino queda
     * inerte hasta una recuperación explícita (ADR 0009 §7).
     */
    const exigirAnclaVigente = (
      reanudaria: CheckpointRegistrado | null,
    ): AnclaDelSeed => {
      const ancla = entrada.ancla ?? null;
      if (ancla === null) {
        throw new ArranqueDenegado(
          "sin_seed",
          reanudaria === null
            ? `no existe ningún checkpoint de ${pipeline} ni ancla del seed en este destino. ` +
                "Un destino nuevo arranca con la carga del seed (ADR 0009 §7)."
            : `el ${pipeline} de la fila ${String(reanudaria.runId)} no completó el bootstrap ` +
                "y este destino no tiene ancla del seed.",
          {
            ...(reanudaria === null ? {} : { checkpoint_run_id: reanudaria.runId }),
            ...entrada.detalleDelBootstrap,
          },
        );
      }
      if (anclaCaducada(ancla.ancla, ahora)) {
        throw new ArranqueDenegado(
          "ancla_caducada",
          `el ancla ${ancla.ancla.toISOString()} venció el ` +
            `${vencimientoDelAncla(ancla.ancla).toISOString()} sin un primer ${pipeline} ` +
            "completo. El destino queda inerte: hace falta una recuperación explícita, con " +
            "captura nueva y destino virgen (ADR 0009 §7).",
          {
            ancla: ancla.ancla.toISOString(),
            vence: vencimientoDelAncla(ancla.ancla).toISOString(),
            ancla_run_id: ancla.runId,
            ...(reanudaria === null
              ? {}
              : {
                  checkpoint_run_id: reanudaria.runId,
                  checkpoint_estado: reanudaria.status,
                }),
            ...entrada.detalleDelBootstrap,
          },
        );
      }
      return ancla;
    };

    if (ultimo === null) {
      if (entrada.sinCheckpoint === "ancla_del_seed") {
        const ancla = exigirAnclaVigente(null);
        const from = Math.floor(ancla.ancla.getTime() / 1000);
        const to = Math.floor(ahora.getTime() / 1000);
        exigirCubrible(from, "la ventana desde el ancla");
        if (to <= from) {
          throw new ArranqueDenegado(
            "ventana_vacia",
            `ahora (${ahora.toISOString()}) no es posterior al ancla ${ancla.ancla.toISOString()}.`,
            { ancla: from, ahora: to },
          );
        }
        // El checkpoint v1 de siempre: ninguna fila falsa, ningún formato nuevo.
        return inicial({ ventana: { from, to }, tipos: entrada.tipos });
      }
      if (entrada.sinCheckpoint === "prohibido") {
        throw new ArranqueDenegado(
          "sin_checkpoint",
          `no existe ningún checkpoint de ${pipeline} y la ventana inicial de validación no ` +
            "está permitida aquí. production necesita el ancla del seed (ADR 0006).",
        );
      }
      return inicial({
        ventana: ventanaEnSegundos(ventanaHaciaAtras(ahora)),
        tipos: entrada.tipos,
      });
    }

    // Primer `deltas` todavía sin completar: el plazo del ancla también manda
    // para reanudarlo, venga de un `failed` o de un `budget_stopped`.
    if (
      entrada.sinCheckpoint === "ancla_del_seed" &&
      entrada.bootstrapCompleto !== true
    ) {
      exigirAnclaVigente(ultimo);
    }

    const previo = leer(ultimo.checkpoint, ultimo.runId);

    if (previo.pendiente !== null) {
      // Reanudar EXACTAMENTE: misma ventana, mismos tipos, mismo cursor.
      exigirCubrible(previo.ventana.from, "la ventana pendiente");
      return inicial({
        ventana: previo.ventana,
        tipos: previo.tipos,
        pendiente: previo.pendiente,
        reanudaDe: ultimo.runId,
      });
    }

    // Ventana agotada: la siguiente empieza donde terminó la anterior.
    const to = Math.floor(ahora.getTime() / 1000);
    exigirCubrible(previo.ventana.to, "la ventana contigua");
    if (to <= previo.ventana.to) {
      throw new ArranqueDenegado(
        "ventana_vacia",
        `ahora (${ahora.toISOString()}) no es posterior al fin de la ventana anterior.`,
        { ventana_anterior_to: previo.ventana.to, ahora: to },
      );
    }
    return inicial({
      ventana: { from: previo.ventana.to, to },
      tipos: entrada.tipos,
    });
  };

  return {
    pipeline,
    esquema,
    leer,
    inicial,
    avanzar,
    planificarDesde,
    async planificar(ejecutorOps, entrada) {
      const ultimo = await leerUltimoCheckpoint(ejecutorOps, pipeline);
      if (entrada.sinCheckpoint !== "ancla_del_seed") {
        return planificarDesde({ ultimo, ...entrada });
      }
      if (pipeline !== "deltas") {
        throw new Error(`ancla_del_seed es la política de deltas, no de ${pipeline}.`);
      }
      // ¿Terminó ya el bootstrap, y a tiempo? Un checkpoint ilegible no se salta.
      const estado = await evaluarBootstrapCon(ejecutorOps, (v, id) => leer(v, id));
      return planificarDesde({
        ultimo,
        ...entrada,
        ancla: estado.ancla,
        bootstrapCompleto: estado.completo,
        ...(estado.completo ? {} : { detalleDelBootstrap: estado.detalle }),
      });
    },
  };
}

const CONTIGUOS_DE_DELTAS = checkpointsContiguos<TipoDeDeltas>("deltas", tipoDeDeltas);

// ── El estado del bootstrap ─────────────────────────────────────────────────

/**
 * Por qué un destino **sigue en bootstrap** (ADR 0009 §7):
 *
 *   · `sin_primer_deltas_completo` — ningún `deltas` `succeeded` sin página
 *     pendiente: no lo hubo, o se cortó o falló.
 *   · `sin_ancla` — hay un `deltas` completo, pero el destino no tiene ancla.
 *   · `ventana_no_arranca_en_el_ancla` — su ventana no empieza en `S`: no es la
 *     ventana inicial del bootstrap.
 *   · `primer_deltas_tardio` — terminó en `finished_at ≥ S + 72 h` (o sin
 *     `finished_at`). Sus datos se quedan: no se borra ni se revierte nada.
 */
export type CausaDeBootstrapPendiente =
  | "sin_primer_deltas_completo"
  | "sin_ancla"
  | "ventana_no_arranca_en_el_ancla"
  | "primer_deltas_tardio";

export type EstadoDelBootstrap =
  | {
      readonly completo: true;
      readonly runId: number;
      readonly ancla: AnclaDelSeed | null;
    }
  | {
      readonly completo: false;
      readonly causa: CausaDeBootstrapPendiente;
      readonly ancla: AnclaDelSeed | null;
      /** Para la muestra de error: la causa y la fila que no valió. */
      readonly detalle: Readonly<Record<string, unknown>>;
    };

async function evaluarBootstrapCon(
  ejecutorOps: EjecutorSql,
  leerDeltas: (valor: unknown, runId: number) => CheckpointContiguo<TipoDeCambio>,
): Promise<EstadoDelBootstrap> {
  const ancla = await leerAnclaDelSeed(ejecutorOps);
  const primero = await leerPrimerDeltasCompleto(ejecutorOps);
  const pendiente = (
    causa: CausaDeBootstrapPendiente,
    extra: Readonly<Record<string, unknown>> = {},
  ): EstadoDelBootstrap => ({
    completo: false,
    causa,
    ancla,
    detalle: { causa_del_bootstrap: causa, ...extra },
  });

  if (primero === null) return pendiente("sin_primer_deltas_completo");
  const checkpoint = leerDeltas(primero.checkpoint, primero.runId);
  const fila = { primer_deltas_run_id: primero.runId };
  if (checkpoint.pendiente !== null)
    return pendiente("sin_primer_deltas_completo", fila);
  if (ancla === null) return pendiente("sin_ancla", fila);
  if (checkpoint.ventana.from !== Math.floor(ancla.ancla.getTime() / 1000)) {
    return pendiente("ventana_no_arranca_en_el_ancla", fila);
  }
  const vence = vencimientoDelAncla(ancla.ancla);
  if (primero.finishedAt === null || primero.finishedAt.getTime() >= vence.getTime()) {
    return pendiente("primer_deltas_tardio", {
      ...fila,
      primer_deltas_terminado: primero.finishedAt?.toISOString() ?? null,
      vence: vence.toISOString(),
    });
  }
  return { completo: true, runId: primero.runId, ancla };
}

/**
 * **¿Terminó el bootstrap de este destino?** Solo si el primer `deltas`
 * completo —`succeeded`, sin página pendiente— cubre la ventana inicial desde
 * `S` y **terminó antes de `S + 72 h`** (`finished_at`, el reloj del
 * servidor). Uno que empezó a tiempo y terminó tarde **no** lo completa: sus
 * datos se quedan, pero el destino queda caducado.
 *
 * Lo usan la planificación de `deltas` (`ancla_del_seed`) y la compuerta de
 * `expiring`, `upcoming` y `updated` (`arranque.ts`). Un checkpoint ilegible
 * lanza `ArranqueDenegado`: no se salta.
 */
export function evaluarBootstrap(
  ejecutorOps: EjecutorSql,
): Promise<EstadoDelBootstrap> {
  return evaluarBootstrapCon(ejecutorOps, (v, id) => CONTIGUOS_DE_DELTAS.leer(v, id));
}

/** Valida un checkpoint de `deltas` leído de la base. **Nunca repara nada.** */
export function leerCheckpoint(valor: unknown, runId: number): CheckpointDeDeltas {
  return CONTIGUOS_DE_DELTAS.leer(valor, runId);
}

// ── Construir y avanzar ─────────────────────────────────────────────────────

/** El checkpoint con el que nace una ejecución: nada confirmado todavía. */
export function checkpointInicial(entrada: {
  readonly ventana: { readonly from: number; readonly to: number };
  readonly tipos: readonly TipoDeDeltas[];
  /** Desde dónde empezar. Por defecto, la primera lista desde su principio. */
  readonly pendiente?: {
    readonly changeType: TipoDeDeltas;
    readonly cursorDeEntrada: string | null;
  };
  readonly reanudaDe?: number | null;
}): CheckpointDeDeltas {
  return CONTIGUOS_DE_DELTAS.inicial(entrada);
}

/** El checkpoint **tras confirmar** una página. Función pura. */
export function avanzarCheckpoint(
  actual: CheckpointDeDeltas,
  pagina: RegistroDePagina,
): CheckpointDeDeltas {
  return CONTIGUOS_DE_DELTAS.avanzar(actual, pagina);
}

/**
 * **Lo que todo checkpoint de `/changes` tiene en común**, y lo único que el
 * job genérico (`job.ts`) lee de él. Cada pipeline valida su propia forma
 * —`checkpointV1` aquí, `checkpointDeExpiringV1` en `expiring/`—; el job no
 * interpreta nada más.
 *
 * `type` y no `interface`: el checkpoint viaja a `ops_sync_runs` como
 * `Record<string, unknown>`, y solo un alias es asignable a ese índice.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type CheckpointDeCambios = {
  readonly ventana: { readonly from: number; readonly to: number };
  readonly tipos: readonly TipoDeCambio[];
  readonly pendiente: {
    readonly changeType: TipoDeCambio;
    readonly cursorDeEntrada: string | null;
  } | null;
  readonly ultimoTimestampConfirmado: string | null;
  readonly paginasConfirmadas: number;
  readonly reanudaDe: number | null;
};

/** El checkpoint en la forma del manifiesto local y de las muestras de error. */
export function puntoDeReanudacion(
  checkpoint: CheckpointDeCambios,
): PuntoDeReanudacion | null {
  if (checkpoint.pendiente === null) return null;
  return {
    changeType: checkpoint.pendiente.changeType,
    from: checkpoint.ventana.from,
    to: checkpoint.ventana.to,
    cursorDeEntrada: checkpoint.pendiente.cursorDeEntrada,
    ultimoTimestamp: checkpoint.ultimoTimestampConfirmado,
  };
}

// ── Planificar una ejecución ────────────────────────────────────────────────

/**
 * Función **pura**: dado el último checkpoint registrado, el plan de esta
 * ejecución como su checkpoint inicial. Lanza `ArranqueDenegado` si no hay
 * plan posible.
 *
 * Una ejecución cubre **una sola ventana**: si reanuda, la ventana siguiente
 * queda para la próxima. Como empezará en `prev.to`, no se pierde nada; solo
 * se retrasa.
 */
export function planificarDesde(entrada: {
  readonly ultimo: CheckpointRegistrado | null;
  readonly ahora: Date;
  readonly sinCheckpoint: PoliticaSinCheckpoint;
  readonly tipos: readonly TipoDeDeltas[];
  readonly ancla?: AnclaDelSeed | null;
  readonly bootstrapCompleto?: boolean;
  readonly detalleDelBootstrap?: Readonly<Record<string, unknown>>;
}): CheckpointDeDeltas {
  return CONTIGUOS_DE_DELTAS.planificarDesde(entrada);
}

/** Lee el último checkpoint de `deltas` y planifica. Para `checkpointInicial`. */
export async function planificarDeltas(
  ejecutorOps: EjecutorSql,
  entrada: {
    readonly ahora: Date;
    readonly sinCheckpoint: PoliticaSinCheckpoint;
    readonly tipos: readonly TipoDeDeltas[];
  },
): Promise<CheckpointDeDeltas> {
  return CONTIGUOS_DE_DELTAS.planificar(ejecutorOps, entrada);
}
