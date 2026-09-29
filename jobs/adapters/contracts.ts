/**
 * Modelo canónico de Mirada Larga.
 *
 * Este fichero es la **capa anticorrupción** (CLAUDE.md, regla innegociable 2):
 * define la única forma que el resto del sistema conoce. Ninguna peculiaridad
 * de un proveedor puede filtrarse hasta aquí.
 *
 * Regla estructural, verificada por los tests:
 *   contracts.ts NO importa nada de ningún directorio de proveedor.
 *   La dependencia va en un solo sentido:
 *
 *     proveedor → schema externo → normalización → contrato canónico
 *
 * Cuando aparezca un segundo proveedor, debe poder cumplir este contrato sin
 * que este fichero cambie. Si hay que cambiarlo para encajar una fuente, la
 * capa anticorrupción ha fallado.
 */

/** Tipo de obra. Determina la ruta pública: /peliculas/… o /series/…  */
export type TipoTitulo = "pelicula" | "serie";

/**
 * Valoración canónica: **1..100, o `null` si no hay dato**.
 *
 * Medido en el Spike 1: la fuente emite `0` para «sin valoración todavía», no
 * para «valoración pésima». El 1 % de la muestra vale 0, ningún título cae
 * entre 0 y 10, y los ceros se concentran en los estrenos. Tratar ese 0 como
 * una nota real hundiría los estrenos al fondo de cualquier ranking.
 *
 * La conversión `0 → null` ocurre **una sola vez**, en la normalización. Nada
 * aguas abajo tiene que acordarse de que `0` significaba ausencia.
 */
export type Valoracion = number | null;

/** Cómo se accede a un título en una plataforma. */
export type TipoOferta = "subscription" | "rent" | "buy" | "free" | "addon";

/** Calidad máxima ofrecida. `null` cuando la fuente no la declara. */
export type Calidad = "sd" | "hd" | "uhd" | null;

/** Identificadores externos. `imdbId` está al 100 % y es la clave de deduplicación. */
export interface IdentificadoresExternos {
  /**
   * Identificador de IMDb (`tt…`). Clave canónica de deduplicación.
   * **Nunca vacío ni solo espacios**: un show así no llega a ser
   * `TituloCanonico` (`normalizarImdbId`).
   */
  readonly imdbId: string;
  /** Identificador de TMDB tal y como lo emite la fuente, o `null`. */
  readonly tmdbId: string | null;
  /** Identificador interno del proveedor del que vino el dato. */
  readonly idProveedor: string;
}

/** Una imagen disponible en varios anchos. Las URLs son temporales y firmadas. */
export interface ImagenCanonica {
  readonly tipo:
    "poster_vertical" | "poster_horizontal" | "fondo_vertical" | "fondo_horizontal";
  /** Anchos disponibles, en píxeles, asociados a su URL. */
  readonly urlPorAncho: Readonly<Record<number, string>>;
}

/** Precio de una oferta transaccional. Importe en texto para no perder precisión. */
export interface PrecioCanonico {
  readonly importe: string;
  readonly moneda: string;
}

/**
 * Disponibilidad de un título en una plataforma y un país concretos.
 * El país va en cada fila desde el diseño: el modelo es multi-país aunque solo
 * se explote ES (Plan §21).
 */
export interface DisponibilidadCanonica {
  readonly plataformaId: string;
  /** Código ISO 3166-1 alfa-2 en minúsculas. */
  readonly pais: string;
  readonly tipoOferta: TipoOferta;
  readonly enlace: string;
  readonly enlaceReproduccion: string | null;
  readonly calidad: Calidad;
  readonly precio: PrecioCanonico | null;
  /**
   * **Identificador** del canal adicional cuando `tipoOferta` es `addon`.
   *
   * Es el `id` del proveedor, no su nombre comercial. Forma parte de la
   * identidad de una oferta lógica, y **un nombre de presentación no puede
   * identificar nada**: 📏 en el corpus del Spike 1 hay 27 ids de addon pero
   * solo 25 nombres — «AMC+» y «MUBI» los comparten dos addons distintos cada
   * uno—, así que guardar el nombre colapsaría dos ofertas en una.
   *
   * El nombre es presentación y hoy no se almacena (ADR 0005).
   */
  readonly addon: string | null;
  /** Códigos de idioma de audio, tal y como los declara la fuente. */
  readonly idiomasAudio: readonly string[];
  /** Códigos de idioma de subtítulos. */
  readonly idiomasSubtitulos: readonly string[];
  /** Instante desde el que está disponible, o `null` si no consta. */
  readonly disponibleDesde: Date | null;
  /** Instante en que deja de estarlo, o `null`. `null` NO significa «para siempre». */
  readonly expiraEl: Date | null;
}

/**
 * Clase de aviso de cambio de disponibilidad.
 *
 * 📏 Los cinco valores están medidos en `spike-1/raw/017..024*.json`. **No son
 * tipos de evento**: un aviso dice *qué oferta hay que volver a mirar*, nunca
 * qué le pasó. El `event_type` del histórico sale siempre de comparar el
 * estado anterior con el nuevo (`docs/DATA-MODEL.md`).
 */
export type TipoDeCambio = "new" | "removed" | "updated" | "expiring" | "upcoming";

/**
 * Un aviso de `/changes`, ya normalizado.
 *
 * Es deliberadamente **más pobre** que `DisponibilidadCanonica`: un aviso no
 * es una oferta. Lo que la fuente entrega aquí es identidad más un instante, y
 * el detalle comercial llega aparte, en el `show` completo que acompaña a la
 * misma respuesta.
 */
export interface AvisoCanonico {
  readonly tipo: TipoDeCambio;
  /** `showId`: el identificador del proveedor, **no** el `imdbId`. */
  readonly idProveedor: string;
  readonly tipoTitulo: TipoTitulo;
  readonly plataformaId: string;
  readonly tipoOferta: TipoOferta;
  readonly addon: string | null;
  /**
   * 📏 **Puede faltar, y su ausencia es un hecho, no un descuido.** Nunca llega
   * en `removed` (0 de 25: la oferta ya no existe) y falta en 1 de 25
   * `upcoming`. `external_availability_options.link` es `NOT NULL`, así que un
   * aviso sin enlace **no es representable como opción** y no se inventa uno.
   */
  readonly enlace: string | null;
  /**
   * El `timestamp` del aviso. Su significado depende de `tipo`: instante del
   * alta o la baja en `new`/`removed`/`updated`, de la expiración en
   * `expiring`, y del estreno anunciado en `upcoming`.
   *
   * 📏 En `expiring` y `upcoming` es **futuro en 25 de 25** respecto al
   * instante de captura.
   */
  readonly instante: Date;
}

/** Un género, con su identificador y su nombre tal y como los da la fuente. */
export interface GeneroCanonico {
  readonly id: string;
  readonly nombre: string;
}

/**
 * Un título del catálogo, ya normalizado.
 *
 * `null` significa siempre **«no lo sabemos»**, nunca un valor por defecto
 * inventado (CLAUDE.md, regla 7).
 */
export interface TituloCanonico {
  readonly tipo: TipoTitulo;
  readonly ids: IdentificadoresExternos;
  readonly titulo: string;
  readonly tituloOriginal: string | null;
  /** Sinopsis en el idioma solicitado. Falta en buena parte del catálogo (D1). */
  readonly sinopsis: string | null;
  readonly valoracion: Valoracion;
  /** Año de estreno (película) o de primera emisión (serie). */
  readonly anio: number | null;
  /** Solo series: año de la última emisión. */
  readonly anioFin: number | null;
  /** Solo películas: duración en minutos. */
  readonly duracionMinutos: number | null;
  /**
   * Solo series: número de temporadas y de episodios.
   *
   * Son **contadores escalares**, que es lo único que la fuente entrega. No
   * existen entidades de temporada ni de episodio: en las 64 respuestas del
   * Spike 1 no aparece un solo array `seasons[]` ni `episodes[]`.
   */
  readonly numeroTemporadas: number | null;
  readonly numeroEpisodios: number | null;
  readonly generos: readonly GeneroCanonico[];
  /** Reparto como texto plano: la fuente no da identificadores ni fotos. */
  readonly reparto: readonly string[];
  /** Dirección (películas) o creación (series). */
  readonly direccion: readonly string[];
  readonly imagenes: readonly ImagenCanonica[];
  readonly disponibilidad: readonly DisponibilidadCanonica[];
}

/**
 * Contrato que todo adaptador de catálogo debe cumplir.
 *
 * Un adaptador **no** decide política: no pagina por su cuenta, no gestiona
 * presupuesto de cuota y no escribe en base de datos. Traduce, y nada más.
 */
export interface AdaptadorCatalogo {
  /** Identificador estable de la fuente, para trazabilidad y atribución. */
  readonly fuente: string;
  /** Traduce una respuesta cruda de la fuente al modelo canónico. */
  normalizar(respuestaCruda: unknown, pais: string): readonly TituloCanonico[];
}
