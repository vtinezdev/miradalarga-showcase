/**
 * Los tres advisory locks. Nada más vive aquí.
 *
 * Tres problemas distintos de concurrencia, tres locks distintos:
 *
 *   A · Dos ejecuciones del MISMO pipeline a la vez
 *       → `pg_try_advisory_lock(NS_PIPELINE, pipelineId)`, de **sesión**.
 *         Se sostiene toda la ejecución. La segunda no lo obtiene y se va.
 *
 *   C · Dos pipelines DISTINTOS escribiendo el MISMO catálogo a la vez
 *       → `pg_try_advisory_lock(NS_CATALOGO, CLAVE_CATALOGO)`, de **sesión**.
 *         Solo lo toman los pipelines con `ESCRIBE_CATALOGO` a `true`
 *         (`contratos.ts`): `deltas` y `expiring` no se solapan, y
 *         `popularity` o `scoring` no esperan a nadie. Se sostiene toda la
 *         ejecución. El segundo escritor no lo obtiene y se va.
 *
 *   B · Dos pipelines DISTINTOS compitiendo por la misma cuota
 *       → `pg_advisory_xact_lock(NS_CICLO, claveDeCiclo)`, de **transacción**.
 *         Serializa leer-decidir-escribir. Sin él, dos jobs leen 850, los dos
 *         creen que caben 60, y entre ambos se pasan del techo.
 *
 * **La clave del lock B es el ciclo, no el pipeline**: el techo global es
 * compartido, así que el punto de serialización tiene que serlo también. Por
 * la misma razón, **la del lock C es el catálogo**: hay uno solo.
 *
 * ── Orden de adquisición, fijo ──────────────────────────────────────────────
 *
 *   1. A (try) → 2. C (try, solo escritores) → 3. B (espera), en cada reserva.
 *
 * Se sueltan al revés: C y después A, en el `finally` de `ejecutarJob`. B se
 * suelta solo, en el `COMMIT` o `ROLLBACK` de la reserva.
 *
 * A va antes que C porque da el diagnóstico más preciso: si la que ocupa el
 * catálogo es otra ejecución del mismo pipeline, se informa `ya_hay_una_viva`.
 *
 * ⚠️ **Sin riesgo de interbloqueo.** A y C son `try`: **nadie espera jamás por
 * ellos**. El único lock con espera es B, y quien lo sostiene no pide ningún
 * otro antes de soltarlo. El grafo de espera no tiene ciclos.
 *
 * ⚠️ **La conexión que sostiene A y C tiene que ser DIRECTA, sin
 * `-pooler`.** Un pooler en modo transacción no garantiza que la sesión que
 * tomó el lock sea la misma que sigue viva después. Es la misma marca que
 * rechaza `drizzle.migrate.config.ts`.
 *
 * ⚠️ **C vive en la sesión `ops`, no en la de datos**, y basta: todo escritor
 * lo toma en su sesión `ops` **antes** de su primera escritura y lo sostiene
 * hasta después de la última.
 */
import type { EjecutorSql, NombreDePipeline } from "./contratos.ts";
import { PIPELINE_ID } from "./contratos.ts";

/**
 * Espacios de nombres de los advisory locks. `0x4D4C` es «ML».
 *
 * Espacios distintos para que un `pipelineId` nunca pueda colisionar con una
 * clave de ciclo ni con la del catálogo: son independientes por construcción.
 * **Los números son identidad**: no se reordenan ni se reutilizan.
 */
export const NS_PIPELINE = 19788;
export const NS_CICLO = 19789;
export const NS_CATALOGO = 19790;

/** El catálogo es uno: España, `external_*`. Una sola clave. */
export const CLAVE_CATALOGO = 1;

/**
 * Toma el lock de exclusión mutua del pipeline. **No espera**: o está libre o
 * ya hay otra ejecución viva.
 *
 * Devuelve `false` en vez de lanzar: que otra ejecución esté corriendo no es un
 * fallo, es el comportamiento correcto del sistema.
 */
export async function tomarLockDePipeline(
  ejecutor: EjecutorSql,
  pipeline: NombreDePipeline,
): Promise<boolean> {
  const filas = await ejecutor.ejecutar<{ tomado: boolean }>(
    "SELECT pg_try_advisory_lock($1, $2) AS tomado",
    [NS_PIPELINE, PIPELINE_ID[pipeline]],
  );
  return filas[0]?.tomado === true;
}

/**
 * Suelta el lock del pipeline.
 *
 * Cerrar la conexión también lo suelta —los locks de sesión mueren con ella—,
 * pero soltarlo explícitamente hace que una ejecución que reutilice la sesión
 * no arrastre el lock sin saberlo.
 */
export async function soltarLockDePipeline(
  ejecutor: EjecutorSql,
  pipeline: NombreDePipeline,
): Promise<void> {
  await ejecutor.ejecutar("SELECT pg_advisory_unlock($1, $2)", [
    NS_PIPELINE,
    PIPELINE_ID[pipeline],
  ]);
}

/**
 * Toma el lock de escritor de catálogo. **No espera**, como el del pipeline:
 * que otro escritor esté trabajando no es un fallo.
 *
 * Se llama **con el lock del pipeline ya tomado** y solo desde `ejecutarJob`,
 * para los pipelines con `ESCRIBE_CATALOGO` a `true`.
 */
export async function tomarLockDeCatalogo(ejecutor: EjecutorSql): Promise<boolean> {
  const filas = await ejecutor.ejecutar<{ tomado: boolean }>(
    "SELECT pg_try_advisory_lock($1, $2) AS tomado",
    [NS_CATALOGO, CLAVE_CATALOGO],
  );
  return filas[0]?.tomado === true;
}

/** Suelta el lock de escritor de catálogo. **Antes** que el del pipeline. */
export async function soltarLockDeCatalogo(ejecutor: EjecutorSql): Promise<void> {
  await ejecutor.ejecutar("SELECT pg_advisory_unlock($1, $2)", [
    NS_CATALOGO,
    CLAVE_CATALOGO,
  ]);
}

/**
 * Toma el lock del ciclo **dentro de la transacción en curso**.
 *
 * Variante `_xact_` y no la de sesión: se libera sola en el `COMMIT`, así que
 * un fallo entre la decisión y la escritura no deja la contabilidad bloqueada
 * para todos los demás pipelines.
 */
export async function bloquearCiclo(
  ejecutor: EjecutorSql,
  claveDeCiclo: number,
): Promise<void> {
  await ejecutor.ejecutar("SELECT pg_advisory_xact_lock($1, $2)", [
    NS_CICLO,
    claveDeCiclo,
  ]);
}
