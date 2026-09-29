/**
 * **Capa anticorrupción de la lectura**: filas de PostgreSQL → modelo de la
 * web (`src/features/catalogo/modelo.ts`). Funciones puras, sin red ni base.
 *
 * Aquí se decide todo lo que el esquema y la interfaz no comparten:
 *
 * - **Vocabulario:** `movie`/`series` → `pelicula`/`serie`; `uhd` → `uhd`;
 *   `added`/`removed`/`changed` → `llega`/`se-fue`/`cambio`.
 * - **Identidad:** el `id` de un título en la web es su **`imdb_id`**, no el
 *   `id` interno de la base: es el puente estable entre entornos y recargas
 *   (ADR 0001), y el que usará el contenido editorial.
 * - **Ausencias:** `null` de la base es «no lo sabemos» (regla 7), así que
 *   la propiedad **no se pone**; nunca un cero ni una cadena vacía.
 * - **Plataformas:** de la base solo llega el **id canónico**; el nombre y el
 *   slug públicos los pone `PLATAFORMAS_PUBLICAS`, nunca Neon ni el proveedor.
 * - **Imágenes:** ninguna. Ver `imagenesPublicables`.
 *
 * Ninguna fila de Drizzle ni nombre de columna sale de este fichero.
 */
import type {
  Anuncio,
  Calidad,
  FichaDeTitulo,
  ImagenesDeTitulo,
  Instante,
  Movimiento,
  Oferta,
  OfertaResumida,
  Plataforma,
  Precio,
  TipoDeMovimiento,
  TipoDeObra,
  TipoDeOferta,
  TituloResumen,
} from "@/features/catalogo/modelo.ts";
import {
  ordenDePlataforma,
  plataformaPublica,
} from "@/features/catalogo/plataformas.ts";
import { slugDeTitulo } from "@/lib/slug.ts";
import { ErrorDeCatalogo } from "./errores.ts";

/** Fuente de la valoración: la que publica el proveedor (docs/DATA-SOURCES.md §1.7). */
export const FUENTE_DE_VALORACION = "Streaming Availability";

// ── Filas: lo que devuelve cada consulta de `catalogo-sql.ts` ──────────────

/** Tipos crudos del driver: un `bigint` o un `count` llegan como texto. */
type Entero = number | string;
type Marca = Date | string;

export interface FilaDePlataforma {
  /** El id canónico (`external_platforms.id`), nunca el del proveedor. */
  platform_id: string;
}

export interface FilaDeTitulo {
  imdb_id: string;
  type: string;
  title: string;
  year: Entero | null;
  season_count: Entero | null;
  generos: string[] | null;
  /** `json_agg` de `{ plataforma, tipo, centimos }`. */
  disponibilidad: unknown;
  ultima_salida: Marca | null;
}

export interface FilaDeFicha extends FilaDeTitulo {
  original_title: string | null;
  overview: string | null;
  rating: Entero | null;
  runtime_minutes: Entero | null;
  episode_count: Entero | null;
  directors: string[] | null;
  cast_members: string[] | null;
  comprobado_en: Marca | null;
}

export interface FilaDeOferta extends FilaDePlataforma {
  offer_type: string;
  addon: string | null;
  enlace: string | null;
  centimos: Entero | null;
  calidad: Entero | null;
  audio: string[] | null;
  subtitulos: string[] | null;
  salida: Marca | null;
}

export interface FilaDeAnuncio extends FilaDePlataforma {
  offer_type: string;
  announced_for: Marca;
}

export interface FilaDeMovimiento extends FilaDePlataforma {
  imdb_id: string;
  fecha: Marca;
  /** Solo en `cambio`: los campos presentables que cambiaron. */
  campos?: string[] | null;
}

// ── Conversión de valores ──────────────────────────────────────────────────

function fallo(operacion: string, detalle: string): ErrorDeCatalogo {
  return new ErrorDeCatalogo("forma", operacion, detalle);
}

/** Un instante de la base, como ISO 8601 en UTC. Nunca `new Date()` de relleno. */
export function instante(valor: Marca, operacion = "mapeo"): Instante {
  const fecha = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(fecha.getTime())) throw fallo(operacion, "instante ilegible");
  return fecha.toISOString();
}

export function entero(valor: Entero, operacion = "mapeo"): number {
  const n = typeof valor === "number" ? valor : Number(valor);
  if (!Number.isInteger(n)) throw fallo(operacion, "entero ilegible");
  return n;
}

function enteroOpcional(valor: Entero | null | undefined): number | undefined {
  return valor === null || valor === undefined ? undefined : entero(valor);
}

function textoOpcional(valor: string | null | undefined): string | undefined {
  // 📏 La fuente manda la sinopsis sin traducir como cadena vacía (§1.2).
  return valor === null || valor === undefined || valor.trim() === ""
    ? undefined
    : valor;
}

export function tipoDeObra(tipo: string, operacion = "mapeo"): TipoDeObra {
  if (tipo === "movie") return "pelicula";
  if (tipo === "series") return "serie";
  throw fallo(operacion, `tipo de título desconocido «${tipo.slice(0, 20)}»`);
}

export function tipoDeTitleType(tipo: TipoDeObra): "movie" | "series" {
  return tipo === "pelicula" ? "movie" : "series";
}

const TIPOS_DE_OFERTA = new Set<TipoDeOferta>([
  "subscription",
  "free",
  "addon",
  "rent",
  "buy",
]);

export function tipoDeOferta(tipo: string, operacion = "mapeo"): TipoDeOferta {
  if (TIPOS_DE_OFERTA.has(tipo as TipoDeOferta)) return tipo as TipoDeOferta;
  throw fallo(operacion, `tipo de oferta desconocido «${tipo.slice(0, 20)}»`);
}

/** El SQL ordena la calidad como número (1 sd · 2 hd · 3 uhd) para tomar la máxima. */
const CALIDAD_POR_RANGO: Record<number, Calidad> = { 1: "sd", 2: "hd", 3: "uhd" };

/** Céntimos en euros. La base guarda `numeric(12,2)`: el SQL ya multiplica. */
export function precioEnEuros(centimos: Entero | null): Precio | undefined {
  if (centimos === null) return undefined;
  const n = entero(centimos);
  return n > 0 ? { centimos: n, moneda: "EUR" } : undefined;
}

/**
 * La plataforma pública de un id canónico. El SQL solo devuelve plataformas
 * publicadas, así que un id sin presentación es una consulta mal cambiada.
 */
export function plataforma(fila: FilaDePlataforma, operacion = "mapeo"): Plataforma {
  const p = plataformaPublica(fila.platform_id);
  if (p === null) {
    throw fallo(
      operacion,
      `plataforma sin presentación pública «${fila.platform_id.slice(0, 30)}»`,
    );
  }
  return p;
}

// ── Imágenes (ADR 0008) ────────────────────────────────────────────────────

/**
 * **Ninguna imagen es publicable hoy.** Neon guarda referencias del proveedor
 * (`external_title_images`): URLs **firmadas que caducan**, en su CDN. Que la
 * base conozca una imagen no la hace publicable: el ADR 0008 exige que viva
 * en R2 + CDN propio **y** que su uso tenga base aceptable, y hoy ninguna base
 * está aceptada. El pipeline de imágenes y su columna de estado no existen.
 *
 * Por eso el adaptador ni siquiera lee esas URLs: la interfaz recibe `{}` y
 * pinta el cartel tipográfico (`TitleImage`). Cuando exista el pipeline, esta
 * es la única función que cambia —y leerá las publicables, no las conocidas—.
 */
export function imagenesPublicables(): ImagenesDeTitulo {
  return {};
}

// ── Títulos ────────────────────────────────────────────────────────────────

interface DisponibilidadCruda {
  plataforma: string;
  tipo: string;
  centimos: Entero | null;
}

function disponibilidad(valor: unknown, operacion: string): OfertaResumida[] {
  if (valor === null || valor === undefined) return [];
  const lista: unknown = typeof valor === "string" ? JSON.parse(valor) : valor;
  if (!Array.isArray(lista)) throw fallo(operacion, "disponibilidad no es una lista");
  const ordenadas = [...(lista as DisponibilidadCruda[])].sort(
    (x, y) => ordenDePlataforma(x.plataforma) - ordenDePlataforma(y.plataforma),
  );
  return ordenadas.map((d) => {
    const precio = precioEnEuros(d.centimos);
    return {
      plataforma: plataforma({ platform_id: d.plataforma }, operacion),
      tipo: tipoDeOferta(d.tipo, operacion),
      ...(precio ? { precioDesde: precio } : {}),
    };
  });
}

/**
 * Un título en su forma de tarjeta. El slug se deriva (`src/lib/slug.ts`); el
 * SQL ya ha filtrado los que no son enrutables o no tienen año, así que aquí
 * una ausencia es una consulta mal cambiada y falla.
 */
export function tituloResumen(
  fila: FilaDeTitulo,
  operacion = "titulos",
): TituloResumen {
  const slug = slugDeTitulo(fila.title, fila.imdb_id);
  if (slug === null || fila.year === null) {
    throw fallo(operacion, "título sin identidad enrutable o sin año");
  }
  const tipo = tipoDeObra(fila.type, operacion);
  const ofertas = disponibilidad(fila.disponibilidad, operacion);
  const temporadas = tipo === "serie" ? enteroOpcional(fila.season_count) : undefined;
  return {
    id: fila.imdb_id,
    slug,
    tipo,
    titulo: fila.title,
    anio: entero(fila.year, operacion),
    // Sin `anioFin`: la base guarda el año de la última emisión, no si la
    // serie terminó, y el modelo lo reserva a series terminadas.
    generos: fila.generos ?? [],
    ...(temporadas === undefined ? {} : { temporadas }),
    imagenes: imagenesPublicables(),
    disponibilidad: ofertas,
    ...(ofertas.length === 0 && fila.ultima_salida !== null
      ? { fueraDesde: instante(fila.ultima_salida, operacion) }
      : {}),
  };
}

export function oferta(fila: FilaDeOferta, operacion = "ficha"): Oferta | null {
  // Sin enlace no hay oferta que mostrar: una oferta disponible siempre tiene
  // al menos una opción activa, y `link` es NOT NULL en las opciones.
  if (fila.enlace === null) return null;
  const precio = precioEnEuros(fila.centimos);
  const rango = enteroOpcional(fila.calidad);
  const calidad = rango === undefined ? undefined : CALIDAD_POR_RANGO[rango];
  const audio = fila.audio ?? [];
  const subtitulos = fila.subtitulos ?? [];
  return {
    plataforma: plataforma(fila),
    tipo: tipoDeOferta(fila.offer_type, operacion),
    // El nombre del canal no se guarda (ADR 0005): solo su identidad.
    ...(fila.addon === null ? {} : { addon: { id: fila.addon } }),
    ...(precio ? { precioDesde: precio } : {}),
    ...(calidad ? { calidad } : {}),
    // 📏 Un array vacío es «no consta», no «no tiene»: sin idiomas, no se pone.
    ...(audio.length > 0 || subtitulos.length > 0
      ? { idiomas: { audio, subtitulos } }
      : {}),
    ...(fila.salida === null
      ? {}
      : { disponibleHasta: instante(fila.salida, operacion) }),
    enlace: fila.enlace,
  };
}

export function anuncio(fila: FilaDeAnuncio, operacion = "ficha"): Anuncio {
  return {
    plataforma: plataforma(fila),
    tipo: tipoDeOferta(fila.offer_type, operacion),
    fecha: instante(fila.announced_for, operacion),
  };
}

// ── Movimientos ────────────────────────────────────────────────────────────

/**
 * `changed_fields` que dicen algo al lector, y cómo se dicen. `options`,
 * `state` y `available_since` son mecánica de la ingesta (una variante que
 * entra o sale, una rotación de enlace): **un cambio solo con ellos no se
 * publica**. Lo filtra el SQL (`CAMPOS_PRESENTABLES`); aquí se redacta.
 */
export const CAMPOS_PRESENTABLES = {
  price: "Cambio de precio",
  quality: "Cambio de calidad",
  audio_languages: "Cambian los idiomas de audio",
  subtitle_languages: "Cambian los subtítulos",
  expires_at: "Cambia la fecha de salida",
} as const satisfies Record<string, string>;

type CampoPresentable = keyof typeof CAMPOS_PRESENTABLES;

function esPresentable(campo: string): campo is CampoPresentable {
  return Object.hasOwn(CAMPOS_PRESENTABLES, campo);
}

/** «Cambio de precio», o «Cambio de precio y de calidad» si hay varios. */
export function detalleDeCambio(campos: readonly string[]): string | undefined {
  const utiles = [...new Set(campos.filter(esPresentable))].sort();
  const [primero] = utiles;
  if (primero === undefined) return undefined;
  return utiles.length === 1 ? CAMPOS_PRESENTABLES[primero] : "Cambios en la oferta";
}

export function movimiento(
  tipo: TipoDeMovimiento,
  fila: FilaDeMovimiento,
  operacion = "movimientos",
): Movimiento {
  const detalle = tipo === "cambio" ? detalleDeCambio(fila.campos ?? []) : undefined;
  return {
    tipo,
    tituloId: fila.imdb_id,
    plataforma: plataforma(fila),
    fecha: instante(fila.fecha, operacion),
    ...(detalle ? { detalle } : {}),
  };
}

// ── Ficha ──────────────────────────────────────────────────────────────────

export function ficha(
  fila: FilaDeFicha,
  partes: {
    ofertas: FilaDeOferta[];
    anuncios: FilaDeAnuncio[];
    movimientos: Movimiento[];
    /** La última observación de su disponibilidad (la decide el repositorio). */
    comprobadoEn: Instante;
  },
): FichaDeTitulo {
  const resumen = tituloResumen(fila, "ficha");
  const ofertas = partes.ofertas.flatMap((f) => oferta(f) ?? []);
  const rating = enteroOpcional(fila.rating);
  const duracion = enteroOpcional(fila.runtime_minutes);
  const episodios =
    resumen.tipo === "serie" ? enteroOpcional(fila.episode_count) : undefined;
  const original = textoOpcional(fila.original_title);
  const sinopsis = textoOpcional(fila.overview);
  return {
    ...resumen,
    // Solo si difiere del español: repetirlo no dice nada.
    ...(original && original !== fila.title ? { tituloOriginal: original } : {}),
    ...(resumen.tipo === "pelicula" && duracion !== undefined
      ? { duracionMinutos: duracion }
      : {}),
    ...(episodios === undefined ? {} : { episodios }),
    ...(sinopsis ? { sinopsis } : {}),
    direccion: (fila.directors ?? []).filter((d) => d.trim() !== ""),
    reparto: (fila.cast_members ?? []).filter((d) => d.trim() !== ""),
    // `0` ya es `null` en la base (CHECK 1..100): lo que llega es una valoración.
    ...(rating === undefined
      ? {}
      : { valoracion: { valor: rating, fuente: FUENTE_DE_VALORACION } }),
    ofertas,
    anuncios: partes.anuncios.map((a) => anuncio(a)),
    movimientos: partes.movimientos,
    comprobadoEn: partes.comprobadoEn,
  };
}
