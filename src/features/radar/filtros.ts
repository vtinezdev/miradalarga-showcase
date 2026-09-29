import type {
  IdPlataforma,
  Plataforma,
  TipoDeMovimiento,
  TipoDeObra,
} from "@/features/catalogo/modelo.ts";
import {
  MIS_PLATAFORMAS,
  OBRAS,
  type Faceta,
  type Filtros,
} from "@/features/filtros/url.ts";

export { MIS_PLATAFORMAS, OBRAS };

/**
 * Filtros del radar (SCREENS.md §4): tipo de movimiento, plataforma (las seis y
 * «Mis plataformas» como atajo) y obra. Estado en la URL con los nombres de
 * `docs/SEO.md`: `?tipo=`, `?plataforma=` (el slug, nunca el id) y `?obra=`.
 * Toda combinación es `noindex` con canónica a `/radar`.
 */

export const TIPOS: readonly TipoDeMovimiento[] = [
  "llega",
  "se-va",
  "proximamente",
  "se-fue",
  "cambio",
];

/** Los que miran al pasado; los demás, al futuro. */
export const PASADOS: ReadonlySet<TipoDeMovimiento> = new Set([
  "llega",
  "se-fue",
  "cambio",
]);

export const ETIQUETA_DE_TIPO: Record<TipoDeMovimiento, string> = {
  llega: "Llega",
  "se-va": "Se va",
  proximamente: "Próximamente",
  "se-fue": "Se fue",
  cambio: "Cambios",
};

export function facetasDelRadar(plataformas: readonly Plataforma[]): Faceta[] {
  return [
    { clave: "tipo", valores: TIPOS },
    {
      clave: "plataforma",
      valores: [...plataformas.map((p) => p.slug), MIS_PLATAFORMAS],
    },
    { clave: "obra", valores: Object.keys(OBRAS) },
  ];
}

export interface Filtrable {
  tipo: TipoDeMovimiento;
  plataforma: IdPlataforma;
  obra: TipoDeObra;
}

export interface Contexto {
  /** slug → id. */
  idPorSlug: ReadonlyMap<string, IdPlataforma>;
  /** Tus plataformas (vacío en el servidor y sin selección). */
  mias: ReadonlySet<IdPlataforma>;
}

/** ¿Cumple todos los filtros, salvo el de `ignorar`? (para los recuentos). */
export function cumple(
  fila: Filtrable,
  filtros: Filtros,
  contexto: Contexto,
  ignorar?: string,
): boolean {
  const { tipo = "", plataforma = "", obra = "" } = filtros;
  if (ignorar !== "tipo" && tipo && fila.tipo !== tipo) return false;
  if (ignorar !== "obra" && obra && fila.obra !== OBRAS[obra]) return false;
  if (ignorar !== "plataforma" && plataforma) {
    if (plataforma === MIS_PLATAFORMAS) {
      if (!contexto.mias.has(fila.plataforma)) return false;
    } else if (contexto.idPorSlug.get(plataforma) !== fila.plataforma) return false;
  }
  return true;
}

/**
 * Cuántas filas quedarían con cada valor de una faceta, manteniendo los demás
 * filtros: el número que lleva cada chip. `""` es «todo».
 */
export function recuentos(
  filas: readonly Filtrable[],
  filtros: Filtros,
  contexto: Contexto,
  clave: string,
  valores: readonly string[],
): Record<string, number> {
  const base = filas.filter((f) => cumple(f, filtros, contexto, clave));
  const resultado: Record<string, number> = { "": base.length };
  for (const v of valores) {
    resultado[v] = base.filter((f) =>
      cumple(f, { ...filtros, [clave]: v }, contexto),
    ).length;
  }
  return resultado;
}

/** Agrupa por día (`2026-09-28`) en el orden pedido; dentro del día, el de entrada. */
export function porDia<T extends { dia: string }>(
  filas: readonly T[],
  orden: "asc" | "desc",
): { dia: string; filas: T[] }[] {
  const grupos = new Map<string, T[]>();
  for (const f of filas) grupos.set(f.dia, [...(grupos.get(f.dia) ?? []), f]);
  return [...grupos.entries()]
    .sort(([a], [b]) => (orden === "asc" ? a.localeCompare(b) : b.localeCompare(a)))
    .map(([dia, delDia]) => ({ dia, filas: delDia }));
}

/** «filtrados por Se va, Netflix y Series», o `""` sin filtros. */
export function describirFiltros(
  filtros: Filtros,
  plataformas: readonly Plataforma[],
): string {
  const partes: string[] = [];
  if (filtros.tipo) partes.push(ETIQUETA_DE_TIPO[filtros.tipo as TipoDeMovimiento]);
  if (filtros.plataforma === MIS_PLATAFORMAS) partes.push("tus plataformas");
  else if (filtros.plataforma)
    partes.push(plataformas.find((p) => p.slug === filtros.plataforma)?.nombre ?? "");
  if (filtros.obra) partes.push(filtros.obra === "peliculas" ? "películas" : "series");
  if (partes.length === 0) return "";
  const lista =
    partes.length > 1
      ? `${partes.slice(0, -1).join(", ")} y ${partes.at(-1)}`
      : partes[0];
  return `filtrados por ${lista}`;
}
