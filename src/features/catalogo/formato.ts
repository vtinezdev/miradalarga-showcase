import type {
  Calidad,
  EstadoDeCapacidad,
  Oferta,
  Plataforma,
  Precio,
  TipoDeObra,
  TipoDeOferta,
  TituloResumen,
} from "./modelo.ts";

/**
 * Cómo se dicen los datos del catálogo en la interfaz (BRAND.md §6). Un solo
 * sitio, para que «Suscripción» no se escriba de tres formas distintas.
 */

const EUROS = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" });

export function precio(p: Precio): string {
  return EUROS.format(p.centimos / 100);
}

const TIPO_DE_OFERTA: Record<TipoDeOferta, string> = {
  subscription: "Suscripción",
  free: "Gratis con anuncios",
  addon: "Canal adicional",
  rent: "Alquiler",
  buy: "Compra",
};

/** «Suscripción», «Alquiler desde 3,99 €», «Canal adicional: Canal Pánico». */
export function describirOferta(
  oferta: Pick<Oferta, "tipo" | "precioDesde" | "addon">,
): string {
  const base = TIPO_DE_OFERTA[oferta.tipo];
  if (oferta.tipo === "addon" && oferta.addon?.nombre)
    return `${base}: ${oferta.addon.nombre}`;
  if (oferta.precioDesde) return `${base} desde ${precio(oferta.precioDesde)}`;
  return base;
}

export function tipoDeOferta(tipo: TipoDeOferta): string {
  return TIPO_DE_OFERTA[tipo];
}

const CALIDAD: Record<Calidad, string> = { sd: "SD", hd: "HD", qhd: "QHD", uhd: "4K" };

export function calidad(c: Calidad): string {
  return CALIDAD[c];
}

export function tipoDeObra(tipo: TipoDeObra): string {
  return tipo === "pelicula" ? "Película" : "Serie";
}

/** «2016–2022» para series terminadas; el año de estreno en lo demás. */
export function anios(t: Pick<TituloResumen, "anio" | "anioFin">): string {
  return t.anioFin !== undefined && t.anioFin !== t.anio
    ? `${t.anio}–${t.anioFin}`
    : String(t.anio);
}

/** «2 h 9 min», «58 min». */
export function duracion(minutos: number): string {
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** «3 temporadas · 24 episodios», «1 temporada». */
export function temporadas(
  numTemporadas?: number,
  numEpisodios?: number,
): string | null {
  const partes: string[] = [];
  if (numTemporadas !== undefined) {
    partes.push(`${numTemporadas} ${numTemporadas === 1 ? "temporada" : "temporadas"}`);
  }
  if (numEpisodios !== undefined) {
    partes.push(`${numEpisodios} ${numEpisodios === 1 ? "episodio" : "episodios"}`);
  }
  return partes.length > 0 ? partes.join(" · ") : null;
}

/** Ruta canónica de la ficha (docs/SEO.md): `/peliculas/{slug}` o `/series/{slug}`. */
export function rutaDeFicha(t: Pick<TituloResumen, "tipo" | "slug">): string {
  return `/${t.tipo === "pelicula" ? "peliculas" : "series"}/${t.slug}`;
}

export function rutaDeLista(slug: string): string {
  return `/listas/${slug}`;
}

export function rutaDePlataforma(p: Pick<Plataforma, "slug">): string {
  return `/plataformas/${p.slug}`;
}

/** «Netflix», «Netflix y Max», «Netflix, Max y SkyShowtime». */
export function enumerar(nombres: readonly string[]): string {
  if (nombres.length <= 1) return nombres[0] ?? "";
  return `${nombres.slice(0, -1).join(", ")} y ${nombres.at(-1)}`;
}

/** «1 película», «3 series»: singular y plural del tipo de obra. */
export function contarObras(n: number, tipo: TipoDeObra): string {
  if (tipo === "pelicula") return `${n} ${n === 1 ? "película" : "películas"}`;
  return `${n} ${n === 1 ? "serie" : "series"}`;
}

/** «1 título», «14 títulos». */
export function contarTitulos(n: number): string {
  return `${n} ${n === 1 ? "título" : "títulos"}`;
}

/**
 * Por qué una plataforma no tiene datos de salidas o de llegadas anunciadas
 * (INFORMATION-ARCHITECTURE.md §7): no soportado, no medido, sin datos en la
 * muestra o, con la capacidad en ✅, ausencia real. Cuatro frases distintas:
 * un silencio nunca se presenta como una negación.
 */
export function mensajeDeCapacidad(
  capacidad: "expiring" | "upcoming",
  estado: EstadoDeCapacidad,
  plataforma: string,
): string {
  const que = capacidad === "expiring" ? "salidas" : "llegadas";
  switch (estado) {
    case "supported_with_data":
      return capacidad === "expiring"
        ? `Ninguna salida anunciada en ${plataforma} en los próximos 31 días.`
        : `Ninguna llegada anunciada en ${plataforma} en los próximos 31 días.`;
    case "supported_no_data_in_sample":
      return `No hemos visto ${que} anunciadas en ${plataforma}.`;
    case "not_supported":
      return capacidad === "expiring"
        ? `${plataforma} no anuncia sus salidas.`
        : `${plataforma} no anuncia sus próximas llegadas.`;
    case "unknown":
      return `Todavía no medimos las ${que} anunciadas de ${plataforma}.`;
  }
}
