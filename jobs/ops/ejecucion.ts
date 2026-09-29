/**
 * Ciclo de vida de una fila de `ops_sync_runs`.
 *
 * ── El orden no es negociable ───────────────────────────────────────────────
 *
 *   1. lock de pipeline   → si no se consigue, ya hay una ejecución viva
 *   1b. lock de catálogo, solo si el pipeline escribe catálogo
 *                         → si no se consigue, otro escritor está trabajando
 *   2. reconciliar huérfanas
 *   3. calcular el checkpoint inicial, si el pipeline lo usa (ADR 0006)
 *   4. INSERT de la fila nueva, con ese checkpoint dentro
 *
 * **1b antes de 2**: un escritor que se va porque el catálogo está ocupado no
 * deja rastro —ni fila, ni huérfanas cerradas, ni requests—. El orden de los
 * locks y por qué no puede interbloquearse está en `bloqueo.ts`.
 *
 * **4 nunca antes que 2.** Invertirlos haría que el `UPDATE` de huérfanas
 * alcanzara a la fila recién creada y la matara al nacer.
 *
 * **2 solo después de 1.** Sosteniendo el lock del pipeline, ninguna otra
 * ejecución suya puede estar viva; luego toda fila en `running` de ese pipeline
 * está *demostrablemente* muerta. No es una inferencia por antigüedad: es una
 * deducción del estado del servidor. Por eso cerrarlas no incumple la regla 7
 * de `CLAUDE.md`, que prohíbe inventar datos que no se han observado.
 *
 * ⚠️ **`finished_at` de una huérfana marca CUÁNDO LO DETECTAMOS, no cuándo
 * murió.** Ese instante nadie lo observó y no se inventa.
 *
 * ⚠️ **`requests_made` de una huérfana no se corrige ni se reinventa.** Gastó
 * cuota de verdad y sigue contando para el ciclo.
 */
import {
  soltarLockDeCatalogo,
  soltarLockDePipeline,
  tomarLockDeCatalogo,
  tomarLockDePipeline,
} from "./bloqueo.ts";
import type {
  CicloDePresupuesto,
  EjecutorSql,
  EstadoFinal,
  FaseDelSeed,
  FilasAfectadas,
  MetricasDeEjecucion,
  MuestraDeError,
  NombreDePipeline,
  Presupuesto,
  PuntoDeControl,
  Reserva,
} from "./contratos.ts";
import {
  ArranqueDenegado,
  FalloOperativo,
  MOTIVOS_QUE_NO_SON_DE_PRESUPUESTO,
  PresupuestoAgotado,
  escribeCatalogo,
  idDeEjecucion,
} from "./contratos.ts";
import { calcularCiclo, reservar } from "./presupuesto.ts";

/**
 * Cuántos errores representativos se guardan.
 *
 * **Política de los jobs, no una constraint** (`docs/DATA-MODEL.md`): clavarlo
 * en el esquema convertiría cada ajuste en una migración. `error_count` sigue
 * siendo el total real, así que una muestra truncada se ve comparando su tamaño
 * con él — y por eso no hace falta ningún `errors_truncated`.
 */
export const MAXIMO_DE_MUESTRAS = 20;

/** Acumula lo que la fila necesita al cerrarse. */
export interface Medidor {
  /**
   * Declara filas tocadas en una tabla. Se suma a lo ya declarado.
   *
   * ⚠️ **Solo se llama con trabajo ya confirmado.** Si la transacción de datos
   * revierte y nadie declaró nada, `rows_affected` queda `null`, que es la
   * verdad: no hubo efecto medido.
   */
  filasTocadas(tabla: string, cuantas: number): void;
  /** Suma a los contadores de observabilidad. */
  observar(cuentas: {
    readonly multiLinkOffers?: number;
    readonly farFutureExpiries?: number;
  }): void;
  /** Cuenta un error **siempre**, y guarda la muestra solo si aún cabe. */
  registrarError(muestra: MuestraDeError): void;
  instantanea(): MetricasDeEjecucion;
}

export function crearMedidor(maximoDeMuestras = MAXIMO_DE_MUESTRAS): Medidor {
  const filas = new Map<string, number>();
  const muestras: MuestraDeError[] = [];
  let multiLinkOffers = 0;
  let farFutureExpiries = 0;
  let errorCount = 0;

  return {
    filasTocadas(tabla, cuantas) {
      filas.set(tabla, (filas.get(tabla) ?? 0) + cuantas);
    },
    observar(cuentas) {
      multiLinkOffers += cuentas.multiLinkOffers ?? 0;
      farFutureExpiries += cuentas.farFutureExpiries ?? 0;
    },
    registrarError(muestra) {
      errorCount += 1;
      if (muestras.length < maximoDeMuestras) muestras.push(muestra);
    },
    instantanea() {
      const rowsAffected: FilasAfectadas | null =
        filas.size === 0 ? null : Object.fromEntries(filas);
      return {
        rowsAffected,
        multiLinkOffers,
        farFutureExpiries,
        errorCount,
        errorSamples: [...muestras],
      };
    },
  };
}

interface FilaHuerfana {
  readonly id: number;
  readonly requests_made: number;
  readonly started_at: Date;
}

const SQL_HUERFANAS = `
  UPDATE ops_sync_runs
     SET status        = 'failed',
         finished_at   = now(),
         error_count   = error_count + 1,
         error_samples = coalesce(error_samples, '[]'::jsonb) || $2::jsonb
   WHERE pipeline = $1 AND status = 'running' AND finished_at IS NULL
  RETURNING id, requests_made, started_at`;

/**
 * Cierra las ejecuciones que murieron sin cerrarse.
 *
 * **Idempotente por su propio `WHERE`:** repetirla no cambia nada, porque tras
 * la primera pasada ya no queda ninguna fila en `running`.
 */
export async function reconciliarHuerfanas(
  ejecutorOps: EjecutorSql,
  pipeline: NombreDePipeline,
  detectadaPor: string,
): Promise<readonly FilaHuerfana[]> {
  const muestra = JSON.stringify([
    {
      motivo: "ejecucion_huerfana",
      detectada_por: detectadaPor,
      nota: "finished_at es el instante de la DETECCIÓN, no el de la muerte.",
    },
  ]);
  return ejecutorOps.ejecutar<FilaHuerfana>(SQL_HUERFANAS, [pipeline, muestra]);
}

const SQL_ABRIR = `
  INSERT INTO ops_sync_runs
    (pipeline, status, started_at, budget_limit, commit_sha, checkpoint)
  VALUES ($1, 'running', $2, $3, $4, $5::jsonb)
  RETURNING id`;

const SQL_CERRAR = `
  UPDATE ops_sync_runs
     SET status              = $2,
         finished_at         = now(),
         rows_affected       = $3::jsonb,
         multi_link_offers   = $4,
         far_future_expiries = $5,
         error_count         = $6,
         error_samples       = $7::jsonb
   WHERE id = $1`;

/**
 * Abre la fila.
 *
 * ⚖️ **`budget_limit` guarda el umbral operativo (900), no el presupuesto bruto
 * (1000).** Es el techo que de verdad gobernó esta ejecución, y hace que
 * `budget_limit - requests_made` sea el margen realmente utilizable.
 *
 * `checkpoint` nace **con la fila**, antes de la primera reserva (ADR 0006):
 * si el proceso muere después de gastar, el plan sobrevive y la ejecución
 * siguiente lo reanuda. `null` para los pipelines que no lo usan.
 *
 * ⚠️ **Aquí nace el `runId` de todo el sistema**, y aquí se normaliza: el
 * driver lo da como texto (`bigint`), y el resto recibe un `number` seguro
 * (`idDeEjecucion`).
 */
export async function abrirEjecucion(
  ejecutorOps: EjecutorSql,
  opciones: {
    readonly pipeline: NombreDePipeline;
    readonly presupuesto: Presupuesto;
    readonly ahora: Date;
    readonly commitSha: string | null;
    readonly checkpoint?: PuntoDeControl | null;
  },
): Promise<number> {
  const checkpoint = opciones.checkpoint ?? null;
  // `unknown` a propósito: lo que dé el driver no se cree, se normaliza.
  const filas = await ejecutorOps.ejecutar<{ id: unknown }>(SQL_ABRIR, [
    opciones.pipeline,
    opciones.ahora,
    opciones.presupuesto.umbralGlobal,
    opciones.commitSha,
    checkpoint === null ? null : JSON.stringify(checkpoint),
  ]);
  const fila = filas[0];
  if (fila === undefined) throw new Error("El INSERT de ops_sync_runs no devolvió id.");
  return idDeEjecucion(fila.id);
}

/** Cierra la fila con su estado final y todo lo medido. */
export async function cerrarEjecucion(
  ejecutorOps: EjecutorSql,
  runId: number,
  estado: EstadoFinal,
  metricas: MetricasDeEjecucion,
): Promise<void> {
  await ejecutorOps.ejecutar(SQL_CERRAR, [
    runId,
    estado,
    metricas.rowsAffected === null ? null : JSON.stringify(metricas.rowsAffected),
    metricas.multiLinkOffers,
    metricas.farFutureExpiries,
    metricas.errorCount,
    JSON.stringify(metricas.errorSamples),
  ]);
}

/** Lo que el cuerpo de un pipeline recibe para trabajar. */
export interface ContextoDeEjecucion {
  readonly runId: number;
  readonly pipeline: NombreDePipeline;
  readonly presupuesto: Presupuesto;
  readonly ciclo: CicloDePresupuesto;
  readonly medidor: Medidor;
  /**
   * Pide cuota para **una** llamada externa.
   *
   * Lanza `PresupuestoAgotado` si se deniega, para que un bucle de paginación
   * se corte solo en vez de tener que acordarse de mirar un booleano.
   */
  pedirCuota(): Promise<void>;
}

/**
 * Por qué una ejecución no llegó a correr. **Ninguno es un fallo**: sin fila,
 * sin huérfanas cerradas y sin una sola request.
 *
 *   · `ya_hay_una_viva`  — otra ejecución del mismo pipeline (lock A).
 *   · `catalogo_ocupado` — otro pipeline escritor de catálogo (lock C).
 */
export type MotivoDeNoEjecucion = "ya_hay_una_viva" | "catalogo_ocupado";

export type ResultadoDeJob =
  | { readonly ejecutado: false; readonly motivo: MotivoDeNoEjecucion }
  | {
      readonly ejecutado: true;
      readonly runId: number;
      readonly estado: EstadoFinal;
      readonly huerfanasCerradas: readonly FilaHuerfana[];
      readonly metricas: MetricasDeEjecucion;
    };

/**
 * Envuelve el trabajo de un pipeline con toda la maquinaria de `ops_*`.
 *
 * El cuerpo recibe un contexto y **no toca `ops_sync_runs` directamente**: su
 * único trato con la cuota es `pedirCuota()`, y su único trato con la fila es
 * el `medidor`.
 *
 * ⚠️ `ejecutorOps` tiene que venir de una conexión **propia y directa**,
 * distinta de la que use el pipeline para sus datos. Si compartieran
 * transacción, un `ROLLBACK` del pipeline borraría la contabilidad de requests
 * que ya se hicieron.
 */
export async function ejecutarJob(
  ejecutorOps: EjecutorSql,
  opciones: {
    readonly pipeline: NombreDePipeline;
    /**
     * Solo `seed` (ADR 0009 §6): decide si esta ejecución toma el lock de
     * escritor de catálogo (`escribeCatalogo`). Sin fase, un seed lo toma.
     */
    readonly fase?: FaseDelSeed;
    readonly presupuesto: Presupuesto;
    readonly ahora?: Date;
    readonly commitSha?: string | null;
    readonly maximoDeMuestras?: number;
    /**
     * Calcula el checkpoint con el que nace la fila. Se llama **con el lock
     * del pipeline tomado y las huérfanas ya cerradas**, así que puede leer el
     * último checkpoint sin que nadie lo esté moviendo.
     *
     * Si lanza —`ArranqueDenegado` u otra cosa—, la fila se abre **sin
     * checkpoint**, se cierra `failed` con su muestra y **el cuerpo no corre**:
     * 0 requests. La fila sin checkpoint no tapa al anterior, que sigue siendo
     * el último que se leerá.
     */
    readonly checkpointInicial?: (ejecutorOps: EjecutorSql) => Promise<PuntoDeControl>;
  },
  cuerpo: (contexto: ContextoDeEjecucion) => Promise<void>,
): Promise<ResultadoDeJob> {
  const { pipeline, presupuesto } = opciones;
  const ahora = opciones.ahora ?? new Date();
  const commitSha = opciones.commitSha ?? process.env.GITHUB_SHA ?? null;
  // Antes de tomar nada: una fase en un pipeline sin fases no llega a ningún lock.
  const tomaCatalogo = escribeCatalogo(pipeline, opciones.fase);

  // 1 ─ Exclusión mutua. Sin espera: que otra esté viva no es un fallo.
  if (!(await tomarLockDePipeline(ejecutorOps, pipeline))) {
    return { ejecutado: false, motivo: "ya_hay_una_viva" };
  }

  // 1b ─ Escritor de catálogo, con el del pipeline ya tomado. Sin espera.
  let catalogoTomado = false;

  try {
    if (tomaCatalogo) {
      catalogoTomado = await tomarLockDeCatalogo(ejecutorOps);
      if (!catalogoTomado) return { ejecutado: false, motivo: "catalogo_ocupado" };
    }

    // 2 ─ Huérfanas. Solo aquí tiene sentido: sostenemos el lock.
    const huerfanasCerradas = await reconciliarHuerfanas(
      ejecutorOps,
      pipeline,
      `${pipeline}@${ahora.toISOString()}`,
    );

    // 3 ─ El plan, con el lock tomado y las huérfanas ya cerradas.
    let checkpoint: PuntoDeControl | null = null;
    // Envuelto: un `throw null` también es un fallo, y no puede confundirse
    // con «no hubo fallo».
    let arranque: { readonly error: unknown } | null = null;
    if (opciones.checkpointInicial !== undefined) {
      try {
        checkpoint = await opciones.checkpointInicial(ejecutorOps);
      } catch (error) {
        arranque = { error };
      }
    }

    // 4 ─ La fila nueva, después de reconciliar y nunca antes.
    const ciclo = calcularCiclo(ahora, presupuesto.diaDeCiclo);
    const runId = await abrirEjecucion(ejecutorOps, {
      pipeline,
      presupuesto,
      ahora,
      commitSha,
      checkpoint,
    });

    const medidor = crearMedidor(opciones.maximoDeMuestras);

    // El plan era imposible: la fila existe y lo cuenta, pero el cuerpo no
    // corre. Ni una reserva, ni una request.
    if (arranque !== null) {
      const { error } = arranque;
      medidor.registrarError(
        error instanceof ArranqueDenegado
          ? { motivo: error.motivo, mensaje: error.message, ...error.contexto }
          : {
              motivo: "excepcion_al_planificar",
              nombre: error instanceof Error ? error.name : "desconocido",
              mensaje: error instanceof Error ? error.message : String(error),
            },
      );
      const metricas = medidor.instantanea();
      await cerrarEjecucion(ejecutorOps, runId, "failed", metricas);
      return { ejecutado: true, runId, estado: "failed", huerfanasCerradas, metricas };
    }

    let estado: EstadoFinal = "succeeded";

    const contexto: ContextoDeEjecucion = {
      runId,
      pipeline,
      presupuesto,
      ciclo,
      medidor,
      async pedirCuota() {
        const decision: Reserva = await reservar(ejecutorOps, {
          runId,
          pipeline,
          presupuesto,
          cicloDeLaEjecucion: ciclo.clave,
        });
        if (!decision.concedida) {
          throw new PresupuestoAgotado({
            motivo: decision.motivo,
            pipeline,
            consumido: decision.consumido,
            techo: decision.techo,
          });
        }
      },
    };

    try {
      await cuerpo(contexto);
    } catch (error) {
      if (error instanceof PresupuestoAgotado) {
        // El contexto va primero: los tres campos del corte no se pisan.
        medidor.registrarError({
          ...error.contexto,
          motivo: error.motivo,
          consumido: error.consumido,
          techo: error.techo,
        });
        // `frontera_de_ciclo` y `ciclo_desalineado` NO son cortes de
        // presupuesto: no fue la cuota quien paró esto, fue el reloj o la
        // configuración. Marcarlos `budget_stopped` haría creer que el mes se
        // agotó cuando quedaba margen de sobra.
        estado = MOTIVOS_QUE_NO_SON_DE_PRESUPUESTO.includes(error.motivo)
          ? "failed"
          : "budget_stopped";
      } else if (error instanceof FalloOperativo) {
        // Un fallo con nombre: la muestra lleva su motivo, no «excepcion».
        estado = "failed";
        medidor.registrarError({
          ...error.contexto,
          motivo: error.motivo,
          mensaje: error.message,
        });
      } else {
        estado = "failed";
        medidor.registrarError({
          motivo: "excepcion",
          nombre: error instanceof Error ? error.name : "desconocido",
          mensaje: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const metricas = medidor.instantanea();
    await cerrarEjecucion(ejecutorOps, runId, estado, metricas);
    return { ejecutado: true, runId, estado, huerfanasCerradas, metricas };
  } finally {
    // Al revés de como se tomaron: catálogo y después pipeline.
    try {
      if (catalogoTomado) await soltarLockDeCatalogo(ejecutorOps);
    } finally {
      await soltarLockDePipeline(ejecutorOps, pipeline);
    }
  }
}
