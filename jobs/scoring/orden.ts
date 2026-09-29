/**
 * Ordenación del **Ranking A — Mejor valoradas**.
 *
 * Reglas validadas en el Spike 3 y recogidas en `docs/RANKINGS.md`:
 *
 *   · solo títulos **con** valoración — `null` queda excluido, no ordenado;
 *   · orden por valoración descendente;
 *   · **desempate determinista y neutral**: título alfabético (es-ES) y, en
 *     último término, `imdbId`.
 *
 * Por qué el desempate importa: sin él, el orden depende del orden de lectura
 * de los ficheros de ingesta, y el ranking **deja de ser reproducible**. Está
 * medido en el Spike 3, no supuesto.
 *
 * Por qué el desempate es *neutral*: usar año o popularidad metería una segunda
 * señal dentro de una lista que se anuncia como «mejor valoradas». Una posición
 * es un **ordinal**, nunca una puntuación.
 */

/** Lo mínimo que el comparador necesita saber de un título. */
export interface TituloOrdenable {
  readonly titulo: string;
  readonly ids: { readonly imdbId: string };
  /** `null` = sin valoración. Ver `Valoracion` en `jobs/adapters/contracts.ts`. */
  readonly valoracion: number | null;
}

/**
 * Colador de es-ES **sin opciones**, exactamente el del Spike 3.
 *
 * No se le añade `sensitivity` ni `numeric`: cambiarlos cambia el desempate y
 * el resultado dejaría de ser el que se midió y se validó. Si algún día se
 * tocan, hay que volver a medir la estabilidad del Top 20 y actualizar
 * `docs/RANKINGS.md`.
 *
 * Se construye una sola vez: instanciarlo dentro del comparador es el error de
 * rendimiento clásico al ordenar catálogos grandes.
 */
const coladorEs = new Intl.Collator("es-ES");

/**
 * Desempate neutral y determinista.
 * Exportado aparte porque los tests comprueban justo esto.
 */
export function desempateNeutral(a: TituloOrdenable, b: TituloOrdenable): number {
  return (
    coladorEs.compare(a.titulo, b.titulo) || a.ids.imdbId.localeCompare(b.ids.imdbId)
  );
}

/**
 * Solo entran los títulos **con** valoración.
 *
 * `null` significa «sin valoración todavía» —el `0` del proveedor, ya
 * normalizado— y se concentra en los estrenos. Ordenarlo en lugar de excluirlo
 * hundiría los estrenos al fondo de la lista, que es exactamente la trampa que
 * detectó el Spike 1.
 */
export function tieneValoracion<T extends TituloOrdenable>(
  titulo: T,
): titulo is T & { valoracion: number } {
  return titulo.valoracion !== null;
}

/**
 * Devuelve una lista **nueva** ordenada según el Ranking A.
 *
 * No muta la entrada: un pipeline que reordena su propio array de trabajo es
 * una fuente de fallos difíciles de ver.
 */
export function ordenarMejorValoradas<T extends TituloOrdenable>(
  titulos: readonly T[],
): T[] {
  return titulos
    .filter(tieneValoracion)
    .sort((a, b) => b.valoracion - a.valoracion || desempateNeutral(a, b));
}
