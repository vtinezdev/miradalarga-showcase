/**
 * Qué dice un recorrido del horizonte **por lo que no lista**. Solo mide:
 * **no escribe nada**. `recorridoCompleto` lo comparten `expiring` y
 * `upcoming`; las ofertas conocidas y no nombradas son de `expiring`, porque
 * `upcoming` mide sobre su tabla de anuncios (ADR 0007).
 *
 * ⚖️ **Una ausencia no se interpreta salvo que el recorrido del horizonte haya
 * terminado** (decidido el 2026-09-24). Con el recorrido a medias no se
 * calcula nada: `null`, no cero. Cero sería afirmar que no desapareció nada.
 */
import type { EjecutorSql } from "../../ops/contratos.ts";
import { claveDeOferta } from "../seed/filas.ts";
import { PAIS, UMBRAL_DE_INACTIVIDAD } from "../deltas/contratos.ts";
import type { InformeDeDeltas } from "../deltas/contratos.ts";
import type { CheckpointDeCambios } from "../deltas/checkpoint.ts";

/** Cuántas claves se enseñan en el informe. El recuento es siempre completo. */
export const MUESTRA_DE_DESAPARECIDAS = 20;

export interface EntradaDeMedicion<C extends CheckpointDeCambios> {
  readonly checkpoint: C | null;
  readonly informe: InformeDeDeltas | null;
  /** El recorrido cerró `succeeded`. Un `budget_stopped` nunca es completo. */
  readonly terminado: boolean;
}

/** Un recorrido es completo si cerró bien, sin página pendiente y con informe. */
export function recorridoCompleto<C extends CheckpointDeCambios>(
  entrada: EntradaDeMedicion<C>,
): entrada is EntradaDeMedicion<C> & {
  readonly checkpoint: C;
  readonly informe: InformeDeDeltas;
} {
  return (
    entrada.terminado &&
    entrada.checkpoint !== null &&
    entrada.checkpoint.pendiente === null &&
    entrada.informe !== null
  );
}

interface FilaDelHorizonte {
  readonly imdb_id: string;
  readonly platform_id: string;
  readonly offer_type: string;
  readonly addon: string | null;
}

export interface OfertaConocida {
  /** `claveDeOferta`: `imdb|plataforma|país|tipo|addon`. */
  readonly clave: string;
  /** Nuestro `id` de plataforma (`max`, no `hbo`). */
  readonly plataforma: string;
}

/**
 * Las ofertas que la base ya conocía **dentro de la ventana** del recorrido,
 * según `sql`. La consulta recibe `$1` país, `$2` umbral de inactividad, `$3`
 * y `$4` los extremos de la ventana, y devuelve `imdb_id`, `platform_id`,
 * `offer_type` y `addon`. Deduplicadas y ordenadas por clave.
 */
export async function ofertasConocidasEnElHorizonte(
  ejecutor: EjecutorSql,
  sql: string,
  ventana: { readonly from: number; readonly to: number },
): Promise<readonly OfertaConocida[]> {
  const filas = await ejecutor.ejecutar<FilaDelHorizonte>(sql, [
    PAIS,
    UMBRAL_DE_INACTIVIDAD,
    new Date(ventana.from * 1000),
    new Date(ventana.to * 1000),
  ]);
  const porClave = new Map<string, OfertaConocida>();
  for (const f of filas) {
    const clave = claveDeOferta(f.imdb_id, f.platform_id, f.offer_type, f.addon);
    porClave.set(clave, { clave, plataforma: f.platform_id });
  }
  return [...porClave.values()].sort((a, b) =>
    a.clave < b.clave ? -1 : a.clave > b.clave ? 1 : 0,
  );
}

/** Las conocidas que el recorrido completo ya no nombra, ordenadas. */
export function noNombradas(
  conocidas: readonly OfertaConocida[],
  informe: InformeDeDeltas,
): readonly string[] {
  const nombradas = new Set(informe.ofertasNombradas);
  return conocidas.map((o) => o.clave).filter((clave) => !nombradas.has(clave));
}
