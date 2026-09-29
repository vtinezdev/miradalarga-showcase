/**
 * El job de `upcoming`: el job de un recorrido del horizonte
 * (`horizonte/job.ts`) —el mismo que el de `expiring`— con el tipo
 * `upcoming`, y dos mediciones al terminar.
 *
 * ── Qué hace con cada anuncio ────────────────────────────────────────────────
 *
 * Lo guarda **como anuncio** en `external_availability_announcements`
 * (ADR 0007, `deltas/anuncios.ts`), con o sin `link`: una fila por oferta
 * anunciada, cuya fecha y link se actualizan en cada observación. **No
 * sintetiza opciones, no toca las reales y no emite eventos**: un anuncio no
 * es disponibilidad. El título sí se guarda, y el snapshot del show se procesa
 * como catálogo observado, igual que en `expiring`.
 *
 * ── Lo propio de `upcoming` ─────────────────────────────────────────────────
 *
 *   · **La ventana**: `[ahora − 60 s, ahora + 31 días]`, desde la primera
 *     página en cada ejecución. Nunca reanuda un recorrido anterior.
 *   · **Ninguna ausencia se interpreta** (`interpretarAusencias: false`): un
 *     anuncio que deja de listarse no se borra, no se marca y no emite nada; y
 *     una opción real que falta en el snapshot no sube `missing_streak`.
 *   · **Dos mediciones**, que solo miden: los anuncios vigentes que un
 *     recorrido **completo** no observó (`horizonte.ts`) y qué trajo el
 *     recorrido (`anuncios.ts`).
 *
 * **Registrado en `pnpm job upcoming`** (2026-09-24) vía `programado.ts`, con
 * tope **8** por ejecución y techo mensual **40** (`jobs/ops/presupuesto.ts`;
 * 📏 un horizonte completo de 31 días midió 3 requests, filas 50 y 57). Workflow
 * manual y cron semanal, los jueves a las 05:17 UTC. Como escritor de
 * catálogo, nunca corre a la vez que `deltas` ni `expiring` (`bloqueo.ts`).
 */
import type { FuenteDeCuota, Transporte } from "../../ops/transporte.ts";
import type {
  EstrategiaDeVentana,
  OpcionesDelJobDeCambios,
  ResultadoDelJobDeCambios,
} from "../deltas/job.ts";
import type { InformeDeAnuncios } from "../deltas/contratos.ts";
import type { ResumenDeAnuncios } from "../deltas/manifiesto.ts";
import {
  ejecutarJobDeHorizonte,
  estrategiaDeHorizonte,
  terminoBien,
} from "../horizonte/job.ts";
import type { RegimenDeArranque } from "../arranque.ts";
import { REGIMEN_POR_DEFECTO, conCompuertaDeBootstrap } from "../arranque.ts";
import { resumirAnuncios } from "./anuncios.ts";
import type { CheckpointDeUpcoming } from "./checkpoint.ts";
import { CHECKPOINTS_DE_UPCOMING, HORIZONTE_POR_DEFECTO_DIAS } from "./checkpoint.ts";
import type { MedicionDeUpcoming } from "./horizonte.ts";
import { medirHorizonteDeUpcoming } from "./horizonte.ts";

/**
 * La estrategia **horizonte hacia delante**, con el tipo `upcoming`. Un aviso
 * sin su show queda como error de la ejecución: ese recorrido no sirve de
 * referencia para la vigencia (`vigencia.ts`).
 */
export function estrategiaDeUpcoming(
  horizonteDias: number = HORIZONTE_POR_DEFECTO_DIAS,
  regimen: RegimenDeArranque = REGIMEN_POR_DEFECTO,
): EstrategiaDeVentana<CheckpointDeUpcoming> {
  // Con la compuerta del bootstrap delante salvo régimen `historico` declarado.
  return conCompuertaDeBootstrap(
    {
      ...estrategiaDeHorizonte(CHECKPOINTS_DE_UPCOMING, horizonteDias),
      atribucionObligatoria: true,
    },
    regimen,
  );
}

export interface OpcionesDelJobDeUpcoming extends OpcionesDelJobDeCambios {
  /** Por defecto, 31. */
  readonly horizonteDias?: number;
  /**
   * El régimen de arranque del destino (`arranque.ts`). **Por defecto, el
   * estricto** (`REGIMEN_POR_DEFECTO`): `"historico"` solo si se declara.
   */
  readonly regimen?: RegimenDeArranque;
}

export interface ResultadoDelJobDeUpcoming extends ResultadoDelJobDeCambios<CheckpointDeUpcoming> {
  /** `null` si la ejecución no llegó a correr (ya había una viva). */
  readonly horizonte: MedicionDeUpcoming | null;
  /** `null` si no llegó a correr o no hubo plan. */
  readonly anuncios: ResumenDeAnuncios | null;
  /**
   * Qué hicieron los anuncios con `external_availability_announcements`.
   * `null` si el pipeline no terminó: un corte no deja informe.
   */
  readonly anunciosGuardados: InformeDeAnuncios | null;
}

export async function ejecutarJobDeUpcoming(
  opciones: OpcionesDelJobDeUpcoming,
): Promise<ResultadoDelJobDeUpcoming> {
  const { horizonteDias, regimen, ...comunes } = opciones;

  // El crudo de cada respuesta 2xx, en orden. Las páginas se piden y se
  // confirman de una en una, y la primera que falla corta el recorrido: las
  // confirmadas son SIEMPRE las `paginasConfirmadas` primeras.
  const cuerpos: string[] = [];
  const crearLlamada = (fuente: FuenteDeCuota): Transporte => {
    const base = comunes.crearLlamada(fuente);
    return async (url, init) => {
      const respuesta = await base(url, init);
      if (respuesta.ok) cuerpos.push(await respuesta.clone().text());
      return respuesta;
    };
  };

  const { salida, medicion } = await ejecutarJobDeHorizonte(
    { ...comunes, crearLlamada },
    estrategiaDeUpcoming(horizonteDias, regimen ?? REGIMEN_POR_DEFECTO),
    async (s) => {
      const horizonte = await medirHorizonteDeUpcoming(comunes.ejecutorDatos, {
        checkpoint: s.checkpoint,
        informe: s.informe,
        terminado: terminoBien(s),
        ahora: comunes.ahora,
        // El run que escribió `last_seen_run_id`: el mismo criterio que los
        // eventos (`deltas/job.ts`, `vincularEventos`).
        runId:
          comunes.vincularEventos && s.resultado.ejecutado ? s.resultado.runId : null,
      });
      const anuncios =
        s.checkpoint === null
          ? null
          : resumirAnuncios(
              cuerpos
                .slice(0, s.checkpoint.paginasConfirmadas)
                .map((c) => JSON.parse(c) as unknown),
              { ventana: s.checkpoint.ventana, completo: horizonte.completo },
            );
      return { horizonte, anuncios, guardados: s.informe?.anuncios ?? null };
    },
    (registro, m) => {
      registro.anotarHorizonte(m.horizonte);
      if (m.anuncios !== null) registro.anotarAnuncios(m.anuncios);
      if (m.guardados !== null) registro.anotarAnunciosGuardados(m.guardados);
    },
  );

  return {
    ...salida,
    horizonte: medicion?.horizonte ?? null,
    anuncios: medicion?.anuncios ?? null,
    anunciosGuardados: medicion?.guardados ?? null,
  };
}
