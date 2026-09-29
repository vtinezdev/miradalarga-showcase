import type { Metadata } from "next";
import type { VistaDeFicha } from "@/features/catalogo/consultas.ts";
import type { FichaDeTitulo, TipoDeOferta } from "@/features/catalogo/modelo.ts";
import { describirOferta, rutaDeFicha } from "@/features/catalogo/formato.ts";
import { agruparOfertas } from "@/features/catalogo/reglas.ts";
import { URL_BASE } from "@/lib/sitio.ts";

/**
 * SEO de la ficha (docs/SEO.md): metadatos por plantilla, `Movie`/`TVSeries`
 * con `WatchAction` por oferta y `BreadcrumbList`.
 *
 * ⛔ **Nunca `aggregateRating`**: la valoración que mostramos es ajena (CLAUDE.md,
 * regla 6). Un test lo vigila.
 */

export function metadatosDeFicha({ ficha }: VistaDeFicha): Metadata {
  const ruta = rutaDeFicha(ficha);
  const titulo = `Dónde ver ${ficha.titulo} (${ficha.anio})`;
  const descripcion =
    `${resumenDeDisponibilidad(ficha)} ${ficha.sinopsis ? primeraFrase(ficha.sinopsis) : ""}`.trim();
  return {
    title: titulo,
    description: descripcion,
    alternates: { canonical: ruta },
    openGraph: {
      title: titulo,
      description: descripcion,
      url: ruta,
      type: ficha.tipo === "pelicula" ? "video.movie" : "video.tv_show",
      ...(ficha.imagenes.fondo ? { images: [{ url: ficha.imagenes.fondo.url }] } : {}),
    },
  };
}

/** «Disponible en Netflix (suscripción) y Prime Video (alquiler desde 3,99 €).» */
export function resumenDeDisponibilidad(ficha: Pick<FichaDeTitulo, "ofertas">): string {
  const grupos = agruparOfertas(ficha.ofertas);
  if (grupos.length === 0)
    return "Ahora mismo no está en ninguna de las plataformas que seguimos en España.";
  const partes = grupos.map(
    (g) =>
      `${g.plataforma.nombre} (${g.ofertas.map((o) => describirOferta(o).toLowerCase()).join(", ")})`,
  );
  const lista =
    partes.length > 1
      ? `${partes.slice(0, -1).join(", ")} y ${partes.at(-1)}`
      : partes[0];
  return `Disponible en España en ${lista}.`;
}

function primeraFrase(texto: string): string {
  const fin = texto.search(/[.!?](\s|$)/);
  return fin === -1 ? texto : texto.slice(0, fin + 1);
}

const CATEGORIA: Record<TipoDeOferta, string> = {
  subscription: "subscription",
  free: "free",
  addon: "subscription",
  rent: "rental",
  buy: "purchase",
};

export function datosEstructuradosDeFicha({ ficha }: VistaDeFicha): object[] {
  const url = `${URL_BASE}${rutaDeFicha(ficha)}`;
  const personas = (nombres: string[]) =>
    nombres.map((name) => ({ "@type": "Person", name }));
  const obra: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": ficha.tipo === "pelicula" ? "Movie" : "TVSeries",
    name: ficha.titulo,
    url,
    inLanguage: ficha.idiomaOriginal,
    alternateName: ficha.tituloOriginal,
    genre: ficha.generos,
    description: ficha.sinopsis,
    image: ficha.imagenes.poster
      ? `${URL_BASE}${ficha.imagenes.poster.url}`
      : undefined,
    actor: personas(ficha.reparto.slice(0, 10)),
    potentialAction: ficha.ofertas.map((o) => ({
      "@type": "WatchAction",
      target: { "@type": "EntryPoint", urlTemplate: o.enlace, inLanguage: "es" },
      expectsAcceptanceOf: {
        "@type": "Offer",
        category: CATEGORIA[o.tipo],
        seller: { "@type": "Organization", name: o.plataforma.nombre },
        eligibleRegion: { "@type": "Country", name: "ES" },
        ...(o.precioDesde
          ? { price: (o.precioDesde.centimos / 100).toFixed(2), priceCurrency: "EUR" }
          : {}),
        ...(o.disponibleHasta ? { availabilityEnds: o.disponibleHasta } : {}),
      },
    })),
  };
  if (ficha.tipo === "pelicula") {
    obra.director = personas(ficha.direccion);
    obra.datePublished = String(ficha.anio);
    if (ficha.duracionMinutos !== undefined)
      obra.duration = `PT${ficha.duracionMinutos}M`;
  } else {
    obra.creator = personas(ficha.direccion);
    obra.startDate = String(ficha.anio);
    if (ficha.anioFin !== undefined) obra.endDate = String(ficha.anioFin);
    if (ficha.temporadas !== undefined) obra.numberOfSeasons = ficha.temporadas;
    if (ficha.episodios !== undefined) obra.numberOfEpisodes = ficha.episodios;
  }

  const seccion =
    ficha.tipo === "pelicula"
      ? { nombre: "Películas", ruta: "/peliculas" }
      : { nombre: "Series", ruta: "/series" };
  const migas = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Inicio", item: `${URL_BASE}/` },
      {
        "@type": "ListItem",
        position: 2,
        name: seccion.nombre,
        item: `${URL_BASE}${seccion.ruta}`,
      },
      { "@type": "ListItem", position: 3, name: ficha.titulo, item: url },
    ],
  };
  return [limpiar(obra), migas];
}

/** Quita claves `undefined`, que `JSON.stringify` ya omite, para que los tests comparen limpio. */
function limpiar(objeto: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(objeto).filter(([, v]) => v !== undefined));
}

export { jsonEnScript } from "@/lib/datos-estructurados.ts";
