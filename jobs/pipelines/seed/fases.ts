/**
 * **Las tres fases del seed en `ops_sync_runs`** (ADR 0009 §5): todas con
 * `pipeline = 'seed'`, distinguidas por el checkpoint v1 de cada una, y todas
 * por `ejecutarJob` —mismo ciclo de vida, huérfanas, `budget_limit = 900` y
 * muestras de error que el resto de jobs—.
 *
 * | | Sonda (M1) | Captura | Carga |
 * |---|---|---|---|
 * | `requests_made` | las reservadas | las reservadas | **0, estructural** |
 * | Estados | succeeded · budget_stopped · failed | ídem | succeeded · failed |
 * | `rows_affected` | `null` | `null` | por tabla |
 * | Lock de catálogo | ❌ | ❌ | ✅ |
 *
 * Aquí viven las formas y la política declarada; la ejecución está en
 * `captura.ts` y `carga.ts`. Nada de este fichero llama a nadie.
 */
import { z } from "zod";

import type { EstadoFinal, FaseDelSeed } from "../../ops/contratos.ts";
import {
  ArranqueDenegado,
  ESCRIBE_CATALOGO_POR_FASE_DEL_SEED,
} from "../../ops/contratos.ts";
import { claveDeCiclo, idDeOps } from "./crudo/formato.ts";

export const VERSION_DEL_CHECKPOINT_DEL_SEED = 1;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const instante = z.iso.datetime({ offset: false });

/** Checkpoint v1 de la **sonda** (M1): qué estratos se midieron, en qué ciclo. */
export const checkpointDeSondaV1 = z.strictObject({
  v: z.literal(VERSION_DEL_CHECKPOINT_DEL_SEED),
  fase: z.literal("sonda"),
  sondaId: z.string().min(1),
  cicloClave: claveDeCiclo,
  estratosMedidos: z.array(z.string().min(1)),
  paginasConfirmadas: z.number().int().nonnegative(),
});

/**
 * Checkpoint v1 de la **captura**. Nace en el `INSERT` con `T0` y el ancla ya
 * fijados; avanza **después** de que la página esté escrita en disco, en una
 * transacción propia sobre su propia fila. Una reanudación hereda `ancla`:
 * `S` no se mueve.
 */
export const checkpointDeCapturaV1 = z.strictObject({
  v: z.literal(VERSION_DEL_CHECKPOINT_DEL_SEED),
  fase: z.literal("captura"),
  capturaId: z.string().min(1),
  huellaDelPlan: sha256Hex,
  T0: instante,
  ancla: instante,
  ronda: z.number().int().positive(),
  estratos: z.array(
    z.strictObject({
      estrato: z.string().min(1),
      cursorDeEntrada: z.string().min(1).nullable(),
      agotado: z.boolean(),
      paginas: z.number().int().nonnegative(),
    }),
  ),
  paginasConfirmadas: z.number().int().nonnegative(),
  unicos: z.number().int().nonnegative(),
  reanudaDe: z.number().int().positive().nullable(),
});

/**
 * Checkpoint v1 de la **carga**, una por destino. Pasa a `cargada` como
 * **última sentencia de la transacción de datos**: el ancla existe si y solo
 * si el catálogo existe. Una fila huérfana o `failed` con `cargada` sigue
 * siendo un ancla válida: el `COMMIT` ocurrió.
 */
export const checkpointDeCargaV1 = z.strictObject({
  v: z.literal(VERSION_DEL_CHECKPOINT_DEL_SEED),
  fase: z.literal("carga"),
  estado: z.enum(["pendiente", "cargada"]),
  /** La huella del crudo: su identidad. */
  huella: sha256Hex,
  /** La huella canónica del catálogo que esta carga tiene que dejar. */
  huellaCanonica: sha256Hex,
  capturaId: z.string().min(1),
  /**
   * Las filas de la captura, **en otra base**: referencia sin FK. Texto
   * decimal, nunca `number`: son `bigint` y no pueden redondearse.
   */
  capturaRunIds: z.array(idDeOps),
  destinoDeLaCaptura: z.string().min(1),
  /** **`S`**: desde aquí arranca la primera ventana de `deltas`. */
  ancla: instante,
  /** De `T0` a `T1`: cuándo se observó lo que se carga. */
  observacion: z.strictObject({ desde: instante, hasta: instante }),
  recuentos: z.record(z.string(), z.number().int().nonnegative()),
});

export type CheckpointDeSonda = z.infer<typeof checkpointDeSondaV1>;
export type CheckpointDeCaptura = z.infer<typeof checkpointDeCapturaV1>;
export type CheckpointDeCarga = z.infer<typeof checkpointDeCargaV1>;
export type CheckpointDelSeed =
  CheckpointDeSonda | CheckpointDeCaptura | CheckpointDeCarga;

const ESQUEMAS = {
  sonda: checkpointDeSondaV1,
  captura: checkpointDeCapturaV1,
  carga: checkpointDeCargaV1,
} as const;

/**
 * Valida un checkpoint del seed leído de la base. **Nunca repara nada**: la
 * versión se mira antes que la forma, y la fase antes que el resto.
 */
export function leerCheckpointDelSeed(
  valor: unknown,
  runId: number,
): CheckpointDelSeed {
  const objeto =
    typeof valor === "object" && valor !== null
      ? (valor as Record<string, unknown>)
      : {};
  if (objeto.v !== VERSION_DEL_CHECKPOINT_DEL_SEED) {
    throw new ArranqueDenegado(
      "checkpoint_version_desconocida",
      `el checkpoint del seed de la ejecución ${String(runId)} no es ` +
        `v${String(VERSION_DEL_CHECKPOINT_DEL_SEED)}.`,
      { checkpoint_run_id: runId, version_leida: objeto.v ?? null },
    );
  }
  const fase = objeto.fase;
  if (fase !== "sonda" && fase !== "captura" && fase !== "carga") {
    throw new ArranqueDenegado(
      "checkpoint_invalido",
      `el checkpoint del seed de la ejecución ${String(runId)} no declara una fase conocida.`,
      { checkpoint_run_id: runId, fase_leida: fase ?? null },
    );
  }
  const r = ESQUEMAS[fase].safeParse(valor);
  if (!r.success) {
    throw new ArranqueDenegado(
      "checkpoint_invalido",
      `el checkpoint de ${fase} de la ejecución ${String(runId)} no cumple el formato v1.`,
      {
        checkpoint_run_id: runId,
        problemas: r.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`),
      },
    );
  }
  return r.data;
}

/**
 * **Lo que cada fase declara en `ops_sync_runs`**, antes de correr. Lo leen
 * `captura.ts` y `carga.ts` y lo fijan los tests.
 */
export interface PoliticaDeFase {
  /** Toma el lock de escritor de catálogo (C). */
  readonly escribeCatalogo: boolean;
  /** Reserva cuota antes de cada request (lock B en la reserva). */
  readonly reservaCuota: boolean;
  /** Los estados con que puede cerrar. */
  readonly estados: readonly EstadoFinal[];
  /** `rows_affected`: `null` o por tabla. */
  readonly filasAfectadas: "null" | "por_tabla";
}

export const POLITICA_DE_FASES: Readonly<Record<FaseDelSeed, PoliticaDeFase>> = {
  sonda: {
    escribeCatalogo: ESCRIBE_CATALOGO_POR_FASE_DEL_SEED.sonda,
    reservaCuota: true,
    estados: ["succeeded", "budget_stopped", "failed"],
    filasAfectadas: "null",
  },
  captura: {
    escribeCatalogo: ESCRIBE_CATALOGO_POR_FASE_DEL_SEED.captura,
    reservaCuota: true,
    estados: ["succeeded", "budget_stopped", "failed"],
    filasAfectadas: "null",
  },
  carga: {
    escribeCatalogo: ESCRIBE_CATALOGO_POR_FASE_DEL_SEED.carga,
    // Estructural: la carga no importa `transporte.ts` (test).
    reservaCuota: false,
    // Nunca `budget_stopped`: no hay cuota que se agote.
    estados: ["succeeded", "failed"],
    filasAfectadas: "por_tabla",
  },
};
