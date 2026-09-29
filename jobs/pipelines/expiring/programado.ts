/**
 * **`expiring` como job ejecutable**: lo que corre `pnpm job expiring`.
 *
 * No añade lógica de ingesta: reutiliza `ejecutarJobDeExpiring` —el job de
 * `/changes` con la estrategia **horizonte hacia delante**— y el runner común
 * de `jobs/pipelines/programado.ts`: las mismas guardas de destino, el mismo
 * presupuesto sin overrides en Actions, las mismas dos conexiones y la misma
 * política de salida que `deltas`.
 *
 * Lo propio de `expiring`:
 *
 *   · **Horizonte de 31 días, desde la primera página en cada ejecución.** Si
 *     un recorrido se corta, **no se reanuda**: el siguiente recorre el
 *     horizonte de SU `ahora` desde el principio (`checkpoint.ts`).
 *   · **Sin regla de retraso.** El retraso >72 h de `deltas` mide una ventana
 *     hacia atrás que no avanza; aquí cada ventana nace nueva y mira hacia
 *     delante, así que no hay nada que se atasque.
 *   · El resumen dice si el recorrido fue **completo** y, solo entonces,
 *     cuántas ofertas desaparecieron del horizonte (`horizonte.ts`).
 *
 * ── Códigos de salida ───────────────────────────────────────────────────────
 *
 *   0  succeeded · lock ocupado, del pipeline o del catálogo (aviso) · corte
 *      por `tope_por_ejecucion` (aviso: el siguiente recorre el horizonte
 *      entero de nuevo)
 *   1  failed
 *   2  corte por techo mensual, umbral global o cuota del proveedor
 */
import { join } from "node:path";

import { regimenDelDestino } from "../arranque.ts";
import type {
  CodigoDeSalida,
  DependenciasDelJob,
  VeredictoComun,
} from "../programado.ts";
import {
  clasificar,
  conGuardasYConexiones,
  explicarNoEjecucion,
  selloDeEjecucion,
} from "../programado.ts";
import { crearRegistroLocal, ventanaDesdeSegundos } from "../deltas/manifiesto.ts";
import { PIPELINE_EXPIRING } from "./checkpoint.ts";
import type { ResultadoDelJobDeExpiring } from "./job.ts";
import { ejecutarJobDeExpiring } from "./job.ts";

export type { CodigoDeSalida };

export type VeredictoDeExpiring = VeredictoComun;

/** Función pura: la política común, sin endurecer. Ver la cabecera. */
export function veredictoDeExpiring(
  salida: ResultadoDelJobDeExpiring,
): VeredictoDeExpiring {
  return clasificar(salida.resultado);
}

/** Líneas de texto plano, sin secretos, para la consola y el resumen de Actions. */
export function resumenDeExpiring(
  salida: ResultadoDelJobDeExpiring,
  v: VeredictoDeExpiring,
): readonly string[] {
  const lineas: string[] = [
    `expiring · exit ${String(v.codigo)} · ${v.nivel} · ${v.motivo}`,
  ];
  const { resultado, checkpoint, contadores, horizonte } = salida;
  if (!resultado.ejecutado) {
    lineas.push(explicarNoEjecucion(PIPELINE_EXPIRING, resultado.motivo));
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
      `horizonte: ${String(checkpoint.horizonteDias)} días · ` +
        `${ventana.desde.toISOString()} → ${ventana.hasta.toISOString()}`,
    );
    lineas.push(
      `páginas confirmadas: ${String(checkpoint.paginasConfirmadas)} · ` +
        (checkpoint.pendiente === null
          ? "recorrido completo"
          : `cortado antes de ${checkpoint.pendiente.cursorDeEntrada ?? "su primera página"}` +
            " · el siguiente empieza de nuevo"),
    );
  }
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
  if (horizonte !== null) {
    lineas.push(
      horizonte.completo
        ? `desaparecidas del horizonte: ${String(horizonte.desaparecidas)} (solo se cuentan)`
        : "desaparecidas del horizonte: sin medir, el recorrido no terminó",
    );
  }
  return lineas;
}

export interface EjecucionProgramadaDeExpiring {
  readonly veredicto: VeredictoDeExpiring;
  readonly resumen: readonly string[];
  readonly salida: ResultadoDelJobDeExpiring;
}

export async function ejecutarExpiringProgramado(
  dep: DependenciasDelJob,
): Promise<EjecucionProgramadaDeExpiring> {
  return conGuardasYConexiones(PIPELINE_EXPIRING, dep, async (comunes) => {
    const directorio =
      dep.directorioDeRegistros === undefined
        ? join(".expiring-runs", selloDeEjecucion(comunes.ahora))
        : dep.directorioDeRegistros;

    const salida = await ejecutarJobDeExpiring({
      ...comunes,
      // La estrategia planifica sola: horizonte nuevo desde `ahora`, sin leer
      // ningún checkpoint anterior.
      plan: { origen: "persistente" },
      // En un destino sujeto al bootstrap, no arranca sin el primer deltas.
      regimen: regimenDelDestino(dep.destino.rama),
      crearRegistro:
        directorio === null
          ? null
          : (cabecera) =>
              crearRegistroLocal(directorio, {
                modo: "real",
                pipeline: PIPELINE_EXPIRING,
                // Una ejecución real confirma su trabajo: su --reproducir
                // será de idempotencia, no exacto.
                estadoInicial: { tipo: "rama" },
                ...cabecera,
              }),
    });
    const v = veredictoDeExpiring(salida);
    return { veredicto: v, resumen: resumenDeExpiring(salida, v), salida };
  });
}
