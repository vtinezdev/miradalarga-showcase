/**
 * Tipos, identidades y configuración del plano `ops_*`.
 *
 * Este fichero no habla con nada: define el vocabulario que usan
 * `presupuesto.ts`, `bloqueo.ts`, `ejecucion.ts` y `transporte.ts`. Es la raíz
 * de la dependencia dentro de `jobs/ops/`, igual que `adapters/contracts.ts` lo
 * es de la capa anticorrupción.
 *
 * Las formas de `rows_affected` y `error_samples` se importan de
 * `src/db/schema/operacion.ts` **como tipos**: hay una sola definición, y la
 * importación se borra en compilación (`verbatimModuleSyntax`).
 */
import type {
  FilasAfectadas,
  MuestraDeError,
  PuntoDeControl,
} from "../../src/db/schema/operacion.ts";

export type { FilasAfectadas, MuestraDeError, PuntoDeControl };

/**
 * Lo único que este módulo necesita de una conexión.
 *
 * Promovido desde `jobs/pipelines/seed/contratos.ts`, que ahora lo reexporta:
 * la dependencia va de un pipeline hacia la infraestructura, nunca al revés.
 */
export interface EjecutorSql {
  ejecutar<T>(texto: string, valores?: readonly unknown[]): Promise<readonly T[]>;
}

/**
 * Vocabulario cerrado de pipelines.
 *
 * `ops_sync_runs.pipeline` es `text`, no un enum de PostgreSQL. Una errata
 * —`"delta"` en vez de `"deltas"`— partiría la contabilidad mensual en dos
 * grupos sin que nada fallara, y el techo por pipeline dejaría de aplicarse.
 * La unión cerrada es lo que convierte esa errata en un error de compilación.
 */
export const NOMBRES_DE_PIPELINE = [
  "seed",
  "deltas",
  "expiring",
  "upcoming",
  "updated",
  "popularity",
  "reconcile",
  "enrich",
  "scoring",
  "changes_validation",
] as const;

/**
 * Pipelines **técnicos**: harnesses manuales de validación, no ingesta.
 *
 * ⚖️ Existen por una razón de contabilidad, no de producto. Un harness que
 * mide `/changes` gasta requests de verdad, y esas requests **tienen que
 * quedar auditadas en `ops_sync_runs`**; pero imputarlas a `deltas`,
 * `expiring` o `upcoming` falsearía el consumo de tres pipelines productivos
 * y se comería un presupuesto mensual que no es suyo. Con nombre propio, el
 * gasto se ve y no contamina a nadie.
 *
 * **No son productivos y no se programan jamás:** no se registran en
 * `jobs/run.ts`, no tienen workflow y no entran en ningún cron. Se ejecutan a
 * mano, con aprobación explícita, y su techo por defecto es **0** como el de
 * todos los demás.
 */
export const PIPELINES_TECNICOS = ["changes_validation"] as const;

export type PipelineTecnico = (typeof PIPELINES_TECNICOS)[number];

export function esPipelineTecnico(nombre: NombreDePipeline): boolean {
  return (PIPELINES_TECNICOS as readonly string[]).includes(nombre);
}

export type NombreDePipeline = (typeof NOMBRES_DE_PIPELINE)[number];

/**
 * Identidad numérica de cada pipeline para el advisory lock.
 *
 * ⚖️ **Enteros asignados a mano, nunca `hashtext(pipeline)`.** Una colisión de
 * hash no daría un error: haría que **dos pipelines distintos se excluyeran
 * mutuamente**, un bloqueo intermitente que nadie sabría explicar. Además un
 * entero explícito se lee directamente en `pg_locks` durante una incidencia.
 *
 * **Los números son identidad. No se reordenan, no se reutilizan.** Si un
 * pipeline desaparece, su número muere con él.
 */
export const PIPELINE_ID: Readonly<Record<NombreDePipeline, number>> = {
  seed: 1,
  deltas: 2,
  expiring: 3,
  upcoming: 4,
  updated: 5,
  popularity: 6,
  reconcile: 7,
  enrich: 8,
  scoring: 9,
  // Técnico: harness manual de validación de /changes. Nunca productivo.
  changes_validation: 10,
};

/**
 * Las tres fases del seed (ADR 0009 §5). Todas son `pipeline = 'seed'`; se
 * distinguen en su checkpoint y en si escriben catálogo.
 *
 *   · `sonda`   — M1: ≤ 10 páginas de medición. API → crudo.
 *   · `captura` — API → crudo inmutable. No escribe ni una fila de catálogo.
 *   · `carga`   — crudo → catálogo, **0 requests**.
 */
export const FASES_DEL_SEED = ["sonda", "captura", "carga"] as const;

export type FaseDelSeed = (typeof FASES_DEL_SEED)[number];

/**
 * **Qué fase del seed escribe catálogo** (ADR 0009 §6). Mapa cerrado, fijado
 * por test.
 *
 * ⚖️ La sonda y la captura **no** toman el lock de escritor de catálogo: sus
 * únicas escrituras son su propia fila de `ops_sync_runs` y su checkpoint, y
 * sostenerlo durante ~400 requests bloquearía a `deltas`, `expiring` y
 * `upcoming` sin proteger ninguna escritura local. La carga sí: escribe el
 * catálogo entero y comprueba sus precondiciones con el lock tomado.
 */
export const ESCRIBE_CATALOGO_POR_FASE_DEL_SEED: Readonly<
  Record<FaseDelSeed, boolean>
> = {
  sonda: false,
  captura: false,
  carga: true,
};

/**
 * **Qué pipelines escriben el catálogo** (`external_*`) y, por tanto, toman el
 * lock compartido de escritor de catálogo (`bloqueo.ts`).
 *
 * ⚖️ **Mapa cerrado, no una lista.** Un pipeline nuevo sin declarar aquí no
 * compila: decidir si escribe catálogo es obligatorio, no un olvido posible.
 *
 *   · `true`  — escriben títulos, ofertas u opciones: dos a la vez podrían
 *     pisarse el mismo estado, y `deltas` + `expiring` comparten tablas.
 *   · `false` — `popularity` escribe capturas, `scoring` solo lee el catálogo y
 *     `changes_validation` es un harness técnico. No tienen por qué esperar a
 *     nadie ni hacer esperar a nadie.
 *   · `"por_fase"` — **solo `seed`** (ADR 0009 §6): lo decide
 *     `ESCRIBE_CATALOGO_POR_FASE_DEL_SEED`. Ver `escribeCatalogo`.
 */
export const ESCRIBE_CATALOGO: Readonly<
  Record<NombreDePipeline, boolean | "por_fase">
> = {
  seed: "por_fase",
  deltas: true,
  expiring: true,
  upcoming: true,
  updated: true,
  reconcile: true,
  enrich: true,
  popularity: false,
  scoring: false,
  changes_validation: false,
};

/**
 * Si una ejecución toma el lock de escritor de catálogo.
 *
 * ⚖️ **Un seed sin fase declarada lo toma**, como antes del refinamiento: el
 * lado seguro es excluir de más, nunca de menos. Solo una fase declarada que
 * no escribe —`sonda`, `captura`— lo evita. Y una fase en un pipeline que no
 * es `seed` es un error de programación, no algo que se ignore.
 */
export function escribeCatalogo(
  pipeline: NombreDePipeline,
  fase?: FaseDelSeed,
): boolean {
  const politica = ESCRIBE_CATALOGO[pipeline];
  if (politica !== "por_fase") {
    if (fase !== undefined) {
      throw new Error(`El pipeline "${pipeline}" no tiene fases; "${fase}" no aplica.`);
    }
    return politica;
  }
  return fase === undefined ? true : ESCRIBE_CATALOGO_POR_FASE_DEL_SEED[fase];
}

/**
 * **El id de una fila de `ops_sync_runs`, como lo ve el resto del sistema:
 * un `number` entero, positivo y seguro.**
 *
 * 📏 `ops_sync_runs.id` es `bigint`, y el driver de Neon —como `pg`— devuelve
 * `int8` como **texto** (`"33"`). Tipar ese valor como `number` sin
 * convertirlo era mentir: `33 === "33"` es `false`, y así falló una
 * comprobación de `db:validate:checkpoint` con la fila correcta.
 *
 * Se normaliza **una vez, en la frontera** donde el id sale de la base, y
 * nadie más reparte `Number(...)`. Acepta lo que puede dar un driver
 * —`string`, `number` o `bigint`— y **falla** si no representa un entero
 * positivo exacto: un id redondeado por pasar de `Number.MAX_SAFE_INTEGER`
 * apuntaría a otra fila sin que nada lo dijera.
 */
export function idDeEjecucion(valor: unknown): number {
  let n: number;
  if (typeof valor === "number") {
    n = valor;
  } else if (typeof valor === "bigint") {
    // Se compara como bigint ANTES de convertir: `Number()` redondea en silencio.
    if (valor > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        `Id de ejecución fuera del rango seguro de number: ${valor.toString()}.`,
      );
    }
    n = Number(valor);
  } else if (typeof valor === "string" && /^[0-9]+$/.test(valor)) {
    n = Number(valor);
  } else {
    throw new Error(
      `Id de ejecución no numérico: ${JSON.stringify(valor) ?? String(valor)} (${typeof valor}).`,
    );
  }
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(
      `Id de ejecución no representable como entero positivo seguro: ${String(valor)}.`,
    );
  }
  return n;
}

/** Los cuatro valores del enum `sync_run_status`. */
export type EstadoDeEjecucion = "running" | "succeeded" | "failed" | "budget_stopped";

/** Estados con los que una ejecución puede cerrarse. `running` no cierra nada. */
export type EstadoFinal = Exclude<EstadoDeEjecucion, "running">;

/**
 * Por qué se denegó una reserva. Cada motivo es un techo distinto.
 *
 * Los nombres dicen su **unidad** a propósito: `mensual_del_pipeline` y
 * `tope_por_ejecucion` miden cosas diferentes, y llamarlos «pipeline» y
 * «ejecución» fue parte de lo que permitió confundirlas.
 */
export type MotivoDeDenegacion =
  | "global"
  | "mensual_del_pipeline"
  | "tope_por_ejecucion"
  | "frontera_de_ciclo"
  /**
   * El contador **del proveedor** (`x-quota-used`) alcanzó el 90 % de su
   * `x-quota-granted`. No lo decide `reservar()` sino `cuota-proveedor.ts`:
   * es la comprobación externa, y nuestro libro interno puede ir por detrás
   * (📏 las requests de los spikes nunca entraron en `ops_sync_runs`).
   */
  | "cuota_del_proveedor"
  /**
   * `x-quota-reset` **no coincide** con el `fin` del ciclo del libro. No es un
   * corte de cuota: es la configuración del ciclo, que ya no refleja al
   * proveedor. Acaba en `failed`, igual que `frontera_de_ciclo`.
   */
  | "ciclo_desalineado";

/**
 * Motivos que viajan como `PresupuestoAgotado` —porque tienen que cortar la
 * paginación igual que un corte de cuota— pero **no son de presupuesto**: los
 * causa el reloj o la configuración, no el consumo. Cierran `failed`, nunca
 * `budget_stopped`, para que nadie crea que el mes se agotó.
 */
export const MOTIVOS_QUE_NO_SON_DE_PRESUPUESTO: readonly MotivoDeDenegacion[] = [
  "frontera_de_ciclo",
  "ciclo_desalineado",
];

/**
 * Una reserva denegada.
 *
 * Clase propia y no un `Error` cualquiera: el runner tiene que poder distinguir
 * «el presupuesto paró esto» de «esto se rompió». Confundirlos convertiría un
 * `budget_stopped` en un `failed`, y el corte de cuota dejaría de verse.
 *
 * `frontera_de_ciclo` y `ciclo_desalineado` son la excepción y **sí acaban en
 * `failed`**: no fue el presupuesto quien paró la ejecución, fue el reloj o la
 * configuración (`MOTIVOS_QUE_NO_SON_DE_PRESUPUESTO`).
 */
export class PresupuestoAgotado extends Error {
  readonly motivo: MotivoDeDenegacion;
  readonly pipeline: NombreDePipeline;
  readonly consumido: number;
  readonly techo: number;
  /**
   * Contexto auditable que viaja **tal cual** a `error_samples`: las
   * cabeceras del proveedor que motivaron el corte, o el punto exacto desde el
   * que reanudar. Sin él, la muestra diría que se paró pero no dónde.
   */
  readonly contexto: Readonly<Record<string, unknown>>;

  constructor(detalle: {
    readonly motivo: MotivoDeDenegacion;
    readonly pipeline: NombreDePipeline;
    readonly consumido: number;
    readonly techo: number;
    readonly contexto?: Readonly<Record<string, unknown>>;
  }) {
    super(
      `Reserva denegada (${detalle.motivo}) para "${detalle.pipeline}": ` +
        `${String(detalle.consumido)} consumidas frente a un techo de ${String(detalle.techo)}.`,
    );
    this.name = "PresupuestoAgotado";
    this.motivo = detalle.motivo;
    this.pipeline = detalle.pipeline;
    this.consumido = detalle.consumido;
    this.techo = detalle.techo;
    this.contexto = detalle.contexto ?? {};
  }

  /** La misma denegación con más contexto. El original no se muta. */
  conContexto(extra: Readonly<Record<string, unknown>>): PresupuestoAgotado {
    return new PresupuestoAgotado({
      motivo: this.motivo,
      pipeline: this.pipeline,
      consumido: this.consumido,
      techo: this.techo,
      contexto: { ...this.contexto, ...extra },
    });
  }
}

/**
 * **La ejecución no puede ni empezar**: su plan es imposible o ilegible.
 *
 * Se lanza al calcular el checkpoint inicial, **antes de la primera reserva**.
 * `ejecutarJob` abre igualmente la fila —sin checkpoint—, la cierra `failed`
 * con una muestra que lleva este `motivo` y su `contexto`, y **no ejecuta el
 * cuerpo**: 0 requests.
 *
 * No es un `PresupuestoAgotado`: aquí nadie pidió cuota. Es un checkpoint que
 * no se entiende, un hueco que `/changes` ya no puede cubrir o un arranque que
 * no tiene de dónde partir.
 */
export class ArranqueDenegado extends Error {
  readonly motivo: string;
  readonly contexto: Readonly<Record<string, unknown>>;

  constructor(motivo: string, mensaje: string, contexto: Record<string, unknown> = {}) {
    super(`Arranque denegado (${motivo}): ${mensaje}`);
    this.name = "ArranqueDenegado";
    this.motivo = motivo;
    this.contexto = contexto;
  }
}

/**
 * **La ejecución no puede seguir, y no es por presupuesto.** El proveedor
 * respondió algo con lo que continuar sería gastar cuota sin avanzar —un
 * cursor que no progresa—. `ejecutarJob` cierra la fila `failed` con una
 * muestra que lleva este `motivo` y su `contexto`: el fallo se ve por su
 * nombre, no como una excepción genérica.
 *
 * No es un `PresupuestoAgotado`: cerrarla `budget_stopped` haría creer que el
 * tope cortó un recorrido sano.
 */
export class FalloOperativo extends Error {
  readonly motivo: string;
  readonly contexto: Readonly<Record<string, unknown>>;

  constructor(motivo: string, mensaje: string, contexto: Record<string, unknown> = {}) {
    super(`Fallo operativo (${motivo}): ${mensaje}`);
    this.name = "FalloOperativo";
    this.motivo = motivo;
    this.contexto = contexto;
  }
}

/** Una ventana de facturación, medio abierta: `[inicio, fin)`. */
export interface CicloDePresupuesto {
  readonly inicio: Date;
  readonly fin: Date;
  /** `YYYYMM` del **inicio** del ciclo. Es la clave del advisory lock. */
  readonly clave: number;
}

/** Los techos vigentes, ya validados. Nada aquí se recalcula después. */
export interface Presupuesto {
  /** `STREAMING_API_MONTHLY_BUDGET`. El bruto contractual. */
  readonly presupuestoMensual: number;
  /** `STREAMING_API_BUDGET_STOP_FRACTION`, en `(0, 1]`. */
  readonly fraccionDeCorte: number;
  /**
   * `floor(presupuestoMensual × fraccionDeCorte)`.
   *
   * **Este, y no `presupuestoMensual`, es el que se graba en `budget_limit`.**
   */
  readonly umbralGlobal: number;
  /** Día de inicio del ciclo, 1–28, en **UTC**: la zona en la que factura el proveedor. */
  readonly diaDeCiclo: number;
  /**
   * **Requests por CICLO MENSUAL.** 0 = no autorizado a consumir API.
   *
   * Solo cifras cuya unidad sea de verdad mensual. El coste medido de un
   * recorrido completo vive aparte, en `costes-medidos.ts`, y no autoriza nada.
   */
  readonly techoMensualPorPipeline: Readonly<Record<NombreDePipeline, number>>;
  /**
   * **Tope duro de subrequests de UNA ejecución** (Plan §8.5).
   *
   * ⚠️ Configuración independiente. **Nunca se deriva del techo mensual**: ese
   * fallback convirtió este cerrojo en un adorno, porque para un pipeline
   * diario pasaba a valer el agregado del mes entero.
   */
  readonly topePorEjecucion: Readonly<Record<NombreDePipeline, number>>;
}

/** Resultado de pedir cuota. `concedida: false` nunca llega a hacer la llamada. */
export type Reserva =
  | { readonly concedida: true; readonly consumidoTrasReservar: number }
  | {
      readonly concedida: false;
      readonly motivo: MotivoDeDenegacion;
      readonly consumido: number;
      readonly techo: number;
    };

/** Lo que una ejecución acumula y vuelca en su fila al cerrar. */
export interface MetricasDeEjecucion {
  readonly rowsAffected: FilasAfectadas | null;
  readonly multiLinkOffers: number;
  readonly farFutureExpiries: number;
  readonly errorCount: number;
  readonly errorSamples: readonly MuestraDeError[];
}
