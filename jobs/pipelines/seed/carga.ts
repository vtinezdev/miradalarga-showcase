/**
 * **La carga del seed**: crudo verificado → catálogo, en **una** transacción
 * (ADR 0009 §5, §9, §10). **0 requests, estructural**: este módulo no importa
 * `transporte.ts` —un test recorre su grafo y lo exige— y nunca llama a
 * `pedirCuota`.
 *
 * ```
 * A pipeline `seed` (try) ──▶ C escritor de catálogo (try) ──▶ transacción:
 *     precondiciones ──▶ plataformas ──▶ capacidades ──▶ catálogo ──▶ ancla
 * ```
 *
 *   · **Separación estricta:** API/captura → crudo inmutable → **carga** →
 *     base de datos. La carga solo acepta un `CrudoVerificado`, que solo
 *     construye `verificarCrudo`.
 *   · **Destino virgen:** sin títulos, ofertas, eventos ni anuncios, y sin
 *     ninguna fila de `deltas`, `expiring`, `upcoming` ni `updated`. Es lo que
 *     hace idénticas dos cargas del mismo crudo y lo que impide que una
 *     observación vieja pise una nueva.
 *   · **Reejecución:** mismo destino, **misma huella** y sin otros escritores →
 *     idempotente (0 inserciones, ids estables, el mismo `S` en una fila
 *     nueva). Con otra huella, `seed_distinto`; con escritores,
 *     `catalogo_ya_mantenido`. Se niega con 0 escrituras.
 *   · **Precondiciones con C tomado y dentro de la transacción:** entre la
 *     comprobación y la escritura nadie más puede escribir.
 *   · **El ancla es la última sentencia**: el checkpoint pasa a `cargada` en la
 *     misma transacción. Si algo falla, `ROLLBACK` completo: ni catálogo ni
 *     ancla. **El ancla existe si y solo si el catálogo existe.**
 *   · **Plazo:** `ahora ≥ S + 72 h` → `ancla_caducada`, antes de abrir la
 *     transacción.
 *
 * Códigos de salida: `0` succeeded · `1` failed —incluida cualquier
 * precondición incumplida— · `2` lock ocupado.
 */
import { escribirCheckpoint } from "../../ops/checkpoint.ts";
import type { EjecutorSql, Presupuesto } from "../../ops/contratos.ts";
import { ArranqueDenegado, FalloOperativo } from "../../ops/contratos.ts";
import type { ResultadoDeJob } from "../../ops/ejecucion.ts";
import { ejecutarJob } from "../../ops/ejecucion.ts";
import type { AnclaDelSeed } from "./ancla.ts";
import { anclaCaducada, leerAnclaDelSeed, vencimientoDelAncla } from "./ancla.ts";
import { CAPACIDADES_MVP } from "./capacidades.ts";
import type { InformeDeSeed } from "./contratos.ts";
import { motivoNoCargable } from "./crudo/formato.ts";
import type { CrudoVerificado } from "./crudo/verificar.ts";
import type { CheckpointDeCarga } from "./fases.ts";
import { VERSION_DEL_CHECKPOINT_DEL_SEED, checkpointDeCargaV1 } from "./fases.ts";
import { ejecutarSeed } from "./index.ts";

/** `BEGIN` / `COMMIT`, con `ROLLBACK` si algo falla. */
export type Transaccion = <T>(trabajo: () => Promise<T>) => Promise<T>;

/** La transacción única de la carga, sobre la conexión de datos. */
export function transaccionUnica(ejecutor: EjecutorSql): Transaccion {
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

/** Los pipelines que mantienen el catálogo después del seed. */
export const ESCRITORES_POSTERIORES = [
  "deltas",
  "expiring",
  "upcoming",
  "updated",
] as const;

/**
 * Lo que decide si el destino es virgen. Una sola sentencia, dentro de la
 * transacción y con el lock de catálogo tomado.
 */
export const SQL_ESTADO_DEL_DESTINO = `
  SELECT (SELECT count(*) FROM external_titles)                     AS titulos,
         (SELECT count(*) FROM external_availability)               AS ofertas,
         (SELECT count(*) FROM external_availability_events)        AS eventos,
         (SELECT count(*) FROM external_availability_announcements) AS anuncios,
         (SELECT count(*) FROM ops_sync_runs
           WHERE pipeline IN ('deltas', 'expiring', 'upcoming', 'updated')) AS escritores`;

export interface EstadoDelDestino {
  readonly titulos: number;
  readonly ofertas: number;
  readonly eventos: number;
  readonly anuncios: number;
  readonly escritores: number;
}

export type DecisionDeCarga =
  | { readonly tipo: "virgen" }
  | { readonly tipo: "reejecucion"; readonly anclaRunId: number }
  | {
      readonly tipo: "negada";
      readonly motivo: "catalogo_ya_mantenido" | "seed_distinto" | "destino_no_virgen";
      readonly detalle: string;
    };

/** Función pura: con el estado del destino y su ancla previa, qué hacer. */
export function decidirCarga(
  estado: EstadoDelDestino,
  anclaPrevia: AnclaDelSeed | null,
  huella: string,
): DecisionDeCarga {
  if (estado.escritores > 0 || estado.eventos > 0 || estado.anuncios > 0) {
    return {
      tipo: "negada",
      motivo: "catalogo_ya_mantenido",
      detalle:
        `el destino ya tiene ${String(estado.escritores)} ejecuciones de pipelines escritores, ` +
        `${String(estado.eventos)} eventos y ${String(estado.anuncios)} anuncios: el seed ` +
        "pisaría observaciones más nuevas.",
    };
  }
  if (anclaPrevia !== null) {
    if (anclaPrevia.checkpoint.huella !== huella) {
      return {
        tipo: "negada",
        motivo: "seed_distinto",
        detalle: `el destino ya se cargó con el crudo ${anclaPrevia.checkpoint.huella}.`,
      };
    }
    return { tipo: "reejecucion", anclaRunId: anclaPrevia.runId };
  }
  if (estado.titulos > 0 || estado.ofertas > 0) {
    return {
      tipo: "negada",
      motivo: "destino_no_virgen",
      detalle: `el destino tiene ${String(estado.titulos)} títulos y ningún ancla del seed.`,
    };
  }
  return { tipo: "virgen" };
}

const numero = (v: unknown): number => (typeof v === "number" ? v : Number(v));

/** Los recuentos que la carga deja en su checkpoint. Salen del crudo: deterministas. */
export function recuentosDeLaCarga(crudo: CrudoVerificado): Record<string, number> {
  const f = crudo.filas;
  let sinIdentidad = 0;
  let sinOfertaMvp = 0;
  for (const c of Object.values(crudo.seleccion.porEstrato)) {
    sinIdentidad += c.sinIdentidad;
    sinOfertaMvp += c.sinOfertaMvp;
  }
  return {
    titulos: f.titulos.length,
    generos: f.generos.length,
    titulos_generos: f.titulosGeneros.length,
    imagenes: f.imagenes.length,
    ofertas: f.ofertas.length,
    opciones: f.opciones.length,
    capacidades: CAPACIDADES_MVP.length,
    descartes: f.descartes.length,
    sin_identidad: sinIdentidad,
    sin_oferta_mvp: sinOfertaMvp,
    paginas: crudo.manifiesto.paginas.length,
  };
}

/** El checkpoint de la carga. Nace `pendiente` y solo pasa a `cargada` al final. */
export function checkpointDeLaCarga(
  crudo: CrudoVerificado,
  estado: CheckpointDeCarga["estado"],
): CheckpointDeCarga {
  return checkpointDeCargaV1.parse({
    v: VERSION_DEL_CHECKPOINT_DEL_SEED,
    fase: "carga",
    estado,
    huella: crudo.huella,
    huellaCanonica: crudo.huellaCanonica,
    capturaId: crudo.plan.capturaId,
    capturaRunIds: [...crudo.cierre.filasDeOps],
    destinoDeLaCaptura: crudo.cierre.destino,
    ancla: crudo.ancla.toISOString(),
    observacion: { desde: crudo.T0.toISOString(), hasta: crudo.T1.toISOString() },
    recuentos: recuentosDeLaCarga(crudo),
  });
}

export interface OpcionesDeCarga {
  /** Conexión de ops: locks y fila de `ops_sync_runs`. Nunca reserva cuota. */
  readonly ejecutorOps: EjecutorSql;
  /** Conexión de datos: la transacción de la carga y el checkpoint final. */
  readonly ejecutorDatos: EjecutorSql;
  readonly transaccion: Transaccion;
  readonly presupuesto: Presupuesto;
  readonly ahora: Date;
  readonly crudo: CrudoVerificado;
  readonly commitSha?: string | null;
}

export interface ResultadoDeCarga {
  readonly resultado: ResultadoDeJob;
  readonly decision: DecisionDeCarga | null;
  /** `null` si la transacción no llegó a confirmarse. */
  readonly informe: InformeDeSeed | null;
}

export async function ejecutarCargaDelSeed(
  opciones: OpcionesDeCarga,
): Promise<ResultadoDeCarga> {
  const { crudo, ahora } = opciones;
  let decision: DecisionDeCarga | null = null;
  let informe: InformeDeSeed | null = null;

  const resultado = await ejecutarJob(
    opciones.ejecutorOps,
    {
      pipeline: "seed",
      fase: "carga",
      presupuesto: opciones.presupuesto,
      ahora,
      commitSha: opciones.commitSha ?? null,
      // Con A y C tomados. Si lanza, la fila cierra `failed` y no se escribe nada.
      checkpointInicial() {
        if (crudo.marca !== "crudo-verificado-v1") {
          throw new ArranqueDenegado(
            "crudo_sin_verificar",
            "la carga solo acepta un crudo verificado.",
          );
        }
        // La regla se vuelve a aplicar aquí, sobre el cierre: nunca media ronda.
        const razon = motivoNoCargable(crudo.cierre);
        if (!crudo.cargable || razon !== null) {
          throw new ArranqueDenegado(
            "crudo_no_cargable",
            `la captura ${crudo.plan.capturaId} terminó ${crudo.cierre.estado}/${crudo.cierre.motivo}` +
              (razon === "ronda_incompleta"
                ? " a mitad de ronda: el crudo es íntegro y reanudable, pero no se carga media ronda."
                : "."),
            { huella: crudo.huella, razon: razon ?? "sin_verificar" },
          );
        }
        if (anclaCaducada(crudo.ancla, ahora)) {
          throw new ArranqueDenegado(
            "ancla_caducada",
            `el ancla ${crudo.ancla.toISOString()} venció el ` +
              `${vencimientoDelAncla(crudo.ancla).toISOString()}: hace falta una captura nueva.`,
            { ancla: crudo.ancla.toISOString(), huella: crudo.huella },
          );
        }
        return Promise.resolve(checkpointDeLaCarga(crudo, "pendiente"));
      },
    },
    async (contexto) => {
      const confirmado = await opciones.transaccion(async () => {
        const [fila] =
          await opciones.ejecutorDatos.ejecutar<Record<string, unknown>>(
            SQL_ESTADO_DEL_DESTINO,
          );
        const estado: EstadoDelDestino = {
          titulos: numero(fila?.titulos),
          ofertas: numero(fila?.ofertas),
          eventos: numero(fila?.eventos),
          anuncios: numero(fila?.anuncios),
          escritores: numero(fila?.escritores),
        };
        const anclaPrevia = await leerAnclaDelSeed(opciones.ejecutorDatos);
        decision = decidirCarga(estado, anclaPrevia, crudo.huella);
        if (decision.tipo === "negada") {
          throw new FalloOperativo(decision.motivo, decision.detalle, {
            huella: crudo.huella,
          });
        }

        const escrito = await ejecutarSeed(opciones.ejecutorDatos, crudo.filas, {
          ahora,
          capacidades: CAPACIDADES_MVP,
        });
        // La ÚLTIMA sentencia: el ancla nace con el COMMIT del catálogo.
        await escribirCheckpoint(
          opciones.ejecutorDatos,
          contexto.runId,
          checkpointDeLaCarga(crudo, "cargada"),
        );
        return escrito;
      });

      // Solo desde aquí cuenta: la transacción ya se confirmó.
      informe = confirmado;
      for (const t of confirmado.tablas) {
        contexto.medidor.filasTocadas(t.tabla, t.insertadas + t.actualizadas);
      }
      contexto.medidor.observar({
        multiLinkOffers: confirmado.multiLinkOffers,
        farFutureExpiries: confirmado.farFutureExpiries,
      });
    },
  );

  return { resultado, decision, informe };
}

/** Del resultado al código de salida: 0 · 1 · 2 (lock ocupado). */
export function codigoDeSalidaDeLaCarga(resultado: ResultadoDeJob): 0 | 1 | 2 {
  if (!resultado.ejecutado) return 2;
  return resultado.estado === "succeeded" ? 0 : 1;
}
