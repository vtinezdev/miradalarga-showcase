/**
 * **`upcoming` como job ejecutable**: lo que corre `pnpm job upcoming`.
 *
 * No añade lógica de ingesta: reutiliza `ejecutarJobDeUpcoming` —el job de un
 * recorrido del horizonte, con el tipo `upcoming` y los anuncios en
 * `external_availability_announcements` (ADR 0007)— y el runner común de
 * `jobs/pipelines/programado.ts`: las mismas guardas de destino, el mismo
 * presupuesto sin overrides en Actions, las mismas dos conexiones y la misma
 * política de salida que `deltas` y `expiring`.
 *
 * Lo propio de `upcoming`:
 *
 *   · **Horizonte de 31 días, desde la primera página en cada ejecución.** Si
 *     un recorrido se corta, **no se reanuda**: el siguiente recorre el
 *     horizonte de SU `ahora` desde el principio (`horizonte/job.ts`).
 *   · **Sin regla de retraso.** El retraso >72 h de `deltas` mide una ventana
 *     hacia atrás que no avanza; aquí cada ventana nace nueva y mira hacia
 *     delante.
 *   · **Ninguna desaparición se interpreta.** El resumen dice si el recorrido
 *     fue **completo** y, solo entonces, cuántos anuncios vigentes no se
 *     observaron (`horizonte.ts`). Se cuentan; no se borran ni se marcan.
 *   · La fila de `ops_sync_runs` es la que escribe `last_seen_run_id`
 *     (`vincularEventos`), y un recorrido `succeeded`, completo y sin errores
 *     pasa a ser la referencia de la vigencia (`vigencia.ts`).
 *
 * Como escritor de catálogo, nunca corre a la vez que `deltas` ni `expiring`
 * (`ESCRIBE_CATALOGO`, `jobs/ops/bloqueo.ts`).
 *
 * ── Códigos de salida ───────────────────────────────────────────────────────
 *
 *   0  succeeded · lock ocupado, del pipeline o del catálogo (aviso) · corte
 *      por `tope_por_ejecucion` (aviso: el siguiente recorre el horizonte
 *      entero de nuevo)
 *   1  failed —también `cursor_sin_progreso`—
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
import type { InformeDeAnuncios } from "../deltas/contratos.ts";
import { crearRegistroLocal, ventanaDesdeSegundos } from "../deltas/manifiesto.ts";
import { PIPELINE_UPCOMING } from "./checkpoint.ts";
import type { ResultadoDelJobDeUpcoming } from "./job.ts";
import { ejecutarJobDeUpcoming } from "./job.ts";

export type { CodigoDeSalida };

export type VeredictoDeUpcoming = VeredictoComun;

/** Función pura: la política común, sin endurecer. Ver la cabecera. */
export function veredictoDeUpcoming(
  salida: ResultadoDelJobDeUpcoming,
): VeredictoDeUpcoming {
  return clasificar(salida.resultado);
}

/**
 * Qué hizo el planificador con los anuncios, en dos líneas. La comparten este
 * resumen y `pnpm api:run:upcoming` (`scripts/run-upcoming-manual.ts`).
 *
 * La primera **suma**: cada observación cae en exactamente uno de sus destinos
 * (`planificarAnuncios`). 📏 La fila 57 dio 51 = 50 nuevos + 1 misma
 * observación, el aviso que el cursor `timestamp:0` repite en la frontera de
 * dos páginas. La segunda son marcas que **no** suman: una observación puede
 * llevar varias o ninguna.
 */
export function lineasDeAnunciosGuardados(
  g: InformeDeAnuncios,
  repetidosEnElCrudo: number | null,
): readonly [string, string] {
  return [
    `anuncios: ${String(g.observados)} observados = nuevos ${String(g.nuevos)} · ` +
      `ciclos nuevos ${String(g.nuevosCiclos)} · actualizados ${String(g.actualizados)} · ` +
      `sin cambios ${String(g.sinCambios)} · enlaces completados ` +
      `${String(g.enlacesCompletados)} · misma observación ${String(g.mismaObservacion)} · ` +
      `fuera de orden ${String(g.fueraDeOrden)} · conflictos ${String(g.conflictos.length)}`,
    `  de ellos: sin link ${String(g.sinEnlace)} · enlaces conservados ` +
      `${String(g.enlacesConservados)} · fecha cambiada ${String(g.fechasCambiadas)} · ` +
      `link cambiado ${String(g.enlacesCambiados)}` +
      (repetidosEnElCrudo === null
        ? ""
        : ` · repetidos en el crudo ${String(repetidosEnElCrudo)}`),
  ];
}

/** Líneas de texto plano, sin secretos, para la consola y el resumen de Actions. */
export function resumenDeUpcoming(
  salida: ResultadoDelJobDeUpcoming,
  v: VeredictoDeUpcoming,
): readonly string[] {
  const lineas: string[] = [
    `upcoming · exit ${String(v.codigo)} · ${v.nivel} · ${v.motivo}`,
  ];
  const { resultado, checkpoint, contadores, horizonte } = salida;
  if (!resultado.ejecutado) {
    lineas.push(explicarNoEjecucion(PIPELINE_UPCOMING, resultado.motivo));
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
      `avisos ${String(salida.informe.avisos)} · sin show ` +
        `${String(salida.informe.avisosSinShow)} · eventos escritos ` +
        `${String(salida.informe.eventosEscritos)}`,
    );
  }
  if (salida.anunciosGuardados !== null) {
    lineas.push(
      ...lineasDeAnunciosGuardados(
        salida.anunciosGuardados,
        salida.anuncios?.repetidos ?? null,
      ),
    );
  }
  if (horizonte !== null) {
    lineas.push(
      !horizonte.completo
        ? "anuncios no observados: sin medir, el recorrido no terminó"
        : horizonte.desaparecidas === null
          ? "anuncios no observados: sin medir, hay avisos sin su show"
          : `anuncios no observados: ${String(horizonte.desaparecidas)} (solo se cuentan)` +
            ` · fuera de cobertura ${String(horizonte.fueraDeCobertura ?? 0)}`,
    );
  }
  return lineas;
}

export interface EjecucionProgramadaDeUpcoming {
  readonly veredicto: VeredictoDeUpcoming;
  readonly resumen: readonly string[];
  readonly salida: ResultadoDelJobDeUpcoming;
}

export async function ejecutarUpcomingProgramado(
  dep: DependenciasDelJob,
): Promise<EjecucionProgramadaDeUpcoming> {
  return conGuardasYConexiones(PIPELINE_UPCOMING, dep, async (comunes) => {
    const directorio =
      dep.directorioDeRegistros === undefined
        ? join(".upcoming-runs", selloDeEjecucion(comunes.ahora))
        : dep.directorioDeRegistros;

    const salida = await ejecutarJobDeUpcoming({
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
                pipeline: PIPELINE_UPCOMING,
                // Una ejecución real confirma su trabajo: su --reproducir
                // será de idempotencia, no exacto.
                estadoInicial: { tipo: "rama" },
                ...cabecera,
              }),
    });
    const v = veredictoDeUpcoming(salida);
    return { veredicto: v, resumen: resumenDeUpcoming(salida, v), salida };
  });
}
