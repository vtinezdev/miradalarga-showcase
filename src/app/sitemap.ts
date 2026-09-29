import type { MetadataRoute } from "next";
import { obtenerMarco, obtenerSlugs } from "@/features/catalogo/consultas.ts";
import {
  obtenerLista,
  obtenerSlugsDeListas,
} from "@/features/catalogo/consultas-listas.ts";
import { rutasDelSitemap } from "@/lib/sitemap.ts";
import { INDEXABLE, URL_BASE } from "@/lib/sitio.ts";

export const dynamic = "force-static";

/**
 * Sitemap con `lastmod` real —la última comprobación del catálogo—, nunca la
 * fecha del despliegue (docs/SEO.md). Vacío mientras el sitio no sea indexable.
 * Cuando el catálogo crezca se particiona (`generateSitemaps`).
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if (!INDEXABLE) return [];
  const [{ comprobadoEn, plataformas }, peliculas, series, slugsDeListas] =
    await Promise.all([
      obtenerMarco(),
      obtenerSlugs("pelicula"),
      obtenerSlugs("serie"),
      obtenerSlugsDeListas(),
    ]);
  const listas = (await Promise.all(slugsDeListas.map((slug) => obtenerLista(slug))))
    .filter((v) => v?.indexable)
    .flatMap((v) => (v ? [v.lista.slug] : []));
  const lastModified = new Date(comprobadoEn);
  return rutasDelSitemap({
    peliculas,
    series,
    plataformas: plataformas.map((p) => p.slug),
    listas,
  }).map((ruta) => ({ url: `${URL_BASE}${ruta}`, lastModified }));
}
