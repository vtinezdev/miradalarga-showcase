/**
 * El job de `/changes`: une el pipeline con `jobs/ops/`. Lo comparten `deltas`,
 * `expiring` y `upcoming`, cada uno con su **estrategia de ventana**.
 *
 * Lo usan hoy los scripts manuales (`scripts/run-deltas-manual.ts`,
 * `scripts/horizonte-manual.ts`) y, para `deltas` y `expiring`, `jobs/run.ts`.
 * **No registra nada por sí mismo.**
 *
 * ── Las dos estrategias de ventana ───────────────────────────────────────────
 *
 *   · **Contigua hacia atrás** — `deltas` y `updated` (`updated/`). Cada
 *     ventana empieza donde terminó la anterior; si una se corta, la siguiente
 *     ejecución la **reanuda** con su cursor (ADR 0006).
 *   · **Horizonte hacia delante** — `expiring` y `upcoming` (`horizonte/`).
 *     Cada ejecución recorre `[ahora, ahora + N días]` **desde su principio**:
 *     el horizonte de ayer ya no es el de hoy, y reanudarlo perseguiría la cola
 *     de una lista caducada. No interpreta ausencias.
 *
 * El job no conoce la diferencia: la estrategia le da el checkpoint inicial,
 * lo avanza tras cada página y le dice si una ausencia significa algo.
 *
 * ── Las piezas, y por qué están separadas ────────────────────────────────────
 *
 *   · **Dos conexiones.** `ejecutorOps` lleva el lock del pipeline y la
 *     contabilidad; `ejecutorDatos`, el catálogo, el histórico **y el avance
 *     del checkpoint**. Si compartieran transacción, un `ROLLBACK` de datos
 *     borraría cuota ya gastada.
 *   · **Una transacción por página** (`transaccionPorPagina`). Estado,
 *     reconciliación, eventos y checkpoint se confirman juntos o no se
 *     confirman: el histórico no se puede reconstruir después, y un checkpoint
 *     adelantado saltaría una página que no se escribió.
 *   · **El plan sale de la estrategia**, con el lock tomado, y se escribe en el
 *     `INSERT` de la fila, antes de la primera reserva. El manifiesto local ya
 *     solo audita.
 *   · **Dos guardias de cuota, en este orden:** la externa (cabeceras del
 *     proveedor) y después la interna (`reservar()`). La externa va primero
 *     para que una denegación suya no deje una reserva sin llamada detrás.
 *     Nace **prearmada** si otra ejecución ya registró un corte del
 *     proveedor que aún no ha reiniciado, y compara cada `x-quota-reset` con
 *     el fin del ciclo del libro.
 *   · **El crudo se guarda al llegar**, antes de parsearlo. Lo pagado no se
 *     pierde aunque todo lo demás falle.
 */
import type { TipoDeCambio } from "../../adapters/contracts.ts";
import { escribirCheckpoint } from "../../ops/checkpoint.ts";
import type {
  EjecutorSql,
  NombreDePipeline,
  Presupuesto,
} from "../../ops/contratos.ts";
import { PresupuestoAgotado } from "../../ops/contratos.ts";
import type { CuotaDelProveedor } from "../../ops/cuota-proveedor.ts";
import {
  buscarCorteVigente,
  crearGuardiaDeCuotaExterna,
  leerCuotaDelProveedor,
} from "../../ops/cuota-proveedor.ts";
import type { ResultadoDeJob } from "../../ops/ejecucion.ts";
import { ejecutarJob } from "../../ops/ejecucion.ts";
import { calcularCiclo } from "../../ops/presupuesto.ts";
import type { FuenteDeCuota, Transporte } from "../../ops/transporte.ts";
import type {
  CheckpointDeCambios,
  CheckpointDeDeltas,
  PoliticaSinCheckpoint,
  TipoDeDeltas,
} from "./checkpoint.ts";
import {
  avanzarCheckpoint,
  checkpointInicial,
  planificarDeltas,
  puntoDeReanudacion,
  tipoDeDeltas,
} from "./checkpoint.ts";
import type { InformeDeDeltas } from "./contratos.ts";
import { ejecutarDeltas } from "./index.ts";
import type { RegistroDePagina, Transaccion } from "./index.ts";
import type { PuntoDeReanudacion, RegistroLocal } from "./manifiesto.ts";
import { ventanaDesdeSegundos, ventanaEnSegundos } from "./manifiesto.ts";
import type { VentanaDeConsulta } from "./origen.ts";

export const PIPELINE: NombreDePipeline = "deltas";

/**
 * ⚖️ **`removed` antes que `new`.** Cada aviso se evalúa contra el snapshot
 * actual, así que el orden no cambia el resultado. Pero si hay corte, se
 * sacrifica la lista más larga (📏 `new` 8 frente a `removed` 3 en 24 h), no la
 * más corta.
 */
export const TIPOS_DE_DELTAS: readonly TipoDeDeltas[] = ["removed", "new"];

// ── Transacciones ────────────────────────────────────────────────────────────

/** `BEGIN` / `COMMIT`, con `ROLLBACK` si algo falla. La de producción. */
export function transaccionPorPagina(ejecutor: EjecutorSql): Transaccion {
  return async (trabajo) => {
    await ejecutor.ejecutar("BEGIN");
    try {
      const resultado = await trabajo();
      await ejecutor.ejecutar("COMMIT");
      return resultado;
    } catch (error) {
      await ejecutor.ejecutar("ROLLBACK");
      throw error;
    }
  };
}

/**
 * La misma frontera **dentro de una transacción exterior** que nunca se
 * confirma: el ensayo y la reproducción. `RELEASE` hace permanente la página
 * *dentro* de la exterior, igual que un `COMMIT` en producción; el `ROLLBACK`
 * final lo deshace todo.
 */
export function transaccionConSavepoint(ejecutor: EjecutorSql): Transaccion {
  return async (trabajo) => {
    await ejecutor.ejecutar("SAVEPOINT deltas_pagina");
    try {
      const resultado = await trabajo();
      await ejecutor.ejecutar("RELEASE SAVEPOINT deltas_pagina");
      return resultado;
    } catch (error) {
      await ejecutor.ejecutar("ROLLBACK TO SAVEPOINT deltas_pagina");
      await ejecutor.ejecutar("RELEASE SAVEPOINT deltas_pagina");
      throw error;
    }
  };
}

// ── La estrategia de ventana ─────────────────────────────────────────────────

/**
 * Lo único que distingue a un pipeline de `/changes` de otro dentro del job.
 * Ver la cabecera del fichero para las dos que existen.
 */
export interface EstrategiaDeVentana<C extends CheckpointDeCambios> {
  readonly pipeline: NombreDePipeline;
  /** Ver `OpcionesDeDeltas.interpretarAusencias`. */
  readonly interpretarAusencias: boolean;
  /**
   * Si un aviso **sin su show** se registra como error de la ejecución
   * (`avisos_sin_show`). Solo `upcoming`: un recorrido suyo con avisos sin
   * atribuir no puede servir de referencia para la vigencia de los anuncios
   * (`upcoming/vigencia.ts`), y `error_count = 0` es parte de esa referencia.
   * El estado de la ejecución no cambia. `deltas` y `expiring` no lo activan.
   */
  readonly atribucionObligatoria?: boolean;
  /** Ver `OpcionesDeDeltas.soloTitulosConocidos`. Solo `updated`. */
  readonly soloTitulosConocidos?: boolean;
  /** Ver `OpcionesDeDeltas.detallarOfertas`. Solo `updated`. */
  readonly detallarOfertas?: boolean;
  /**
   * Ver `OpcionesDeDeltas.reconciliarCalidadDesconocida`. Por defecto, sí;
   * solo `updated` lo pone a `false`.
   */
  readonly reconciliarCalidadDesconocida?: boolean;
  /**
   * El checkpoint inicial de una ejecución que **gasta cuota**. Se llama con
   * el lock del pipeline tomado y las huérfanas cerradas. Lanza
   * `ArranqueDenegado` si no hay plan posible: la fila cierra `failed` sin
   * una sola request.
   */
  planificar(ejecutorOps: EjecutorSql, ahora: Date): Promise<C>;
  /**
   * El checkpoint inicial con una ventana **dada**: ensayo y reproducción de
   * crudo ya pagado. `reanudarEn` solo lo admite una estrategia que reanuda.
   */
  fijo(
    ventana: { readonly from: number; readonly to: number },
    reanudarEn?: { readonly tipo: TipoDeCambio; readonly cursor: string | null },
  ): C;
  /** El checkpoint tras confirmar una página. Función pura. */
  avanzar(actual: C, pagina: RegistroDePagina): C;
}

/**
 * De dónde sale la ventana de esta ejecución.
 *
 *   · `persistente` — de la estrategia. Es el modo de cualquier ejecución que
 *     gaste cuota.
 *   · `fijo` — la da el llamador. Solo para ensayar y reproducir **crudo ya
 *     pagado**, donde la ventana es la que se grabó y no la que tocaría hoy.
 *     El checkpoint se escribe igual, desde el `INSERT`.
 */
export type PlanDeCambios =
  | { readonly origen: "persistente" }
  | {
      readonly origen: "fijo";
      readonly ventana: VentanaDeConsulta;
      readonly reanudarEn?: {
        readonly tipo: TipoDeCambio;
        readonly cursor: string | null;
      };
    };

/**
 * El plan de `deltas`: el de siempre, con la política para cuando **no existe
 * ningún checkpoint** previo.
 *
 *   · `persistente` — del último `ops_sync_runs.checkpoint` de `deltas`:
 *     reanuda, o sigue contigua.
 *   · `fijo` — ver `PlanDeCambios`.
 */
export type PlanDelJob =
  | { readonly origen: "persistente"; readonly sinCheckpoint: PoliticaSinCheckpoint }
  | {
      readonly origen: "fijo";
      readonly ventana: VentanaDeConsulta;
      readonly reanudarEn?: {
        readonly tipo: TipoDeDeltas;
        readonly cursor: string | null;
      };
    };

/** Lo que el manifiesto local necesita saber al nacer, cuando el plan ya existe. */
export interface CabeceraDelRegistro {
  readonly ahora: Date;
  readonly ventana: VentanaDeConsulta;
  readonly tipos: readonly TipoDeCambio[];
  readonly reanudaDe: PuntoDeReanudacion | null;
}

/** La estrategia **contigua hacia atrás**: la de `deltas`, sin cambios. */
export function estrategiaDeDeltas(
  sinCheckpoint: PoliticaSinCheckpoint,
  tipos: readonly TipoDeDeltas[] = TIPOS_DE_DELTAS,
): EstrategiaDeVentana<CheckpointDeDeltas> {
  return {
    pipeline: PIPELINE,
    interpretarAusencias: true,
    planificar: (ejecutorOps, ahora) =>
      planificarDeltas(ejecutorOps, { ahora, sinCheckpoint, tipos }),
    fijo: (ventana, reanudarEn) =>
      checkpointInicial({
        ventana,
        tipos,
        ...(reanudarEn === undefined
          ? {}
          : {
              pendiente: {
                changeType: tipoDeDeltas.parse(reanudarEn.tipo),
                cursorDeEntrada: reanudarEn.cursor,
              },
            }),
      }),
    avanzar: avanzarCheckpoint,
  };
}

// ── El job ───────────────────────────────────────────────────────────────────

export interface OpcionesDelJobDeCambios {
  readonly ejecutorOps: EjecutorSql;
  readonly ejecutorDatos: EjecutorSql;
  readonly transaccion: Transaccion;
  readonly presupuesto: Presupuesto;
  /**
   * Construye el transporte a partir de la fuente de cuota. En real es
   * `crearTransporte`, el único que llama a `fetch`; en ensayo y reproducción,
   * uno que sirve ficheros **pasando igualmente por la fuente de cuota**.
   */
  readonly crearLlamada: (fuente: FuenteDeCuota) => Transporte;
  readonly apiKey: string;
  readonly base?: string;
  readonly plan: PlanDeCambios;
  readonly ahora: Date;
  /**
   * El manifiesto local, **para auditar y reproducir**. Se crea cuando el
   * plan ya se conoce, porque hasta entonces nadie sabe qué ventana se pide.
   * `null` = sin manifiesto. No decide nada: reanudar lo decide la base.
   */
  readonly crearRegistro: ((cabecera: CabeceraDelRegistro) => RegistroLocal) | null;
  /**
   * `true` si la fila de `ops_sync_runs` vive **en la misma base de datos que
   * los datos**, que es el caso de toda ejecución real. Decide dos cosas:
   *
   *   · los eventos cuelgan de `sync_run_id` (FK `RESTRICT`);
   *   · el checkpoint se avanza por `ejecutorDatos`, **dentro** de la
   *     transacción de la página.
   *
   * `false` en el ensayo y la reproducción: su fila vive en memoria, y un
   * `UPDATE` sobre Neon apuntaría a un id que allí no existe —o, peor, a la
   * fila de otra ejecución—. Su checkpoint va al libro en memoria.
   */
  readonly vincularEventos: boolean;
  readonly commitSha?: string | null;
}

export interface OpcionesDelJobDeDeltas extends Omit<OpcionesDelJobDeCambios, "plan"> {
  readonly plan: PlanDelJob;
  /** Para una ventana nueva. Una reanudación usa los del checkpoint. */
  readonly tipos?: readonly TipoDeDeltas[];
}

export interface ContadoresDeRequests {
  /** Reservas concedidas: **lo que se gastó**. */
  readonly reservasConcedidas: number;
  /** Respuestas recibidas, con cualquier estado HTTP. */
  readonly respuestas: number;
  readonly respuestasOk: number;
}

export interface ResultadoDelJobDeCambios<C extends CheckpointDeCambios> {
  readonly resultado: ResultadoDeJob;
  /** `null` si el pipeline no terminó. */
  readonly informe: InformeDeDeltas | null;
  readonly contadores: ContadoresDeRequests;
  readonly cuotaDelProveedor: readonly CuotaDelProveedor[];
  /** Desde dónde seguir, si quedó algo sin procesar. */
  readonly reanudacion: PuntoDeReanudacion | null;
  /**
   * El último checkpoint **confirmado** de esta ejecución: lo mismo que quedó
   * en su fila. `null` si ni siquiera hubo plan.
   */
  readonly checkpoint: C | null;
}

export type ResultadoDelJobDeDeltas = ResultadoDelJobDeCambios<CheckpointDeDeltas>;

export async function ejecutarJobDeDeltas(
  opciones: OpcionesDelJobDeDeltas,
): Promise<ResultadoDelJobDeDeltas> {
  const { plan, tipos, ...resto } = opciones;
  return ejecutarJobDeCambios(
    {
      ...resto,
      plan: plan.origen === "persistente" ? { origen: "persistente" } : plan,
    },
    estrategiaDeDeltas(
      // Con un plan fijo la política no se consulta: la ventana ya está dada.
      plan.origen === "persistente" ? plan.sinCheckpoint : "prohibido",
      tipos ?? TIPOS_DE_DELTAS,
    ),
  );
}

export async function ejecutarJobDeCambios<C extends CheckpointDeCambios>(
  opciones: OpcionesDelJobDeCambios,
  estrategia: EstrategiaDeVentana<C>,
): Promise<ResultadoDelJobDeCambios<C>> {
  const { plan } = opciones;
  const pipeline = estrategia.pipeline;

  // El mismo ciclo que calcula `ejecutarJob` con el mismo `ahora`: la guardia
  // compara cada `x-quota-reset` con SU fin.
  const ciclo = calcularCiclo(opciones.ahora, opciones.presupuesto.diaDeCiclo);
  const guardia = crearGuardiaDeCuotaExterna(pipeline, { finDelCiclo: ciclo.fin });
  let reservasConcedidas = 0;
  let respuestas = 0;
  let respuestasOk = 0;
  let informe: InformeDeDeltas | null = null;
  let registro: RegistroLocal | null = null;

  // El último checkpoint CONFIRMADO. Nace en el INSERT y solo avanza tras el
  // COMMIT de una página: si la página falla, sigue apuntando a ella.
  let confirmado: C | null = null;
  const actual = (): C => {
    if (confirmado === null)
      throw new Error(`${pipeline} corre sin checkpoint inicial.`);
    return confirmado;
  };

  // ⚠️ `maximoDePaginas` = tope + 1. Así el que corta es SIEMPRE `reservar()`,
  // que deja la fila en `budget_stopped` con su muestra. Con `tope` a secas, un
  // job de un solo tipo agotaría las páginas antes que la cuota y cerraría
  // `succeeded` con avisos sin ver.
  const maximoDePaginas = opciones.presupuesto.topePorEjecucion[pipeline] + 1;

  // Dónde se avanza el checkpoint: en la transacción de la página si la fila
  // está en la misma base que los datos; en el libro en memoria si no.
  const escritorDelCheckpoint = opciones.vincularEventos
    ? opciones.ejecutorDatos
    : opciones.ejecutorOps;

  const resultado = await ejecutarJob(
    opciones.ejecutorOps,
    {
      pipeline,
      presupuesto: opciones.presupuesto,
      ahora: opciones.ahora,
      commitSha: opciones.commitSha ?? null,
      // Con el lock tomado y las huérfanas cerradas. Si lanza, la fila nace
      // sin checkpoint, cierra `failed` y el cuerpo no corre: 0 requests.
      async checkpointInicial(ejecutorOps) {
        confirmado =
          plan.origen === "persistente"
            ? await estrategia.planificar(ejecutorOps, opciones.ahora)
            : estrategia.fijo(ventanaEnSegundos(plan.ventana), plan.reanudarEn);
        return confirmado;
      },
    },
    async (contexto) => {
      const inicial = actual();
      const pendienteInicial = inicial.pendiente;
      if (pendienteInicial === null) {
        throw new Error("Un plan nuevo no puede nacer con la ventana ya agotada.");
      }
      const ventana = ventanaDesdeSegundos(inicial.ventana);
      const reanuda =
        inicial.reanudaDe !== null ||
        (plan.origen === "fijo" && plan.reanudarEn !== undefined);

      registro =
        opciones.crearRegistro?.({
          ahora: opciones.ahora,
          ventana,
          tipos: inicial.tipos,
          reanudaDe: reanuda ? puntoDeReanudacion(inicial) : null,
        }) ?? null;
      registro?.fijarRunId(opciones.vincularEventos ? contexto.runId : null);

      // Antes de la primera request: si el proveedor ya dijo «90 %» y no ha
      // reiniciado, esta ejecución no gasta ni una para volver a oírlo.
      const corte = await buscarCorteVigente(opciones.ejecutorOps, {
        ciclo: contexto.ciclo,
        ahora: opciones.ahora,
      });
      if (corte !== null) guardia.prearmar(corte);

      const fuente: FuenteDeCuota = {
        pipeline,
        async pedirCuota() {
          // 1 · externa · 2 · interna. Si la externa se niega, no hay reserva.
          guardia.comprobar();
          await contexto.pedirCuota();
          reservasConcedidas++;
          registro?.anotarReserva();
        },
      };
      const base = opciones.crearLlamada(fuente);

      const transporte: Transporte = async (url, init) => {
        const respuesta = await base(url, init);
        respuestas++;
        // El crudo, AL LLEGAR: antes de que nada pueda fallar al entenderlo.
        const cuerpo = await respuesta.text();
        registro?.guardarRespuesta({
          url,
          status: respuesta.status,
          cabeceras: respuesta.headers,
          cuerpo,
        });
        if (respuesta.ok) {
          respuestasOk++;
          guardia.observar(respuesta.headers);
          const cuota = leerCuotaDelProveedor(respuesta.headers);
          if (cuota !== null) registro?.anotarCuota(cuota);
        }
        return new Response(cuerpo, {
          status: respuesta.status,
          statusText: respuesta.statusText,
          headers: respuesta.headers,
        });
      };

      // El checkpoint que la página en curso ESCRIBIÓ, a la espera de saber si
      // su transacción se confirma.
      let propuesto: C | null = null;

      try {
        informe = await ejecutarDeltas({
          ejecutor: opciones.ejecutorDatos,
          peticion: {
            transporte,
            apiKey: opciones.apiKey,
            ...(opciones.base === undefined ? {} : { base: opciones.base }),
          },
          tipos: inicial.tipos,
          ventana,
          ahora: opciones.ahora,
          maximoDePaginas,
          runId: opciones.vincularEventos ? contexto.runId : null,
          transaccion: opciones.transaccion,
          interpretarAusencias: estrategia.interpretarAusencias,
          ...(estrategia.soloTitulosConocidos === true
            ? { soloTitulosConocidos: true }
            : {}),
          ...(estrategia.detallarOfertas === true ? { detallarOfertas: true } : {}),
          ...(estrategia.reconciliarCalidadDesconocida === false
            ? { reconciliarCalidadDesconocida: false }
            : {}),
          reanudarEn: {
            tipo: pendienteInicial.changeType,
            cursor: pendienteInicial.cursorDeEntrada,
          },
          observador: {
            async dentroDeLaTransaccion(r) {
              propuesto = null;
              const siguiente = estrategia.avanzar(actual(), r);
              await escribirCheckpoint(
                escritorDelCheckpoint,
                contexto.runId,
                siguiente,
              );
              propuesto = siguiente;
            },
            alConfirmarPagina(r) {
              // Solo desde aquí cuenta: la transacción ya se confirmó.
              if (propuesto !== null) confirmado = propuesto;
              propuesto = null;
              for (const [tabla, n] of Object.entries(r.filasPorTabla)) {
                contexto.medidor.filasTocadas(tabla, n);
              }
              contexto.medidor.observar({
                multiLinkOffers: r.multiLinkOffers,
                farFutureExpiries: r.farFutureExpiries,
              });
              registro?.anotarPagina(r);
            },
          },
        });
      } catch (error) {
        const punto = puntoDeReanudacion(actual());
        // El corte de cuota sube con su punto de reanudación DENTRO: así llega
        // a `error_samples` en la misma muestra, sin inflar `error_count`.
        if (error instanceof PresupuestoAgotado && punto !== null) {
          throw error.conContexto({ reanudacion: punto });
        }
        throw error;
      }
      registro?.anotarResumen(informe);
      if (estrategia.atribucionObligatoria === true && informe.avisosSinShow > 0) {
        contexto.medidor.registrarError({
          motivo: "avisos_sin_show",
          avisos: informe.avisosSinShow,
          // Solo si los hay: la muestra de siempre no cambia de forma.
          ...(informe.avisosSinIdentidad > 0
            ? { sinIdentidad: informe.avisosSinIdentidad }
            : {}),
        });
      }

      // Red de seguridad: con `maximoDePaginas = tope + 1` no debería pasar.
      // Si pasa, no puede cerrar `succeeded`: quedaron avisos sin ver. El
      // checkpoint ya apunta a la página que falta.
      const noAgotada = informe.listasNoAgotadas[0];
      if (noAgotada !== undefined) {
        throw new Error(
          `La lista "${noAgotada.tipo}" terminó con hasMore sin corte de presupuesto: ` +
            "quedaron avisos sin procesar.",
        );
      }
    },
  );

  const reanudacion = confirmado === null ? null : puntoDeReanudacion(confirmado);
  // TS no ve la asignación dentro del callback: se lee a través de una variable.
  const registroFinal = registro as RegistroLocal | null;
  if (registroFinal !== null) {
    registroFinal.cerrar(
      resultado.ejecutado ? resultado.estado : "failed",
      reanudacion,
    );
  }

  return {
    resultado,
    informe,
    contadores: { reservasConcedidas, respuestas, respuestasOk },
    cuotaDelProveedor: guardia.observaciones(),
    reanudacion,
    checkpoint: confirmado as C | null,
  };
}
