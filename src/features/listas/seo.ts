import type { Metadata } from "next";
import type { VistaDeLista } from "@/features/catalogo/consultas-listas.ts";
import { rutaDeFicha, rutaDeLista } from "@/features/catalogo/formato.ts";
import { migasDePan } from "@/lib/datos-estructurados.ts";
import { URL_BASE } from "@/lib/sitio.ts";

/**
 * SEO de una lista (docs/SEO.md): canónica propia, `ItemList` en el orden del
 * autor y `BreadcrumbList`. Si no pasa el checklist de landing, `noindex`: se
 * publica, pero no se ofrece a Google. Sin `robots` propio si lo pasa, para no
 * pisar el `noindex` global que rige hasta el lanzamiento.
 */
export function metadatosDeLista({ lista, indexable }: VistaDeLista): Metadata {
  const ruta = rutaDeLista(lista.slug);
  return {
    title: lista.titulo,
    description: lista.entradilla,
    alternates: { canonical: ruta },
    ...(indexable ? {} : { robots: { index: false, follow: true } }),
    openGraph: {
      title: lista.titulo,
      description: lista.entradilla,
      url: ruta,
      type: "article",
    },
  };
}

export function datosEstructuradosDeLista({ lista, entradas }: VistaDeLista): object[] {
  const url = `${URL_BASE}${rutaDeLista(lista.slug)}`;
  return [
    {
      "@context": "https://schema.org",
      "@type": "ItemList",
      name: lista.titulo,
      description: lista.entradilla,
      url,
      itemListOrder: "https://schema.org/ItemListOrderAscending",
      numberOfItems: entradas.length,
      itemListElement: entradas.map(({ entrada, titulo }) => ({
        "@type": "ListItem",
        position: entrada.orden,
        name: titulo.titulo,
        url: `${URL_BASE}${rutaDeFicha(titulo)}`,
      })),
    },
    migasDePan([
      { nombre: "Inicio", ruta: "/" },
      { nombre: "Listas", ruta: "/listas" },
      { nombre: lista.titulo, ruta: rutaDeLista(lista.slug) },
    ]),
  ];
}
