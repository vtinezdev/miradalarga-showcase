/**
 * **Reproducir una ejecución de `updated`**: qué más tiene que coincidir,
 * aparte de lo común (`horizonte/reproduccion.ts`, `compararConOriginal`).
 *
 *   · Lo que sale **del crudo** —cuántos avisos, de qué plataforma y de qué
 *     tipo de oferta— se exige siempre.
 *   · La clasificación completa depende del estado del que partió: se exige
 *     solo en una reproducción **exacta** (un ensayo sobre el corpus).
 */
import type { CampoComparable } from "../horizonte/reproduccion.ts";
import { clasificacionDelCrudo } from "./clasificacion.ts";

export const CAMPOS_PROPIOS_DE_UPDATED: readonly CampoComparable[] = [
  {
    campo: "clasificación de updated (del crudo: avisos por plataforma y tipo)",
    delCrudo: true,
    leer: (m) => (m.updated === undefined ? null : clasificacionDelCrudo(m.updated)),
  },
  {
    campo: "clasificación de updated (completa)",
    delCrudo: false,
    leer: (m) => m.updated ?? null,
  },
];
