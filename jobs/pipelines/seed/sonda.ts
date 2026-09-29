/**
 * **La sonda M1** (ADR 0009 §3, §5): ≤ 10 requests en el ciclo N, una fila
 * `pipeline = 'seed'`, `fase = 'sonda'`, y un crudo propio:
 *
 * ```
 * .seed-runs/<sondaId>/
 *   sonda.json          qué se pide y contra qué se compara, ANTES de la 1.ª request
 *   paginas/01-prime-movie.json …   el cuerpo exacto de cada respuesta
 *   m1.json             resultado: páginas, evaluaciones y decisión por plataforma
 *   SHA256SUMS
 * ```
 *
 *   · **Solo los 10 estratos sin medir**, una página cada uno, en el orden fijo.
 *     Netflix entra con su evidencia del Spike 3, evaluada con las mismas reglas.
 *   · **Las mismas guardias que la captura** (`cuota.ts`) alrededor de cada
 *     request; sin lock de catálogo.
 *   · Un estrato **sin respuesta** (timeout, red) no para la sonda: la request
 *     queda contada y el estrato cuenta como rechazado —su plataforma irá por
 *     `rating`—. Un **corte de cuota** sí la para: `budget_stopped`, y un
 *     resultado incompleto **no sirve para fijar un plan**.
 *   · El resultado vale **solo para una captura que empiece en el ciclo
 *     siguiente** (`cicloClave`): lo impone la captura (`m1_caducada`).
 *
 * No importa el transporte: la fuente se inyecta (`fuente-real.ts`).
 */
import { escribirCheckpoint } from "../../ops/checkpoint.ts";
import type { EjecutorSql, Presupuesto } from "../../ops/contratos.ts";
import { ArranqueDenegado, PresupuestoAgotado } from "../../ops/contratos.ts";
import type { ResultadoDeJob } from "../../ops/ejecucion.ts";
import { ejecutarJob } from "../../ops/ejecucion.ts";
import { calcularCiclo } from "../../ops/presupuesto.ts";
import type { FuenteDePaginas } from "./captura.ts";
import type { AlmacenDeCaptura } from "./crudo/almacen.ts";
import { ESTRATOS_DEL_MVP, idDeOpsComoTexto } from "./crudo/formato.ts";
import { jsonDeFichero, sha256 } from "./crudo/huella.ts";
import { prepararCuota } from "./cuota.ts";
import type { CheckpointDeSonda } from "./fases.ts";
import { VERSION_DEL_CHECKPOINT_DEL_SEED, checkpointDeSondaV1 } from "./fases.ts";
import type {
  EvaluacionDeEstrato,
  PaginaDeSonda,
  ResultadoM1,
  SondaDelSeed,
} from "./m1.ts";
import {
  ESTRATOS_DE_M1,
  FICHERO_DE_LA_SONDA,
  FICHERO_DEL_RESULTADO_M1,
  FORMATO_DEL_RESULTADO_M1,
  PLATAFORMA_CON_EVIDENCIA,
  VERSION_DE_M1,
  decidirOrdenes,
  estratoDeM1,
  evaluarEstratoDeM1,
  queryDeM1,
  resultadoM1V1,
  sondaV1,
  sumasDeSonda,
} from "./m1.ts";

export interface OpcionesDeSonda {
  readonly ejecutorOps: EjecutorSql;
  readonly presupuesto: Presupuesto;
  readonly sonda: SondaDelSeed;
  readonly fuente: FuenteDePaginas;
  readonly almacen: AlmacenDeCaptura;
  readonly reloj: () => Date;
  /** Referencias por defecto (Spike 1), por estrato, ya sin envoltorio. */
  readonly referencias: ReadonlyMap<string, readonly unknown[]>;
  /** Netflix: su evaluación sobre la evidencia del Spike 3, ya hecha. */
  readonly evidencia: readonly EvaluacionDeEstrato[];
  readonly destino: string;
  readonly commitSha?: string | null;
  readonly comprobarCuotaDelProveedor: boolean;
}

export interface ResultadoDeSonda {
  readonly resultado: ResultadoDeJob;
  readonly m1: ResultadoM1 | null;
  readonly huella: string | null;
}

const codificador = new TextEncoder();

export async function ejecutarSonda(
  opciones: OpcionesDeSonda,
): Promise<ResultadoDeSonda> {
  const { almacen, reloj, sonda } = opciones;
  sondaV1.parse(sonda);
  const inicio = reloj();
  const ciclo = calcularCiclo(inicio, opciones.presupuesto.diaDeCiclo);
  const paginas: PaginaDeSonda[] = [];
  const medidas = new Map<string, EvaluacionDeEstrato>();
  let arrancada = false;

  const resultado = await ejecutarJob(
    opciones.ejecutorOps,
    {
      pipeline: "seed",
      fase: "sonda",
      presupuesto: opciones.presupuesto,
      ahora: inicio,
      commitSha: opciones.commitSha ?? null,
      checkpointInicial() {
        if (almacen.listar().length > 0) {
          throw new ArranqueDenegado(
            "crudo_no_vacio",
            "el directorio de la sonda ya tiene ficheros.",
          );
        }
        if (opciones.evidencia.some((e) => e.plataforma !== PLATAFORMA_CON_EVIDENCIA)) {
          throw new ArranqueDenegado(
            "evidencia_ajena",
            "solo Netflix entra por evidencia histórica.",
          );
        }
        arrancada = true;
        return Promise.resolve(
          checkpointDeSondaV1.parse({
            v: VERSION_DEL_CHECKPOINT_DEL_SEED,
            fase: "sonda",
            sondaId: sonda.sondaId,
            cicloClave: ciclo.clave,
            estratosMedidos: [],
            paginasConfirmadas: 0,
          } satisfies CheckpointDeSonda),
        );
      },
    },
    async (contexto) => {
      almacen.escribir(FICHERO_DE_LA_SONDA, codificador.encode(jsonDeFichero(sonda)));
      const cuota = await prepararCuota({
        contexto,
        ejecutorOps: opciones.ejecutorOps,
        comprobarProveedor: opciones.comprobarCuotaDelProveedor,
        reloj,
      });
      for (const e of ESTRATOS_DE_M1) {
        const query = queryDeM1(e);
        const n = paginas.length + 1;
        const antes = cuota.reservas();
        let respuesta: Awaited<ReturnType<FuenteDePaginas>> | null = null;
        let error: string | null = null;
        try {
          respuesta = await opciones.fuente(
            { estrato: estratoDeM1(e), ronda: 1, cursorDeEntrada: null, query },
            cuota.fuente,
          );
        } catch (fallo) {
          // Un corte de cuota para la sonda; un fallo de red solo este estrato.
          if (fallo instanceof PresupuestoAgotado || cuota.reservas() === antes)
            throw fallo;
          error =
            fallo instanceof Error ? `${fallo.name}: ${fallo.message}` : String(fallo);
        }
        const reservadaEn = cuota.ultimaReserva();
        if (cuota.reservas() !== antes + 1 || reservadaEn === null) {
          throw new Error(
            `La fuente no reservó cuota exactamente una vez para ${e.estrato}.`,
          );
        }
        const fichero =
          respuesta === null
            ? null
            : `paginas/${String(n).padStart(2, "0")}-${e.estrato}.json`;
        if (respuesta !== null && fichero !== null) {
          almacen.escribir(fichero, respuesta.cuerpo);
          cuota.observar(respuesta.status, respuesta.cabeceras);
        }
        const c = respuesta?.cabeceras ?? {};
        const usada = Number(c["x-quota-used"]);
        const concedida = Number(c["x-quota-granted"]);
        paginas.push({
          n,
          estrato: e.estrato,
          fichero,
          query: { ...query },
          reservadaEn: reservadaEn.toISOString(),
          respondidaEn: respuesta === null ? null : reloj().toISOString(),
          http: respuesta?.status ?? null,
          bytes: respuesta?.cuerpo.length ?? null,
          sha256: respuesta === null ? null : sha256(respuesta.cuerpo),
          cuota:
            Number.isInteger(usada) &&
            Number.isInteger(concedida) &&
            c["x-quota-reset"] !== undefined
              ? { usada, concedida, reinicio: c["x-quota-reset"] }
              : null,
          error,
        });
        const ref = opciones.referencias.get(e.estrato);
        medidas.set(
          e.estrato,
          evaluarEstratoDeM1({
            estrato: e,
            fuente: "medido",
            pagina: fichero,
            http: respuesta?.status ?? null,
            cuerpo: respuesta?.cuerpo ?? null,
            referencia:
              ref === undefined
                ? null
                : {
                    nombre:
                      sonda.referencias.find((x) => x.estrato === e.estrato)?.ruta ??
                      e.estrato,
                    shows: ref,
                  },
          }),
        );
        await escribirCheckpoint(
          opciones.ejecutorOps,
          contexto.runId,
          checkpointDeSondaV1.parse({
            v: VERSION_DEL_CHECKPOINT_DEL_SEED,
            fase: "sonda",
            sondaId: sonda.sondaId,
            cicloClave: ciclo.clave,
            estratosMedidos: paginas.map((p) => p.estrato),
            paginasConfirmadas: paginas.length,
          }),
        );
      }
    },
  );

  if (!resultado.ejecutado || !arrancada) return { resultado, m1: null, huella: null };

  const evaluaciones: EvaluacionDeEstrato[] = [];
  for (const e of ESTRATOS_DEL_MVP) {
    const ev =
      e.plataforma === PLATAFORMA_CON_EVIDENCIA
        ? opciones.evidencia.find((x) => x.estrato === e.estrato)
        : medidas.get(e.estrato);
    if (ev !== undefined) evaluaciones.push(ev);
  }
  const primera = resultado.metricas.errorSamples[0];
  const m1: ResultadoM1 = resultadoM1V1.parse({
    formato: FORMATO_DEL_RESULTADO_M1,
    v: VERSION_DE_M1,
    sondaId: sonda.sondaId,
    runId: idDeOpsComoTexto(resultado.runId),
    destino: opciones.destino,
    cicloClave: ciclo.clave,
    diaDeCiclo: opciones.presupuesto.diaDeCiclo,
    estado: resultado.estado,
    motivo:
      resultado.estado === "succeeded"
        ? "succeeded"
        : typeof primera?.motivo === "string"
          ? primera.motivo
          : "sin_muestra",
    requestsReservadas: paginas.length,
    paginas,
    evaluaciones,
    decisiones: decidirOrdenes(evaluaciones),
  });
  const bytes = codificador.encode(jsonDeFichero(m1));
  almacen.escribir(FICHERO_DEL_RESULTADO_M1, bytes);
  const ficheros = new Map(
    almacen.listar().map((r) => [r, almacen.leer(r) ?? new Uint8Array()]),
  );
  almacen.escribir("SHA256SUMS", codificador.encode(sumasDeSonda(ficheros)));
  return { resultado, m1, huella: sha256(bytes) };
}
