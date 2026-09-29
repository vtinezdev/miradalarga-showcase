/**
 * El job de `updated`: el mismo job de `/changes` que `deltas`
 * (`deltas/job.ts`), con la estrategia **contigua hacia atrás** y tres
 * diferencias, todas deliberadas:
 *
 *   · **Ninguna ausencia se interpreta** (`interpretarAusencias: false`). Un
 *     `updated` dice que algo cambió, no que algo falte: las presencias ponen
 *     `missing_streak` a cero; las ausencias no lo suben y no se retira nada.
 *   · **Ninguna opción se borra ni se fusiona**
 *     (`reconciliarCalidadDesconocida: false`, 2026-09-25). Si aparece una
 *     identidad `(link, quality)` nueva, se persiste, y la anterior —también
 *     una `(link, NULL)`— se queda para que `deltas` o `reconcile` la
 *     resuelvan.
 *   · **Solo títulos que ya están en la base** (`soloTitulosConocidos`). 📏 31
 *     de los 40 avisos de 24 h medidos son de Apple (`raw/055`, `raw/056`), y
 *     procesarlos a ciegas metería en el catálogo títulos que nadie eligió.
 *     Los que faltan se cuentan y no se tocan.
 *   · **Clasificación de cada aviso** al terminar (`clasificacion.ts`), que va
 *     al manifiesto. Solo mide: no escribe nada.
 *
 * Lo demás es el núcleo común, sin cambios: una transacción por página, el
 * checkpoint en la misma transacción, la protección contra observaciones
 * fuera de orden, los eventos por comparación de agregados (nunca el
 * `changeType` del proveedor) y su `UNIQUE`, las dos guardias de cuota y el
 * lock de escritor de catálogo (`ESCRIBE_CATALOGO.updated`).
 *
 * Un `updated` **nunca estrena histórico sin estado previo**: la regla del
 * núcleo solo deja hacerlo a un aviso de alta (`new`). Una oferta que no
 * conocíamos y que el snapshot lista es **línea base**; si el snapshot tampoco
 * la lista, no se escribe nada.
 *
 * ⚠️ **Sin presupuesto aprobado**: tope 0 y ningún registro en `jobs/run.ts`,
 * ni workflow, ni cron. Hoy solo lo ejecuta `scripts/run-updated-manual.ts`.
 */
import type { VentanaDeConsulta } from "../deltas/origen.ts";
import type { PoliticaSinCheckpoint } from "../deltas/checkpoint.ts";
import type {
  EstrategiaDeVentana,
  OpcionesDelJobDeCambios,
  ResultadoDelJobDeCambios,
} from "../deltas/job.ts";
import { ejecutarJobDeCambios } from "../deltas/job.ts";
import type { RegistroLocal } from "../deltas/manifiesto.ts";
import type { RegimenDeArranque } from "../arranque.ts";
import { REGIMEN_POR_DEFECTO, conCompuertaDeBootstrap } from "../arranque.ts";
import type { CheckpointDeUpdated, TipoDeUpdated } from "./checkpoint.ts";
import {
  CHECKPOINTS_DE_UPDATED,
  PIPELINE_UPDATED,
  TIPOS_DE_UPDATED,
  tipoDeUpdated,
} from "./checkpoint.ts";
import type { InformeDeUpdated } from "./clasificacion.ts";
import { clasificarUpdated } from "./clasificacion.ts";

/**
 * La estrategia **contigua hacia atrás** de `updated`, con la compuerta del
 * bootstrap delante salvo que se declare el régimen `historico`
 * (`arranque.ts`).
 *
 * ⚖️ Fuera del histórico, `ventana_de_validacion` —24 h a ojo— no existe:
 * se degrada a `prohibido`. La primera ventana de `updated` en un destino
 * nuevo está sin decidir (ADR 0009, «Qué NO decide»).
 */
export function estrategiaDeUpdated(
  sinCheckpointPedida: PoliticaSinCheckpoint,
  regimen: RegimenDeArranque = REGIMEN_POR_DEFECTO,
): EstrategiaDeVentana<CheckpointDeUpdated> {
  const sinCheckpoint: PoliticaSinCheckpoint =
    regimen !== "historico" && sinCheckpointPedida === "ventana_de_validacion"
      ? "prohibido"
      : sinCheckpointPedida;
  return conCompuertaDeBootstrap(estrategiaSinCompuerta(sinCheckpoint), regimen);
}

function estrategiaSinCompuerta(
  sinCheckpoint: PoliticaSinCheckpoint,
): EstrategiaDeVentana<CheckpointDeUpdated> {
  return {
    pipeline: PIPELINE_UPDATED,
    interpretarAusencias: false,
    soloTitulosConocidos: true,
    detallarOfertas: true,
    // No destructivo: una `(link, NULL)` previa no se borra ni se fusiona con
    // la `(link, calidad)` nueva. La resuelven después `deltas` o `reconcile`.
    reconciliarCalidadDesconocida: false,
    planificar: (ejecutorOps, ahora) =>
      CHECKPOINTS_DE_UPDATED.planificar(ejecutorOps, {
        ahora,
        sinCheckpoint,
        tipos: TIPOS_DE_UPDATED,
      }),
    fijo: (ventana, reanudarEn) =>
      CHECKPOINTS_DE_UPDATED.inicial({
        ventana,
        tipos: TIPOS_DE_UPDATED,
        ...(reanudarEn === undefined
          ? {}
          : {
              pendiente: {
                changeType: tipoDeUpdated.parse(reanudarEn.tipo),
                cursorDeEntrada: reanudarEn.cursor,
              },
            }),
      }),
    avanzar: (actual, pagina) => CHECKPOINTS_DE_UPDATED.avanzar(actual, pagina),
  };
}

/**
 * De dónde sale la ventana: del checkpoint persistente —reanuda o sigue
 * contigua— o, para ensayar y reproducir crudo ya pagado, la grabada.
 */
export type PlanDeUpdated =
  | { readonly origen: "persistente"; readonly sinCheckpoint: PoliticaSinCheckpoint }
  | {
      readonly origen: "fijo";
      readonly ventana: VentanaDeConsulta;
      readonly reanudarEn?: {
        readonly tipo: TipoDeUpdated;
        readonly cursor: string | null;
      };
    };

export interface OpcionesDelJobDeUpdated extends Omit<OpcionesDelJobDeCambios, "plan"> {
  readonly plan: PlanDeUpdated;
  /**
   * El régimen de arranque del destino (`arranque.ts`). **Por defecto, el
   * estricto** (`REGIMEN_POR_DEFECTO`): `"historico"` solo si se declara.
   */
  readonly regimen?: RegimenDeArranque;
}

export interface ResultadoDelJobDeUpdated extends ResultadoDelJobDeCambios<CheckpointDeUpdated> {
  /** `null` si el pipeline no terminó: un corte no deja informe que clasificar. */
  readonly clasificacion: InformeDeUpdated | null;
}

export async function ejecutarJobDeUpdated(
  opciones: OpcionesDelJobDeUpdated,
): Promise<ResultadoDelJobDeUpdated> {
  const { plan, regimen, ...resto } = opciones;
  // El manifiesto lo crea el job; aquí solo se captura para anotar en él la
  // clasificación, que llega cuando la ejecución ya está cerrada.
  let registro: RegistroLocal | null = null;
  const crear = opciones.crearRegistro;

  const salida = await ejecutarJobDeCambios(
    {
      ...resto,
      plan: plan.origen === "persistente" ? { origen: "persistente" } : plan,
      crearRegistro:
        crear === null
          ? null
          : (cabecera) => {
              registro = crear(cabecera);
              return registro;
            },
    },
    // Con un plan fijo la política no se consulta: la ventana ya está dada.
    estrategiaDeUpdated(
      plan.origen === "persistente" ? plan.sinCheckpoint : "prohibido",
      regimen ?? REGIMEN_POR_DEFECTO,
    ),
  );

  const detalle = salida.informe?.detalle ?? null;
  const clasificacion =
    salida.informe === null || detalle === null
      ? null
      : clasificarUpdated(
          detalle,
          opciones.ahora,
          salida.informe.titulosFueraDeCatalogo,
        );

  // TS no ve la asignación dentro del callback: se lee a través de una variable.
  const final = registro as RegistroLocal | null;
  if (final !== null && clasificacion !== null) final.anotarUpdated(clasificacion);
  return { ...salida, clasificacion };
}
