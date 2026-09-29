/**
 * **Reproducir una ejecución de `upcoming`**: la reproducción común de los
 * recorridos del horizonte (`horizonte/reproduccion.ts`), atada a `upcoming`
 * y con lo que solo `upcoming` guarda: el resumen de anuncios y lo que esos
 * anuncios hicieron con la base.
 *
 * ⚖️ El resumen de anuncios **sale del crudo**, no de la base
 * (`anuncios.ts`): se exige idéntico en **cualquier** reproducción, exacta o
 * de idempotencia. Lo que hicieron con `external_availability_announcements`
 * depende del estado de partida: solo se exige en una exacta. En una de
 * idempotencia cada anuncio es la misma observación, y eso lo comprueba el
 * script (`horizonte-manual.ts`), no esta comparación.
 */
import type { Manifiesto } from "../deltas/manifiesto.ts";
import type {
  CampoComparable,
  Diferencia,
  LectorDeManifiestos,
  PlanDeReconstruccion,
  ResolverRuta,
} from "../horizonte/reproduccion.ts";
import {
  compararConOriginal as compararComun,
  planDeReconstruccion as planComun,
} from "../horizonte/reproduccion.ts";
import { PIPELINE_UPCOMING } from "./checkpoint.ts";

export type {
  Diferencia,
  LectorDeManifiestos,
  PlanDeReconstruccion,
  ResolverRuta,
} from "../horizonte/reproduccion.ts";
export { cambiosEnLaRama } from "../horizonte/reproduccion.ts";

/** Lo propio de `upcoming` que también tiene que coincidir. */
export const CAMPOS_DE_UPCOMING: readonly CampoComparable[] = [
  {
    campo: "anuncios (crudo: plataformas, sin enlace, fuera del horizonte)",
    delCrudo: true,
    leer: (m) => m.anuncios,
  },
  {
    campo: "anuncios guardados (nuevos, actualizados, ciclos, conflictos)",
    delCrudo: false,
    leer: (m) => m.anunciosGuardados,
  },
];

/** Desde qué estado se reproduce un manifiesto de `upcoming`. */
export function planDeReconstruccion(
  directorio: string,
  leer: LectorDeManifiestos,
  resolver: ResolverRuta,
): PlanDeReconstruccion {
  return planComun(PIPELINE_UPCOMING, directorio, leer, resolver);
}

/** Como la común, más el resumen de anuncios, exigible siempre. */
export function compararConOriginal(
  original: Manifiesto,
  reproducido: Manifiesto,
  exacta: boolean,
): readonly Diferencia[] {
  return compararComun(original, reproducido, exacta, CAMPOS_DE_UPCOMING);
}
