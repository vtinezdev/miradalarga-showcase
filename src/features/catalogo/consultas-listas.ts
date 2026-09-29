import { cache } from "react";
import { tarjetaDeLista, type TarjetaDeLista } from "./consultas.ts";
import type {
  EntradaEditorial,
  Instante,
  ListaEditorial,
  TituloResumen,
} from "./modelo.ts";
import { repositorio } from "./proveedor.ts";
import { pasaChecklistDeLanding } from "./reglas.ts";
import type { RepositorioDeCatalogo } from "./repositorio.ts";

/**
 * Listas editoriales firmadas (C): el índice `/listas` y cada `/listas/{slug}`
 * (SCREENS.md §5). Una lista es contenido editorial, no un filtro de la base:
 * su orden es el del autor y un título que se fue **se queda en su sitio**.
 */

export interface IndiceDeListas {
  comprobadoEn: Instante;
  /** De la revisada más recientemente a la más antigua. */
  listas: TarjetaDeLista[];
  destacadaId: string | null;
  autores: number;
}

export async function construirIndiceDeListas(
  repo: RepositorioDeCatalogo,
): Promise<IndiceDeListas> {
  const [comprobadoEn, listas, destacada] = await Promise.all([
    repo.ultimaComprobacion(),
    repo.listas(),
    repo.listaDestacada(),
  ]);
  const titulos = await mapaDeTitulos(repo, listas);
  return {
    comprobadoEn,
    listas: listas.map((l) => tarjetaDeLista(l, titulos)),
    destacadaId: destacada?.id ?? null,
    autores: new Set(listas.map((l) => l.autor.slug)).size,
  };
}

export const obtenerIndiceDeListas = cache(() =>
  construirIndiceDeListas(repositorio()),
);

export interface EntradaDeLista {
  entrada: EntradaEditorial;
  titulo: TituloResumen;
}

export interface VistaDeLista {
  lista: ListaEditorial;
  tarjeta: TarjetaDeLista;
  /** En el orden del autor. */
  entradas: EntradaDeLista[];
  otras: TarjetaDeLista[];
  comprobadoEn: Instante;
  /** Pasa la parte automatizable del checklist de landing (docs/SEO.md). */
  indexable: boolean;
}

export async function construirLista(
  repo: RepositorioDeCatalogo,
  slug: string,
): Promise<VistaDeLista | null> {
  const [lista, listas, comprobadoEn] = await Promise.all([
    repo.lista(slug),
    repo.listas(),
    repo.ultimaComprobacion(),
  ]);
  if (!lista) return null;
  const otras = listas.filter((l) => l.id !== lista.id);
  const titulos = await mapaDeTitulos(repo, [lista, ...otras]);
  const tarjeta = tarjetaDeLista(lista, titulos);
  return {
    lista,
    tarjeta,
    entradas: [...lista.entradas]
      .sort((a, b) => a.orden - b.orden)
      .flatMap((entrada) => {
        const titulo = titulos.get(entrada.tituloId);
        return titulo ? [{ entrada, titulo }] : [];
      }),
    otras: otras.map((l) => tarjetaDeLista(l, titulos)),
    comprobadoEn,
    indexable: pasaChecklistDeLanding({
      ...lista,
      disponiblesHoy: tarjeta.disponiblesHoy,
    }),
  };
}

export const obtenerLista = cache((slug: string) =>
  construirLista(repositorio(), slug),
);

export const obtenerSlugsDeListas = cache(async () =>
  (await repositorio().listas()).map((l) => l.slug),
);

async function mapaDeTitulos(repo: RepositorioDeCatalogo, listas: ListaEditorial[]) {
  const ids = [...new Set(listas.flatMap((l) => l.entradas.map((e) => e.tituloId)))];
  return new Map((await repo.titulos(ids)).map((t) => [t.id, t]));
}
