/**
 * Navegación primaria (INFORMATION-ARCHITECTURE.md §3): cinco destinos, en este
 * orden. Buscar y Mis plataformas son acciones, no destinos.
 */
export const DESTINOS = [
  { href: "/listas", etiqueta: "Listas" },
  { href: "/peliculas", etiqueta: "Películas" },
  { href: "/series", etiqueta: "Series" },
  { href: "/radar", etiqueta: "Radar" },
  { href: "/plataformas", etiqueta: "Plataformas" },
] as const;

/** Enlaces de confianza del pie y del menú móvil. */
export const CONFIANZA = [
  { href: "/metodologia", etiqueta: "Metodología" },
  { href: "/sobre-nosotros", etiqueta: "Sobre nosotros" },
  { href: "/legal/aviso-legal", etiqueta: "Aviso legal" },
  { href: "/legal/privacidad", etiqueta: "Privacidad" },
] as const;

/** ¿La ruta actual pertenece a este destino? `/peliculas/x` activa «Películas». */
export function esDestinoActual(ruta: string, href: string): boolean {
  return ruta === href || ruta.startsWith(`${href}/`);
}
