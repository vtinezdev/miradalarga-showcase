import { URL_BASE } from "./sitio.ts";

/**
 * `BreadcrumbList` (docs/SEO.md) a partir de las mismas migas que se pintan con
 * `Breadcrumbs`: una sola fuente para lo visible y lo marcado.
 */
export function migasDePan(elementos: readonly { nombre: string; ruta: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: elementos.map((e, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: e.nombre,
      item: `${URL_BASE}${e.ruta}`,
    })),
  };
}

/** JSON seguro dentro de `<script>`: sin `</script>` posible. */
export function jsonEnScript(datos: unknown): string {
  return JSON.stringify(datos).replace(/</g, "\\u003c");
}
