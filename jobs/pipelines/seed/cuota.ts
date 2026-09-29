/**
 * **La cuota de una fase del seed que gasta** (sonda y captura): las mismas dos
 * guardias que `/changes` (`deltas/job.ts`), en el mismo orden, alrededor de
 * **cada** request:
 *
 *   · **antes** — 1 · guardia externa (`x-quota-*` ya vistas, o un corte del
 *     proveedor ya registrado en `ops_sync_runs`): si está cerrada, no se
 *     reserva. 2 · reserva en el libro interno (`reservar()`, lock B): tope,
 *     techo del ciclo y umbral global de 900. Denegada → `PresupuestoAgotado`
 *     → `budget_stopped`, sin request.
 *   · **después** — las cabeceras de cada respuesta 2xx se observan: al 90 %
 *     de `x-quota-granted`, con cabeceras ausentes o con un `x-quota-reset`
 *     que no es el fin del ciclo, la guardia se cierra y la request siguiente
 *     no sale.
 *
 * La fuente de páginas recibe la `FuenteDeCuota` y **tiene** que llamarla antes
 * de salir a la red —el transporte real lo hace por construcción—; el motor
 * comprueba después que se reservó exactamente una vez por página.
 */
import type { EjecutorSql } from "../../ops/contratos.ts";
import type { CuotaDelProveedor } from "../../ops/cuota-proveedor.ts";
import {
  buscarCorteVigente,
  crearGuardiaDeCuotaExterna,
} from "../../ops/cuota-proveedor.ts";
import type { ContextoDeEjecucion } from "../../ops/ejecucion.ts";
import type { FuenteDeCuota } from "../../ops/transporte.ts";

export interface CuotaDeLaFase {
  readonly fuente: FuenteDeCuota;
  /** Tras cada respuesta, con su estado HTTP y sus cabeceras. */
  observar(status: number, cabeceras: Readonly<Record<string, string>>): void;
  /** Reservas concedidas en esta ejecución. */
  reservas(): number;
  /** El instante inmediatamente anterior a la última reserva concedida. */
  ultimaReserva(): Date | null;
  observaciones(): readonly CuotaDelProveedor[];
}

export async function prepararCuota(opciones: {
  readonly contexto: ContextoDeEjecucion;
  readonly ejecutorOps: EjecutorSql;
  /**
   * `true` en toda ejecución contra el proveedor. `false` solo para un crudo
   * reenviado sin proveedor (ensayo): no hay cabeceras que observar.
   */
  readonly comprobarProveedor: boolean;
  readonly reloj: () => Date;
}): Promise<CuotaDeLaFase> {
  const { contexto, reloj } = opciones;
  const guardia = opciones.comprobarProveedor
    ? crearGuardiaDeCuotaExterna("seed", { finDelCiclo: contexto.ciclo.fin })
    : null;
  if (guardia !== null) {
    // Antes de la primera request: un corte del proveedor ya registrado y aún
    // sin reiniciar cierra la guardia, y esta ejecución no gasta ni una.
    const corte = await buscarCorteVigente(opciones.ejecutorOps, {
      ciclo: contexto.ciclo,
      ahora: reloj(),
    });
    if (corte !== null) guardia.prearmar(corte);
  }
  let reservas = 0;
  let ultima: Date | null = null;
  return {
    fuente: {
      pipeline: "seed",
      async pedirCuota() {
        guardia?.comprobar();
        const instante = reloj();
        await contexto.pedirCuota();
        reservas++;
        ultima = instante;
      },
    },
    observar(status, cabeceras) {
      if (guardia === null || status < 200 || status > 299) return;
      guardia.observar(new Headers(cabeceras));
    },
    reservas: () => reservas,
    ultimaReserva: () => ultima,
    observaciones: () => guardia?.observaciones() ?? [],
  };
}
