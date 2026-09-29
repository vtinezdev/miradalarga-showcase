/**
 * **Reproducir una ejecución de `expiring`**: la reproducción común de los
 * recorridos del horizonte (`horizonte/reproduccion.ts`), atada a
 * `expiring`. Ahí está el porqué de las dos clases —exacta y de
 * idempotencia— y de comparar por valor.
 */
import type {
  LectorDeManifiestos,
  PlanDeReconstruccion,
  ResolverRuta,
} from "../horizonte/reproduccion.ts";
import { planDeReconstruccion as planComun } from "../horizonte/reproduccion.ts";
import { PIPELINE_EXPIRING } from "./checkpoint.ts";

export type {
  Diferencia,
  LectorDeManifiestos,
  PlanDeReconstruccion,
  ResolverRuta,
} from "../horizonte/reproduccion.ts";
export { cambiosEnLaRama, compararConOriginal } from "../horizonte/reproduccion.ts";

/** Desde qué estado se reproduce un manifiesto de `expiring`. */
export function planDeReconstruccion(
  directorio: string,
  leer: LectorDeManifiestos,
  resolver: ResolverRuta,
): PlanDeReconstruccion {
  return planComun(PIPELINE_EXPIRING, directorio, leer, resolver);
}
