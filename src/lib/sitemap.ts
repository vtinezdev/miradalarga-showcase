/**
 * Qué rutas entran en el sitemap (docs/SEO.md): las canónicas indexables y
 * nada más. Fuera: `/buscar`, cualquier combinación de filtros y las listas que
 * no pasan el checklist de landing. Función pura, para probarla sin rutas.
 */
export function rutasDelSitemap(datos: {
  peliculas: readonly string[];
  series: readonly string[];
  plataformas: readonly string[];
  /** Solo las que pasan el checklist de landing. */
  listas: readonly string[];
}): string[] {
  return [
    "/",
    "/peliculas",
    "/series",
    "/listas",
    "/radar",
    "/plataformas",
    ...datos.plataformas.map((slug) => `/plataformas/${slug}`),
    ...datos.listas.map((slug) => `/listas/${slug}`),
    ...datos.peliculas.map((slug) => `/peliculas/${slug}`),
    ...datos.series.map((slug) => `/series/${slug}`),
  ];
}
