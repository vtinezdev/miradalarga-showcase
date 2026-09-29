/**
 * **Lo común a todo job de `/changes` ejecutado por `pnpm job`**: `deltas`,
 * `expiring` y `upcoming`. Cada uno pone su estrategia, su veredicto y su
 * resumen (`deltas/programado.ts`, `expiring/programado.ts`,
 * `upcoming/programado.ts`); esto pone lo que una ejecución **desatendida**
 * necesita y no depende de la estrategia:
 *
 *   · **guardas de destino** redundantes con las de `drizzle.migrate.config.ts`;
 *   · **presupuesto sin overrides** cuando corre en GitHub Actions;
 *   · la **credencial** de la API, sin cambiar su host en Actions;
 *   · **dos conexiones** —ops y datos— abiertas solo tras las guardas;
 *   · la **clasificación** común del resultado en código de salida.
 *
 * ── Códigos de salida comunes ───────────────────────────────────────────────
 *
 *   0  succeeded · lock ocupado —del pipeline o del catálogo— (aviso) · corte
 *      por `tope_por_ejecucion` (aviso)
 *   1  failed
 *   2  corte por techo mensual, umbral global o cuota del proveedor
 *
 * Un pipeline puede **endurecer** esto —`deltas` añade el retraso >72 h—,
 * nunca relajarlo.
 *
 * ⚠️ `pnpm job` no alcanza `production`: el destino tiene que ser la rama de
 * validación, con su hostname exacto y conexión directa. El único llamador que
 * nombra `production` es `seed:primer-deltas --production`, con sus propias
 * guardas (`destino-production.ts`) y una autorización en código atada a la
 * huella del crudo (ADR 0010).
 */
import type { Conexion } from "../ops/conexion.ts";
import type { EjecutorSql, NombreDePipeline, Presupuesto } from "../ops/contratos.ts";
import type { ResultadoDeJob } from "../ops/ejecucion.ts";
import { leerPresupuesto } from "../ops/presupuesto.ts";
import type { FuenteDeCuota, Transporte } from "../ops/transporte.ts";
import { crearTransporte } from "../ops/transporte.ts";
import type { OpcionesDelJobDeCambios } from "./deltas/job.ts";
import { transaccionPorPagina } from "./deltas/job.ts";

export type Entorno = Readonly<Partial<Record<string, string>>>;

/** La única rama contra la que arranca un job programado. */
export const DESTINO_DEL_JOB = "drizzle-schema-v1-test";

/**
 * Las variables que cambian el presupuesto. **En GitHub Actions ninguna puede
 * venir del entorno**: la autorización vive en código, revisada en un diff,
 * no en una variable que cualquiera con acceso al repositorio puede cambiar
 * sin dejar rastro.
 */
export const VARIABLES_DE_PRESUPUESTO = [
  "STREAMING_API_MONTHLY_BUDGET",
  "STREAMING_API_BUDGET_STOP_FRACTION",
  "STREAMING_API_BUDGET_CYCLE_DAY",
  "STREAMING_API_MONTHLY_PIPELINE_BUDGETS",
  "STREAMING_API_PER_RUN_CAPS",
] as const;

function fallar(pipeline: NombreDePipeline, motivo: string): never {
  throw new Error(`El job ${pipeline} se niega a arrancar.\n  ${motivo}`);
}

const enActions = (entorno: Entorno): boolean => entorno.GITHUB_ACTIONS === "true";

/**
 * El presupuesto del job. En GitHub Actions, **solo** el del repositorio: si
 * alguna variable de presupuesto viene definida, no arranca.
 */
export function presupuestoDelJob(
  entorno: Entorno,
  pipeline: NombreDePipeline = "deltas",
): Presupuesto {
  if (enActions(entorno)) {
    const definidas = VARIABLES_DE_PRESUPUESTO.filter(
      (v) => (entorno[v] ?? "").trim() !== "",
    );
    if (definidas.length > 0) {
      fallar(
        pipeline,
        `En GitHub Actions el presupuesto no admite overrides, y vienen definidas: ` +
          `${definidas.join(", ")}.\n  Los techos y topes viven en jobs/ops/presupuesto.ts.`,
      );
    }
  }
  return leerPresupuesto(entorno);
}

/** Lo mínimo que el job necesita saber del destino ya verificado. */
export interface DestinoVerificado {
  readonly url: string;
  readonly hostname: string;
  readonly esConexionDirecta: boolean;
  readonly rama: string;
}

/**
 * La variable con el hostname exacto del destino: la de validación, o la de
 * `production` (`destino-production.ts`), que solo pasa `seed:primer-deltas
 * --production`.
 */
export type VariableDelHost = "NEON_VALIDATION_HOST" | "NEON_PRODUCTION_HOST";

/**
 * Segundo cerrojo, **redundante a propósito** con `verificarDestino`: si esa
 * función cambiara algún día para admitir otra rama, este job seguiría
 * negándose.
 */
export function exigirDestino(
  destino: DestinoVerificado,
  entorno: Entorno,
  pipeline: NombreDePipeline = "deltas",
  admitidos: readonly string[] = [DESTINO_DEL_JOB],
  variableDelHost: VariableDelHost = "NEON_VALIDATION_HOST",
): void {
  if (!admitidos.includes(destino.rama)) {
    fallar(
      pipeline,
      `El destino tiene que ser ${admitidos.map((r) => `"${r}"`).join(" o ")}, no "${destino.rama}".`,
    );
  }
  if (!destino.esConexionDirecta || destino.hostname.includes("-pooler")) {
    fallar(
      pipeline,
      "La conexión tiene que ser directa: los advisory locks no sobreviven al pooler.",
    );
  }
  const esperado = (entorno[variableDelHost] ?? "").trim();
  if (esperado === "" || destino.hostname !== esperado) {
    fallar(
      pipeline,
      `El hostname del destino no coincide exactamente con ${variableDelHost}.`,
    );
  }
}

/** La credencial y el destino de la API. Nunca se imprime la clave. */
export function configuracionDeLaApi(
  entorno: Entorno,
  pipeline: NombreDePipeline = "deltas",
): {
  readonly apiKey: string;
  readonly base?: string;
} {
  const apiKey = (entorno.STREAMING_AVAILABILITY_API_KEY ?? "").trim();
  if (apiKey === "") fallar(pipeline, "Falta STREAMING_AVAILABILITY_API_KEY.");
  const base = (entorno.STREAMING_API_BASE_URL ?? "").trim();
  if (base === "") return { apiKey };
  // Cambiar el host al que viaja la credencial no es una decisión de entorno
  // en una ejecución desatendida.
  if (enActions(entorno)) {
    fallar(
      pipeline,
      "En GitHub Actions no se admite STREAMING_API_BASE_URL: la base es la del código.",
    );
  }
  return { apiKey, base };
}

// ── El veredicto común ───────────────────────────────────────────────────────

export type CodigoDeSalida = 0 | 1 | 2;

export interface VeredictoComun {
  readonly codigo: CodigoDeSalida;
  readonly nivel: "ok" | "aviso" | "atencion" | "error";
  readonly motivo: string;
}

const CORTES_DE_PRESUPUESTO = new Set([
  "tope_por_ejecucion",
  "mensual_del_pipeline",
  "global",
  "cuota_del_proveedor",
]);

/**
 * Función pura: del resultado de `ejecutarJob` al código de salida, **con la
 * política común**. El orden importa: un fallo nunca sale con 0 ni con 2.
 */
export function clasificar(resultado: ResultadoDeJob): VeredictoComun {
  if (!resultado.ejecutado) {
    // Lock del pipeline o del catálogo: ninguno es un fallo, y no gastó nada.
    return { codigo: 0, nivel: "aviso", motivo: resultado.motivo };
  }

  if (resultado.estado === "failed") {
    const primera = resultado.metricas.errorSamples[0];
    const motivo = typeof primera?.motivo === "string" ? primera.motivo : "sin_muestra";
    return { codigo: 1, nivel: "error", motivo };
  }

  if (resultado.estado === "budget_stopped") {
    const corte = resultado.metricas.errorSamples
      .map((m) => m.motivo)
      .find((m): m is string => typeof m === "string" && CORTES_DE_PRESUPUESTO.has(m));
    if (corte === "tope_por_ejecucion") {
      return { codigo: 0, nivel: "aviso", motivo: corte };
    }
    // Mensual, global o proveedor: el plan del mes se rompió. Y un corte sin
    // motivo reconocible tampoco se da por bueno.
    return { codigo: 2, nivel: "atencion", motivo: corte ?? "corte_sin_motivo" };
  }

  return { codigo: 0, nivel: "ok", motivo: "succeeded" };
}

/** La línea del resumen para una ejecución que no llegó a correr. */
export function explicarNoEjecucion(
  pipeline: NombreDePipeline,
  motivo: "ya_hay_una_viva" | "catalogo_ocupado",
): string {
  return motivo === "ya_hay_una_viva"
    ? `Otra ejecución de ${pipeline} sostiene el lock: esta no ha hecho nada.`
    : "Otro pipeline escritor de catálogo sostiene su lock: esta no ha hecho nada. " +
        "La siguiente ejecución lo recupera.";
}

// ── La ejecución ─────────────────────────────────────────────────────────────

export interface DependenciasDelJob {
  readonly entorno: Entorno;
  /** Ya verificado por `verificarDestino`, antes de abrir ninguna conexión. */
  readonly destino: DestinoVerificado;
  readonly conectar: (url: string) => Promise<Conexion>;
  /** Por defecto, `crearTransporte`: el único que llama a `fetch`. */
  readonly crearLlamada?: (fuente: FuenteDeCuota) => Transporte;
  readonly ahora?: Date;
  /** Dónde dejar el manifiesto y el crudo. `null` = sin manifiesto. */
  readonly directorioDeRegistros?: string | null;
  /**
   * Las ramas que este llamador admite. **`pnpm job` no lo pasa**: solo la
   * histórica. Lo pasa `seed:primer-deltas`, con la rama del seed real, y
   * nada más (test de contrato `destinos-por-llamador`).
   */
  readonly destinosAdmitidos?: readonly string[];
  /** Por defecto `NEON_VALIDATION_HOST`. Solo el primer `deltas` de production pasa otra. */
  readonly variableDelHost?: VariableDelHost;
}

/**
 * Las opciones del job de `/changes` que **no** dependen de la estrategia,
 * ya resueltas: conexiones, presupuesto del repositorio, credencial, reloj.
 */
export type OpcionesComunes = Omit<OpcionesDelJobDeCambios, "plan" | "crearRegistro">;

/**
 * Guardas → conexiones → trabajo → cierre. **Todas las negativas ANTES de
 * abrir una conexión.**
 *
 * Dos sesiones: ops (locks y cuota) y datos (páginas y checkpoint). Si
 * compartieran transacción, un `ROLLBACK` de datos borraría cuota gastada.
 */
export async function conGuardasYConexiones<S>(
  pipeline: NombreDePipeline,
  dep: DependenciasDelJob,
  trabajo: (comunes: OpcionesComunes) => Promise<S>,
): Promise<S> {
  exigirDestino(
    dep.destino,
    dep.entorno,
    pipeline,
    dep.destinosAdmitidos,
    dep.variableDelHost,
  );
  const presupuesto = presupuestoDelJob(dep.entorno, pipeline);
  const api = configuracionDeLaApi(dep.entorno, pipeline);
  const ahora = dep.ahora ?? new Date();

  const ops = await dep.conectar(dep.destino.url);
  let datos: Conexion | null = null;
  try {
    datos = await dep.conectar(dep.destino.url);
    const ejecutorDatos: EjecutorSql = datos.ejecutor;
    return await trabajo({
      ejecutorOps: ops.ejecutor,
      ejecutorDatos,
      transaccion: transaccionPorPagina(ejecutorDatos),
      presupuesto,
      crearLlamada: dep.crearLlamada ?? crearTransporte,
      apiKey: api.apiKey,
      ...(api.base === undefined ? {} : { base: api.base }),
      ahora,
      // La fila de ops_sync_runs vive en la misma base que los datos.
      vincularEventos: true,
    });
  } finally {
    await datos?.cerrar();
    await ops.cerrar();
  }
}

/** El sello de un directorio de registros: el instante, sin `:` ni `.`. */
export function selloDeEjecucion(ahora: Date): string {
  return `${ahora.toISOString().replace(/[:.]/g, "-")}-programado`;
}
