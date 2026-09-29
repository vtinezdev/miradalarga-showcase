/**
 * **`deltas` como job ejecutable**: lo que corre `pnpm job deltas`.
 *
 * No añade lógica de ingesta: reutiliza `ejecutarJobDeDeltas`, ya validado
 * (locks, plan desde `ops_sync_runs.checkpoint`, presupuesto, guardia externa,
 * transacción por página). Las guardas, las conexiones y la política común de
 * salida son las de todo job programado de `/changes`
 * (`jobs/pipelines/programado.ts`). Lo propio de `deltas`:
 *
 *   · su **estrategia contigua**, que reanuda desde el checkpoint;
 *   · el **retraso** de lo confirmado, que endurece el veredicto;
 *   · su **resumen** y su directorio `.deltas-runs/`.
 *
 * ── Códigos de salida ───────────────────────────────────────────────────────
 *
 *   0  succeeded · lock ocupado, del pipeline o del catálogo (aviso) · corte
 *      por `tope_por_ejecucion` (aviso: la siguiente ejecución reanuda desde
 *      el checkpoint)
 *   1  failed —excepción, plan imposible, checkpoint ilegible, ciclo
 *      desalineado, frontera de ciclo—
 *   2  requiere atención sin ser un fallo: corte por techo mensual, umbral
 *      global o cuota del proveedor, o **retraso** mayor que el umbral
 */
import { join } from "node:path";

import { politicaDeDeltasSinCheckpoint, regimenDelDestino } from "../arranque.ts";
import type { DependenciasDelJob, VeredictoComun } from "../programado.ts";
import {
  clasificar,
  conGuardasYConexiones,
  explicarNoEjecucion,
  selloDeEjecucion,
} from "../programado.ts";
import type { CheckpointDeDeltas } from "./checkpoint.ts";
import type { ResultadoDelJobDeDeltas } from "./job.ts";
import { PIPELINE, ejecutarJobDeDeltas } from "./job.ts";
import { crearRegistroLocal, ventanaDesdeSegundos } from "./manifiesto.ts";

// Lo común, reexportado: este módulo sigue siendo la API de `pnpm job deltas`.
export {
  DESTINO_DEL_JOB,
  VARIABLES_DE_PRESUPUESTO,
  configuracionDeLaApi,
  exigirDestino,
  presupuestoDelJob,
} from "../programado.ts";
export type {
  CodigoDeSalida,
  DependenciasDelJob,
  DestinoVerificado,
} from "../programado.ts";

/**
 * **Retraso máximo tolerado** entre `ahora` y el instante hasta el que los
 * cambios están confirmados.
 *
 * ⚖️ Decisión, no medida: tres días. Un corte normal por tope deja como mucho
 * una ventana a medias —del orden de 24 h— y se reanuda al día siguiente; un
 * día sin ejecución lo lleva a ~48 h. Pasar de 72 h significa que el
 * checkpoint **no está avanzando** —atascado, o cortado día tras día— y un
 * humano tiene que mirarlo.
 *
 * Solo tiene sentido para una ventana **hacia atrás**: `expiring` no lo usa.
 */
export const UMBRAL_DE_RETRASO_MS = 72 * 3_600_000;

// ── El veredicto ─────────────────────────────────────────────────────────────

export interface Veredicto extends VeredictoComun {
  /** Milisegundos entre `ahora` y lo confirmado. `null` si no hay checkpoint. */
  readonly retrasoMs: number | null;
}

/**
 * Hasta dónde están confirmados los cambios. Con la ventana agotada, hasta su
 * `to`; con una lista pendiente, solo hasta su `from` —de lo que queda sin
 * pedir no se sabe nada—.
 */
export function confirmadoHasta(checkpoint: CheckpointDeDeltas): Date {
  return new Date(
    (checkpoint.pendiente === null ? checkpoint.ventana.to : checkpoint.ventana.from) *
      1000,
  );
}

/**
 * Función pura: del resultado del job al código de salida. La política común
 * (`clasificar`), **endurecida** con el retraso: nunca relajada.
 */
export function veredicto(salida: ResultadoDelJobDeDeltas, ahora: Date): Veredicto {
  const { resultado, checkpoint } = salida;
  const comun = clasificar(resultado);
  if (!resultado.ejecutado || resultado.estado === "failed") {
    return { ...comun, retrasoMs: null };
  }

  const retrasoMs =
    checkpoint === null
      ? null
      : ahora.getTime() - confirmadoHasta(checkpoint).getTime();

  // Un 2 por presupuesto ya es el peor caso sin ser fallo: se queda.
  if (comun.codigo === 2) return { ...comun, retrasoMs };

  if (retrasoMs !== null && retrasoMs > UMBRAL_DE_RETRASO_MS) {
    return { codigo: 2, nivel: "atencion", motivo: "retraso_excesivo", retrasoMs };
  }
  return { ...comun, retrasoMs };
}

// ── El resumen ───────────────────────────────────────────────────────────────

function horas(ms: number): string {
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

/** Líneas de texto plano, sin secretos, para la consola y el resumen de Actions. */
export function resumen(
  salida: ResultadoDelJobDeDeltas,
  v: Veredicto,
): readonly string[] {
  const lineas: string[] = [
    `deltas · exit ${String(v.codigo)} · ${v.nivel} · ${v.motivo}`,
  ];
  const { resultado, checkpoint, contadores } = salida;
  if (!resultado.ejecutado) {
    lineas.push(explicarNoEjecucion(PIPELINE, resultado.motivo));
    return lineas;
  }
  lineas.push(`ops_sync_runs ${String(resultado.runId)} · ${resultado.estado}`);
  lineas.push(
    `requests: ${String(contadores.reservasConcedidas)} reservadas · ` +
      `${String(contadores.respuestasOk)} respuestas ok`,
  );
  if (checkpoint !== null) {
    const ventana = ventanaDesdeSegundos(checkpoint.ventana);
    lineas.push(
      `ventana: ${ventana.desde.toISOString()} → ${ventana.hasta.toISOString()}` +
        (checkpoint.reanudaDe === null
          ? ""
          : ` · reanuda la ${String(checkpoint.reanudaDe)}`),
    );
    lineas.push(
      `páginas confirmadas: ${String(checkpoint.paginasConfirmadas)} · pendiente: ` +
        (checkpoint.pendiente === null
          ? "ninguna"
          : `${checkpoint.pendiente.changeType} desde ${checkpoint.pendiente.cursorDeEntrada ?? "su principio"}`),
    );
  }
  if (v.retrasoMs !== null) lineas.push(`confirmado hasta hace ${horas(v.retrasoMs)}`);
  const cuota = salida.cuotaDelProveedor.at(-1);
  if (cuota !== undefined) {
    lineas.push(
      `proveedor: ${String(cuota.usada)} / ${String(cuota.concedida)} · umbral ` +
        `${String(cuota.umbral)} · reinicia ${cuota.reinicio}`,
    );
  }
  if (salida.informe !== null) {
    lineas.push(
      `avisos ${String(salida.informe.avisos)} · eventos escritos ` +
        `${String(salida.informe.eventosEscritos)} · línea base ` +
        `${String(salida.informe.ofertasDeLineaBase)}`,
    );
  }
  return lineas;
}

// ── La ejecución ─────────────────────────────────────────────────────────────

export interface EjecucionProgramada {
  readonly veredicto: Veredicto;
  readonly resumen: readonly string[];
  readonly salida: ResultadoDelJobDeDeltas;
}

export async function ejecutarDeltasProgramado(
  dep: DependenciasDelJob,
): Promise<EjecucionProgramada> {
  return conGuardasYConexiones(PIPELINE, dep, async (comunes) => {
    const directorio =
      dep.directorioDeRegistros === undefined
        ? join(".deltas-runs", selloDeEjecucion(comunes.ahora))
        : dep.directorioDeRegistros;

    const salida = await ejecutarJobDeDeltas({
      ...comunes,
      // Sin checkpoint previo: en el destino histórico (drizzle-schema-v1-test,
      // el único que admite hoy `exigirDestino`), la ventana de validación; en
      // cualquier otro, el ancla del seed (ADR 0009, `arranque.ts`).
      plan: {
        origen: "persistente",
        sinCheckpoint: politicaDeDeltasSinCheckpoint(
          regimenDelDestino(dep.destino.rama),
        ),
      },
      crearRegistro:
        directorio === null
          ? null
          : (cabecera) =>
              crearRegistroLocal(directorio, {
                modo: cabecera.reanudaDe === null ? "real" : "reanudacion",
                ...cabecera,
              }),
    });
    const v = veredicto(salida, comunes.ahora);
    return { veredicto: v, resumen: resumen(salida, v), salida };
  });
}
