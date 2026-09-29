/**
 * Tipos del pipeline de deltas.
 *
 * El pipeline **no conoce ningún driver**: habla con un `EjecutorSql`, igual
 * que el seed. Así la lógica se prueba sin base de datos.
 */
import type {
  Calidad,
  PrecioCanonico,
  TipoDeCambio,
} from "../../adapters/contracts.ts";

export type { EjecutorSql } from "../../ops/contratos.ts";

export const PAIS = "es";

/**
 * Una opción se considera **activa** mientras `missing_streak < 2`
 * (`src/db/schema/disponibilidad.ts`). Dos comprobaciones sin verla la retiran.
 */
export const UMBRAL_DE_INACTIVIDAD = 2;

/** Los tres estados derivados de una oferta lógica (`docs/DATA-MODEL.md`). */
export type EstadoDerivado = "upcoming" | "available" | "gone";

/**
 * Lo que hace falta de una opción para agregarla. Deliberadamente **sin `id`
 * ni plataforma**: la agregación es sobre las opciones de **una** oferta.
 */
export interface OpcionObservada {
  readonly link: string;
  readonly calidad: Calidad;
  readonly precio: PrecioCanonico | null;
  readonly idiomasAudio: readonly string[];
  readonly idiomasSubtitulos: readonly string[];
  readonly disponibleDesde: Date | null;
  readonly expiraEl: Date | null;
}

/**
 * El agregado de una oferta lógica, ya serializable.
 *
 * Las fechas van como ISO y no como `Date` a propósito: este objeto se escribe
 * tal cual en `before`/`after` y alimenta el `event_digest`, y un `Date` no
 * tiene una representación JSON única garantizada.
 */
export interface EstadoDeOferta {
  readonly opcionesActivas: number;
  readonly estado: EstadoDerivado;
  /** MIN de las opciones activas. */
  readonly disponibleDesde: string | null;
  /** MIN de los **no nulos**. `null` no significa «para siempre». */
  readonly expiraEl: string | null;
  /** El más barato, con su moneda. */
  readonly precio: PrecioCanonico | null;
  /** Conjunto ordenado de calidades observadas. `null` no entra. */
  readonly calidades: readonly string[];
  /** UNIÓN ordenada. Vacío significa «no consta», nunca «no tiene». */
  readonly idiomasAudio: readonly string[];
  readonly idiomasSubtitulos: readonly string[];
}

/** Una fila de `external_availability_options` tal y como vive hoy en la base. */
export interface OpcionExistente {
  readonly id: string;
  readonly link: string;
  readonly calidad: Calidad;
  readonly precio: PrecioCanonico | null;
  readonly idiomasAudio: readonly string[];
  readonly idiomasSubtitulos: readonly string[];
  readonly disponibleDesde: Date | null;
  readonly expiraEl: Date | null;
  readonly vistaPrimeroEn: Date;
  readonly ausenciasSeguidas: number;
  /**
   * `video_link`. Fuera del agregado a propósito: no cambia la oferta, solo
   * cómo se abre. Opcional porque solo lo lee el detalle de `updated`.
   */
  readonly enlaceReproduccion?: string | null;
}

/** La oferta lógica tal y como vive hoy, con sus opciones. */
export interface OfertaExistente {
  readonly id: string;
  readonly clave: string;
  /**
   * `last_checked_at`: el instante de la **última observación ya aplicada** a
   * esta oferta. Es lo que distingue una observación nueva de un reproceso
   * (`opciones.ts`, `esObservacionNueva`).
   */
  readonly ultimaComprobacion: Date | null;
  readonly opciones: readonly OpcionExistente[];
}

/**
 * Qué hacer con las opciones de una oferta. Lo decide `opciones.ts`, sin SQL.
 */
export interface PlanDeOpciones {
  /** Ids de provisionales obsoletas: misma URL, calidad ya conocida. */
  readonly aBorrar: readonly string[];
  /** `link` → `first_seen_at` heredado de la provisional que se retira. */
  readonly herencias: ReadonlyMap<string, Date>;
  /** Opciones que el snapshot no lista, con su nueva racha de ausencias. */
  readonly ausencias: readonly {
    readonly id: string;
    readonly ausenciasSeguidas: number;
  }[];
  /** Ids que el snapshot sí lista: su racha vuelve a cero. */
  readonly presentes: readonly string[];
  /** El conjunto activo **tras aplicar el plan**. Es el lado «después». */
  readonly activasDespues: readonly OpcionObservada[];
}

/** Un aviso que no puede representarse, y por qué. Nunca se evapora. */
export interface DescarteDeAviso {
  readonly tipo: TipoDeCambio;
  readonly idProveedor: string;
  readonly plataforma: string;
  readonly motivo: string;
}

/**
 * Una lista que terminó con `hasMore` y cursor **sin que nada lo dijera**:
 * `recorrerCambios` para al llegar a `maximoDePaginas`. Ese silencio es lo que
 * este registro elimina.
 */
export interface ListaNoAgotada {
  readonly tipo: TipoDeCambio;
  readonly cursorPendiente: string;
  readonly ultimoTimestamp: Date | null;
}

/**
 * Dos observaciones **de la misma ejecución** que dan otra fecha, o dos links
 * no nulos distintos, para la misma oferta anunciada. Se conserva la primera y
 * se reporta la segunda: no hay política todavía (ADR 0007). Un `NULL` frente
 * a un link no es conflicto. Fechas en ISO.
 */
export interface ConflictoDeAnuncio {
  readonly clave: string;
  readonly vigente: { readonly anunciadoPara: string; readonly enlace: string | null };
  readonly descartado: {
    readonly anunciadoPara: string;
    readonly enlace: string | null;
  };
}

/**
 * Qué hicieron los avisos `upcoming` con la tabla de anuncios
 * (`anuncios.ts`). Cada observación cae en **una** de: `nuevos`,
 * `sinCambios`, `actualizados`, `nuevosCiclos`, `mismaObservacion`,
 * `enlacesCompletados`, `fueraDeOrden` o `conflictos`; su suma es
 * `observados`.
 */
export interface InformeDeAnuncios {
  /** Avisos `upcoming` con título y de una plataforma del MVP. */
  readonly observados: number;
  readonly nuevos: number;
  /**
   * Observación nueva, mismo ciclo, misma fecha y sin link distinto (un `NULL`
   * que conserva el conocido también es «sin cambios»).
   */
  readonly sinCambios: number;
  /** Observación nueva, mismo ciclo, con otra fecha o con otro link no nulo. */
  readonly actualizados: number;
  /** De los actualizados: cuántos cambiaron de fecha y cuántos de link. */
  readonly fechasCambiadas: number;
  readonly enlacesCambiados: number;
  /**
   * Mismo ciclo, llegó `NULL` y se **conservó** el link conocido. No es una
   * clase: cae en `sinCambios` o en `actualizados`.
   */
  readonly enlacesConservados: number;
  /**
   * La misma observación trajo un link donde solo había `NULL`: se completa.
   * 📏 El orden de las páginas no cambia el resultado.
   */
  readonly enlacesCompletados: number;
  /** El anuncio anterior ya había vencido: `first_*` se reinician. */
  readonly nuevosCiclos: number;
  /** La misma observación otra vez: repetido de frontera o reproducción. */
  readonly mismaObservacion: number;
  /** Más vieja que la ya aplicada: no escribe nada. */
  readonly fueraDeOrden: number;
  /** Observados sin `link`. Se guardan con `link = NULL`. */
  readonly sinEnlace: number;
  readonly conflictos: readonly ConflictoDeAnuncio[];
}

// ── Detalle por oferta (opt-in: `detallarOfertas`) ──────────────────────────

/**
 * Qué se hizo con **una** oferta en una página. Una y solo una por oferta
 * evaluada:
 *
 *   · `fuera_de_catalogo` — su título no existe en la base y la ejecución solo
 *     toca títulos conocidos (`soloTitulosConocidos`): no se escribe nada.
 *   · `sin_oferta` — sin estado previo y el snapshot no la lista: nada que
 *     escribir. Un aviso no demuestra que la oferta exista.
 *   · `linea_base` — sin estado previo, el snapshot la lista y ningún aviso de
 *     alta la nombra: estado sin evento.
 *   · `retirada_sin_estado_previo` — un `removed` sobre algo que nunca vimos.
 *   · `observacion_ya_aplicada` — su `last_checked_at` no es anterior a esta
 *     observación: la misma otra vez o una más vieja. No se escribe nada.
 *   · `evaluada` — se comparó el antes con el después; `evento` dice si hubo
 *     cambio en el agregado.
 */
export type DestinoDeOferta =
  | "fuera_de_catalogo"
  | "sin_oferta"
  | "linea_base"
  | "retirada_sin_estado_previo"
  | "observacion_ya_aplicada"
  | "evaluada";

/** Una opción con lo que el agregado no mira: su `video_link`. */
export interface OpcionDetallada extends OpcionObservada {
  readonly enlaceReproduccion: string | null;
}

export interface EvaluacionDeOferta {
  /** La página de la ejecución (1, 2, 3…, contando todos los tipos). */
  readonly pagina: number;
  readonly clave: string;
  /** Los tipos de aviso que la nombran en la página. Vacío: solo el snapshot. */
  readonly nombradaPor: readonly TipoDeCambio[];
  readonly destino: DestinoDeOferta;
  /** ISO. El `last_checked_at` previo, o `null` sin estado previo. */
  readonly ultimaComprobacion: string | null;
  /** Las opciones **activas** en la base antes de escribir. */
  readonly antes: readonly OpcionDetallada[];
  /** Lo que el snapshot lista para esta oferta. */
  readonly snapshot: readonly OpcionDetallada[];
  /** Las activas tras aplicar el plan. `null` si no se planificó. */
  readonly despues: readonly OpcionObservada[] | null;
  readonly evento: {
    readonly tipo: "announced" | "added" | "changed" | "removed";
    readonly camposCambiados: readonly string[] | null;
  } | null;
}

/** Un aviso de una página confirmada, tal y como llegó y ya atribuido. */
export interface AvisoDetallado {
  readonly pagina: number;
  readonly tipo: TipoDeCambio;
  readonly idProveedor: string;
  /** `null` si la página no traía su show. */
  readonly imdbId: string | null;
  /** El id de la fuente (`hbo`, no `max`). */
  readonly plataformaFuente: string;
  /** Nuestro id, o `null` si está fuera del MVP. */
  readonly plataforma: string | null;
  readonly tipoOferta: string;
  readonly addon: string | null;
  /** ISO. */
  readonly instante: string;
  readonly enlace: string | null;
  /** `null` sin show o fuera del MVP: no hay oferta que nombrar. */
  readonly clave: string | null;
}

export interface DetalleDeOfertas {
  readonly avisos: readonly AvisoDetallado[];
  readonly evaluaciones: readonly EvaluacionDeOferta[];
}

/** Lo que el pipeline deja escrito y medido en una pasada. */
export interface InformeDeDeltas {
  readonly paginas: number;
  readonly avisos: number;
  readonly titulosTocados: number;
  readonly eventos: Readonly<Record<string, number>>;
  readonly eventosEscritos: number;
  readonly opcionesReconciliadas: number;
  readonly opcionesMarcadasAusentes: number;
  readonly descartes: readonly DescarteDeAviso[];
  readonly avisosSinShow: number;
  /**
   * De `avisosSinShow`, los que sí traían su show pero **sin identidad**
   * utilizable (`imdbId` ausente, vacío o solo espacios). No se escribe nada
   * de ese show: ni título, ni ofertas, ni imágenes, ni géneros.
   */
  readonly avisosSinIdentidad: number;
  readonly multiLinkOffers: number;
  readonly farFutureExpiries: number;
  readonly filasPorTabla: Readonly<Record<string, number>>;
  /**
   * Ofertas escritas como estado **sin evento**: no tenían estado previo y
   * ningún aviso de alta las nombraba. Es la línea base, no una alta.
   */
  readonly ofertasDeLineaBase: number;
  /** Avisos `removed` sobre ofertas que nunca vimos: sin «antes» que registrar. */
  readonly retiradasSinEstadoPrevio: number;
  /**
   * Ofertas cuya observación **ya estaba aplicada** (reproceso, o la misma
   * oferta en dos páginas de una ejecución): su `missing_streak` no se tocó.
   */
  readonly observacionesYaAplicadas: number;
  /**
   * Avisos `upcoming` sobre una oferta **ya disponible** (snapshot o base).
   * Su anuncio se guarda igual (ADR 0007); se cuentan porque «Próximamente»
   * tendrá que decidir qué hace con ellos.
   */
  readonly anunciosSobreOfertaDisponible: number;
  /** Qué hicieron los avisos `upcoming` con `external_availability_announcements`. */
  readonly anuncios: InformeDeAnuncios;
  readonly listasNoAgotadas: readonly ListaNoAgotada[];
  /**
   * Las ofertas que nombró algún aviso con título resuelto, por su clave
   * natural (`claveDeOferta`) y ordenadas. Solo las de las seis plataformas
   * del MVP. `expiring` las usa para saber qué ofertas de su horizonte ya no
   * lista el proveedor.
   */
  readonly ofertasNombradas: readonly string[];
  /**
   * Títulos con show que **no se escribieron** porque no existían en la base
   * y la ejecución solo toca títulos conocidos (`soloTitulosConocidos`). 0 si
   * no se pidió.
   */
  readonly titulosFueraDeCatalogo: number;
  /** Solo con `detallarOfertas`; `null` si no se pidió. */
  readonly detalle: DetalleDeOfertas | null;
}
