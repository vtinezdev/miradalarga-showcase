import { useCallback, useMemo, useState, useSyncExternalStore } from "react";

/**
 * Filtros en la URL (DS §8.6, `FilterChips`): `?tipo=se-va&plataforma=netflix`,
 * para enlazarlos, recargarlos y volver atrás a ellos.
 *
 * Las páginas que filtran son **estáticas** (el radar) o ya traen todos sus
 * resultados (la búsqueda): filtrar lo hace el navegador sobre el HTML servido,
 * sin pedir nada al Worker. Por eso la URL se reescribe con
 * `history.replaceState` —conservando el estado del enrutador— y no con una
 * navegación.
 *
 * El servidor ve los filtros que le pasa la página (`inicial`): vacío en una
 * página estática, los de `searchParams` en una dinámica. Así el HTML servido y
 * la primera pintada del cliente coinciden.
 */

/** Valores de `?obra=` (en plural, como las rutas) → tipo de obra. */
export const OBRAS: Record<string, "pelicula" | "serie"> = {
  peliculas: "pelicula",
  series: "serie",
};

/** `?plataforma=mias`: atajo a Mis plataformas, que solo resuelve el navegador. */
export const MIS_PLATAFORMAS = "mias";

export interface Faceta {
  clave: string;
  valores: readonly string[];
}

export type Filtros = Record<string, string>;

const EVENTO = "ml:filtros";

/** Lee de una query los valores válidos de cada faceta; lo demás es «todo» (""). */
export function leerFiltros(query: string, facetas: readonly Faceta[]): Filtros {
  const params = new URLSearchParams(query);
  const filtros: Filtros = {};
  for (const f of facetas) {
    const valor = params.get(f.clave) ?? "";
    filtros[f.clave] = f.valores.includes(valor) ? valor : "";
  }
  return filtros;
}

/** La query con una faceta cambiada; las demás claves (p. ej. `q`) se conservan. */
export function conFiltro(query: string, clave: string, valor: string): string {
  const params = new URLSearchParams(query);
  if (valor) params.set(clave, valor);
  else params.delete(clave);
  const texto = params.toString();
  return texto ? `?${texto}` : "";
}

/** La query sin ninguna de las facetas. */
export function sinFiltros(query: string, facetas: readonly Faceta[]): string {
  let resultado = query;
  for (const f of facetas) resultado = conFiltro(resultado, f.clave, "");
  return resultado;
}

function escribir(query: string): void {
  const { pathname, hash } = window.location;
  // Conserva `history.state`: es del enrutador, y sin él «atrás» se pierde.
  window.history.replaceState(window.history.state, "", `${pathname}${query}${hash}`);
  window.dispatchEvent(new Event(EVENTO));
}

function suscribir(avisar: () => void): () => void {
  window.addEventListener(EVENTO, avisar);
  window.addEventListener("popstate", avisar);
  // En una navegación en cliente el enrutador puede escribir la URL nueva
  // después de pintar la página (y `pushState` no avisa): se relee una vez.
  const relectura = window.setTimeout(avisar, 0);
  return () => {
    window.clearTimeout(relectura);
    window.removeEventListener(EVENTO, avisar);
    window.removeEventListener("popstate", avisar);
  };
}

export function useFiltrosEnUrl(facetas: readonly Faceta[], inicial = "") {
  const query = useSyncExternalStore(
    suscribir,
    () => window.location.search,
    () => inicial,
  );
  const filtros = useMemo(() => leerFiltros(query, facetas), [query, facetas]);
  // Solo lo que el lector cambia se anuncia; la lectura inicial, no.
  const [tocado, setTocado] = useState(false);

  const cambiar = useCallback((clave: string, valor: string) => {
    setTocado(true);
    escribir(conFiltro(window.location.search, clave, valor));
  }, []);

  const limpiar = useCallback(() => {
    setTocado(true);
    escribir(sinFiltros(window.location.search, facetas));
  }, [facetas]);

  const activos = facetas.filter((f) => filtros[f.clave]).length;
  return { filtros, cambiar, limpiar, activos, tocado };
}
