import type {
  IdPlataforma,
  Movimiento,
  Oferta,
  Plataforma,
  TipoDeOferta,
} from "./modelo.ts";

/**
 * Reglas de producto que no dependen del origen de los datos. Las usan el
 * adaptador (orden de rankings) y las consultas de aplicación (orden de la
 * portada), y se prueban sin pantalla.
 */

const COLADOR = new Intl.Collator("es-ES", { sensitivity: "base", numeric: true });

/**
 * Desempate determinista y neutral del Ranking A (docs/RANKINGS.md): título
 * alfabético en es-ES y, en último término, identidad. Sin él, el orden no es
 * reproducible.
 */
export function compararTitulos(
  a: { titulo: string; id: string },
  b: { titulo: string; id: string },
): number {
  return (
    COLADOR.compare(a.titulo, b.titulo) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Orden neutro de «dónde verla»: lo incluido antes que lo que se paga aparte. */
const PRIORIDAD_DE_OFERTA: Record<TipoDeOferta, number> = {
  subscription: 0,
  free: 1,
  addon: 2,
  rent: 3,
  buy: 4,
};

export function compararTiposDeOferta(a: TipoDeOferta, b: TipoDeOferta): number {
  return PRIORIDAD_DE_OFERTA[a] - PRIORIDAD_DE_OFERTA[b];
}

export interface GrupoDeOfertas {
  plataforma: Plataforma;
  ofertas: Oferta[];
}

/**
 * Agrupa las ofertas por plataforma en orden neutro: cada grupo ordenado por
 * tipo, y los grupos por su mejor tipo; a igualdad, el orden de entrada.
 */
export function agruparOfertas(ofertas: readonly Oferta[]): GrupoDeOfertas[] {
  const grupos = new Map<IdPlataforma, GrupoDeOfertas>();
  for (const oferta of ofertas) {
    const grupo = grupos.get(oferta.plataforma.id);
    if (grupo) grupo.ofertas.push(oferta);
    else
      grupos.set(oferta.plataforma.id, {
        plataforma: oferta.plataforma,
        ofertas: [oferta],
      });
  }
  return [...grupos.values()]
    .map((grupo) => ({
      plataforma: grupo.plataforma,
      ofertas: [...grupo.ofertas].sort((a, b) => compararTiposDeOferta(a.tipo, b.tipo)),
    }))
    .sort((a, b) => compararTiposDeOferta(a.ofertas[0]!.tipo, b.ofertas[0]!.tipo));
}

/**
 * Sube los grupos de «tus plataformas» sin alterar el orden relativo del resto
 * (INFORMATION-ARCHITECTURE.md §6). Orden estable: resaltar no baraja.
 */
export function priorizarMisPlataformas<T extends { plataforma: Plataforma }>(
  grupos: readonly T[],
  mias: ReadonlySet<IdPlataforma>,
): T[] {
  if (mias.size === 0) return [...grupos];
  const esMia = (g: T) => mias.has(g.plataforma.id);
  return [...grupos.filter(esMia), ...grupos.filter((g) => !esMia(g))];
}

/**
 * Radar de la portada (SCREENS.md §1): primero lo que aparece en nuestras
 * listas, después por fecha. El orden por fecha de entrada se conserva dentro
 * de cada bloque, porque el repositorio ya lo devuelve ordenado.
 */
export function priorizarLoEditorial(
  movimientos: readonly Movimiento[],
  enListas: ReadonlySet<string>,
  limite: number,
): Movimiento[] {
  return [
    ...movimientos.filter((m) => enListas.has(m.tituloId)),
    ...movimientos.filter((m) => !enListas.has(m.tituloId)),
  ].slice(0, limite);
}

/**
 * Mínimo de títulos para publicar un ranking automático (docs/RANKINGS.md,
 * «Reglas de publicación»: si no se alcanza, la lista no se publica). El número
 * definitivo se fija con el catálogo real; con el de desarrollo, 3.
 */
export const MINIMO_PARA_PUBLICAR_RANKING = 3;

/** Mínimos automatizables del checklist de landing (docs/SEO.md). */
export const CHECKLIST_DE_LANDING = { disponibles: 12, palabras: 120 } as const;

export function contarPalabras(texto: string | undefined): number {
  return texto ? texto.split(/\s+/).filter(Boolean).length : 0;
}

/**
 * La parte **automatizable** del checklist de landing de `docs/SEO.md`: ≥ 12
 * títulos disponibles hoy, introducción propia de ≥ 120 palabras, autor y fecha
 * de revisión. Si no la pasa, la lista se publica igual, pero `noindex` y fuera
 * del sitemap. La activación manual, cuando existan landings, es otra compuerta
 * que se suma a esta, no la sustituye.
 */
export function pasaChecklistDeLanding(lista: {
  introduccion?: string | undefined;
  autor?: { nombre: string } | undefined;
  revisada?: string | undefined;
  disponiblesHoy: number;
}): boolean {
  return (
    lista.disponiblesHoy >= CHECKLIST_DE_LANDING.disponibles &&
    contarPalabras(lista.introduccion) >= CHECKLIST_DE_LANDING.palabras &&
    Boolean(lista.autor?.nombre) &&
    Boolean(lista.revisada)
  );
}
