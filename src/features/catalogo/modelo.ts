/**
 * Modelo de lectura de la web: lo que las pantallas necesitan saber del
 * catálogo, en la forma en que lo necesitan.
 *
 * No es el esquema de la base (`src/db/schema/`) ni la forma del proveedor
 * (`jobs/adapters/`): es el contrato entre las consultas de aplicación y la
 * interfaz. Un adaptador —hoy el de desarrollo, mañana el de Neon— traduce su
 * origen a estos tipos, y ninguna pantalla sabe de dónde vienen.
 *
 * Reglas que el modelo hace explícitas (CLAUDE.md, regla 7: no inventar datos):
 * todo lo que puede faltar es opcional, y ausente significa «no lo sabemos»,
 * nunca cero ni cadena vacía.
 */

/** Instante ISO 8601 con zona (`2026-09-28T04:10:00Z`). */
export type Instante = string;

export type TipoDeObra = "pelicula" | "serie";

/** `id` de `external_platforms`: identidad estable, nunca el nombre (ADR 0005). */
export type IdPlataforma = string;

export interface Plataforma {
  id: IdPlataforma;
  /** Nombre de presentación, tal y como viene del dato. */
  nombre: string;
  /** Segmento de URL de su hub (`/plataformas/{slug}`): Max es `hbo` de id y `max` de slug. */
  slug: string;
}

// ── Capacidades (docs/DATA-SOURCES.md §1.4) ────────────────────────────────

export type Capacidad =
  "expiring" | "upcoming" | "official_top" | "prices" | "popularity_order";

export type EstadoDeCapacidad =
  "supported_with_data" | "supported_no_data_in_sample" | "not_supported" | "unknown";

export type MatrizDeCapacidades = Record<
  IdPlataforma,
  Partial<Record<Capacidad, EstadoDeCapacidad>>
>;

// ── Imágenes (ADR 0008) ─────────────────────────────────────────────────────

/**
 * Una imagen que **ya se puede publicar**: alojada en infraestructura propia y
 * con base de uso aceptable. El adaptador es quien decide; la interfaz solo ve
 * imágenes publicables o ninguna. Nunca una URL firmada del proveedor.
 */
export interface ImagenPublicable {
  url: string;
  ancho: number;
  alto: number;
  /** Texto alternativo, solo si la imagen dice algo que el título no dice. */
  alt?: string;
}

export interface ImagenesDeTitulo {
  poster?: ImagenPublicable;
  fondo?: ImagenPublicable;
}

// ── Disponibilidad ─────────────────────────────────────────────────────────

export type TipoDeOferta = "subscription" | "free" | "addon" | "rent" | "buy";

export type Calidad = "sd" | "hd" | "qhd" | "uhd";

export interface Precio {
  /** Importe en céntimos, para no arrastrar errores de coma flotante. */
  centimos: number;
  moneda: "EUR";
}

export interface Oferta {
  plataforma: Plataforma;
  tipo: TipoDeOferta;
  /**
   * Canal adicional: identidad por `id` del proveedor (ADR 0005). El nombre es
   * presentación y **la base no lo guarda**: sin tabla curada de addons, falta.
   */
  addon?: { id: string; nombre?: string };
  precioDesde?: Precio;
  calidad?: Calidad;
  idiomas?: { audio: string[]; subtitulos: string[] };
  /** Fecha de salida anunciada, solo si es futura y la capacidad está en ✅. */
  disponibleHasta?: Instante;
  enlace: string;
}

/** Lo mínimo de una oferta para una tarjeta o una fila. */
export interface OfertaResumida {
  plataforma: Plataforma;
  tipo: TipoDeOferta;
  precioDesde?: Precio;
}

/** Llegada anunciada y vigente (ADR 0007: la vigencia la decide el adaptador). */
export interface Anuncio {
  plataforma: Plataforma;
  tipo: TipoDeOferta;
  fecha: Instante;
}

// ── Movimientos del catálogo ────────────────────────────────────────────────

export type TipoDeMovimiento = "llega" | "se-va" | "proximamente" | "se-fue" | "cambio";

export interface Movimiento {
  tipo: TipoDeMovimiento;
  tituloId: string;
  plataforma: Plataforma;
  /** Para «llega» y «se-fue», cuándo pasó; para «se-va» y «proximamente», cuándo pasará. */
  fecha: Instante;
  /** Solo en «cambio»: el campo cambiado, contado en una frase útil. */
  detalle?: string;
}

// ── Títulos ────────────────────────────────────────────────────────────────

export interface TituloResumen {
  id: string;
  slug: string;
  tipo: TipoDeObra;
  titulo: string;
  anio: number;
  /** Solo series terminadas. */
  anioFin?: number;
  generos: string[];
  /** Solo series, si lo sabemos. */
  temporadas?: number;
  imagenes: ImagenesDeTitulo;
  disponibilidad: OfertaResumida[];
  /**
   * Solo si hoy no está en ninguna plataforma: la última salida registrada. Sin
   * salida registrada, ausente (no sabemos desde cuándo).
   */
  fueraDesde?: Instante;
}

export interface ValoracionExterna {
  /** 1–100; `0` del proveedor ya es ausencia en el adaptador (docs/DATA-SOURCES.md §1.7). */
  valor: number;
  fuente: string;
}

export interface FichaDeTitulo extends TituloResumen {
  tituloOriginal?: string;
  /** Código BCP 47 del título original, si lo sabemos (`en`, `fr`…). */
  idiomaOriginal?: string;
  duracionMinutos?: number;
  episodios?: number;
  /** Solo en español. Si no existe, no se muestra ni se traduce (§1.2). */
  sinopsis?: string;
  direccion: string[];
  reparto: string[];
  valoracion?: ValoracionExterna;
  ofertas: Oferta[];
  anuncios: Anuncio[];
  movimientos: Movimiento[];
  /** Última observación de su disponibilidad. */
  comprobadoEn: Instante;
}

// ── Editorial ──────────────────────────────────────────────────────────────

export interface Autor {
  nombre: string;
  slug: string;
}

/** Conjunto cerrado de `PRODUCT.md` §10. */
export type EtiquetaEditorial =
  | "Imprescindible"
  | "Joya escondida"
  | "Ideal para un fin de semana"
  | "Fácil de ver"
  | "Exigente"
  | "Ritmo lento"
  | "Gran espectáculo"
  | `Para fans de ${string}`;

export interface EntradaEditorial {
  orden: number;
  tituloId: string;
  veredicto: string;
  etiqueta?: EtiquetaEditorial;
}

export interface ListaEditorial {
  id: string;
  slug: string;
  titulo: string;
  entradilla: string;
  autor: Autor;
  publicada: Instante;
  revisada: Instante;
  entradas: EntradaEditorial[];
  /**
   * Introducción propia, en párrafos separados por una línea en blanco. Es la
   * que decide si la lista pasa el checklist de landing (docs/SEO.md: ≥ 120
   * palabras). Sin ella, la lista se publica pero no se indexa.
   */
  introduccion?: string;
  /** «Cómo la hemos hecho»: el criterio de selección, si el autor lo escribió. */
  criterio?: string;
  imagen?: ImagenPublicable;
}

// ── Rankings ───────────────────────────────────────────────────────────────

export interface PosicionMejorValorada {
  posicion: number;
  titulo: TituloResumen;
  valoracion: ValoracionExterna;
}

// ── Filtros y búsqueda (contrato del puerto) ────────────────────────────────

/** Acota movimientos. Todo es opcional: sin filtro, todos. */
export interface FiltroDeMovimientos {
  plataforma?: IdPlataforma;
  obra?: TipoDeObra;
  /** Instantes inclusivos sobre `Movimiento.fecha`. */
  desde?: Instante;
  hasta?: Instante;
}

/** Acota el catálogo disponible hoy. */
export interface FiltroDeCatalogo {
  tipo?: TipoDeObra;
  plataforma?: IdPlataforma;
  genero?: string;
}

export interface ResultadoDeBusqueda {
  titulo: TituloResumen;
  /** Solo si la consulta coincide con el título original y no con el español. */
  tituloOriginal?: string;
}

export interface RecuentoDeGenero {
  nombre: string;
  recuento: number;
}
