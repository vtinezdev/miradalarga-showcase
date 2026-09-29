/**
 * Validación de las respuestas de **Streaming Availability** (Movie of the Night).
 *
 * Aquí viven —y solo aquí— los nombres y las rarezas del proveedor. Nada de
 * este fichero puede filtrarse al modelo canónico: la traducción ocurre en
 * `normalizar.ts`, y `contracts.ts` no importa nada de este directorio.
 *
 * Forma verificada contra las 64 respuestas reales del Spike 1 (`spike-1/raw/`),
 * no contra la documentación del proveedor.
 */
import { z } from "zod";

/**
 * `rating` del proveedor: entero 0–100.
 *
 * Se valida el `0` **tal cual llega**. Convertirlo en ausencia es trabajo de la
 * normalización, no de la validación: este esquema describe lo que la fuente
 * dice, no lo que nosotros creemos.
 */
const ratingProveedor = z.number().int().min(0).max(100);

const generoProveedor = z.object({
  id: z.string(),
  name: z.string(),
});

/**
 * Anchos de imagen. El proveedor usa claves `w240`, `w360`… y no siempre ofrece
 * las mismas, así que se acepta cualquier clave `w<número>`.
 *
 * Las URLs van firmadas y caducan: son de un solo uso diferido, nunca una
 * clave estable que guardar, y la web no las sirve en runtime
 * (`docs/DATA-SOURCES.md` §1.9).
 */
const conjuntoAnchos = z.record(z.string().regex(/^w\d+$/), z.string().url());

const conjuntoImagenes = z.object({
  verticalPoster: conjuntoAnchos.optional(),
  horizontalPoster: conjuntoAnchos.optional(),
  verticalBackdrop: conjuntoAnchos.optional(),
  horizontalBackdrop: conjuntoAnchos.optional(),
});

const servicioProveedor = z.object({
  id: z.string(),
  name: z.string(),
  homePage: z.string().optional(),
  themeColorCode: z.string().optional(),
  imageSet: z.unknown().optional(),
});

const precioProveedor = z.object({
  amount: z.string(),
  currency: z.string(),
  formatted: z.string().optional(),
});

/** Tipos de oferta observados en ES: los cinco documentados aparecen de verdad. */
const tipoOfertaProveedor = z.enum(["subscription", "rent", "buy", "free", "addon"]);

const opcionEmisionProveedor = z.object({
  service: servicioProveedor,
  type: tipoOfertaProveedor,
  link: z.string(),
  videoLink: z.string().optional(),
  quality: z.enum(["sd", "hd", "uhd"]).optional(),
  price: precioProveedor.optional(),
  addon: servicioProveedor.optional(),
  /** Audios y subtítulos llegan con formas distintas entre sí. Así es la fuente. */
  audios: z.array(z.object({ language: z.string() }).passthrough()).optional(),
  subtitles: z
    .array(
      z
        .object({
          closedCaptions: z.boolean().optional(),
          locale: z.object({ language: z.string() }).passthrough(),
        })
        .passthrough(),
    )
    .optional(),
  expiresSoon: z.boolean().optional(),
  /** Marcas de tiempo UNIX en **segundos**, no en milisegundos. */
  availableSince: z.number().int().optional(),
  expiresOn: z.number().int().optional(),
});

/**
 * Un «show»: película o serie. El proveedor usa el mismo objeto para ambas y
 * las distingue por `showType`, con campos distintos según cuál sea.
 */
export const showProveedor = z
  .object({
    itemType: z.literal("show"),
    showType: z.enum(["movie", "series"]),
    id: z.string(),
    /**
     * Al 100 % en la muestra del Spike 1: es la clave de deduplicación.
     *
     * 📏 **Pero no siempre utilizable:** en la medición de `updated` del
     * 2026-09-25 llegó un show con `imdbId: ""`. Se acepta aquí tal cual —y
     * también ausente o `null`— para no tumbar la página entera por un show;
     * quien decide que no es una identidad es `normalizarImdbId`.
     */
    imdbId: z.string().nullish(),
    /** Llega con prefijo: `movie/47909`, no `47909`. */
    tmdbId: z.string().optional(),
    title: z.string(),
    originalTitle: z.string().optional(),
    /** Falta en buena parte del catálogo: hueco de traducción, no de dato (D1). */
    overview: z.string().optional(),
    rating: ratingProveedor.optional(),
    genres: z.array(generoProveedor).optional(),
    cast: z.array(z.string()).optional(),

    /** Solo películas. */
    releaseYear: z.number().int().optional(),
    runtime: z.number().int().optional(),
    directors: z.array(z.string()).optional(),

    /** Solo series. */
    firstAirYear: z.number().int().optional(),
    lastAirYear: z.number().int().optional(),
    seasonCount: z.number().int().optional(),
    episodeCount: z.number().int().optional(),
    creators: z.array(z.string()).optional(),

    imageSet: conjuntoImagenes.optional(),
    /** Disponibilidad indexada por país en minúsculas: `{ es: [...] }`. */
    streamingOptions: z.record(z.string(), z.array(opcionEmisionProveedor)).optional(),
  })
  .passthrough();

/**
 * Respuesta de `shows/search/filters`.
 *
 * `shows` es la lista, y `hasMore` junto con `nextCursor` gobiernan la
 * paginación — que es política de la Fase 2, no de este esquema.
 *
 * ⚠️ **Mismo defecto latente que tenía `/changes`, corregido a la vez.** Este
 * schema decía `{ meta, body: { shows } }`, que es el formato de
 * `spike-1/raw/` y no el de la API. Nunca había reventado porque
 * `adaptadorStreamingAvailability.normalizar()` todavía no se ha usado contra
 * la fuente en vivo: habría fallado igual, en el seed, después de gastar
 * cuota.
 */
export const respuestaBusquedaProveedor = z.object({
  shows: z.array(showProveedor),
  hasMore: z.boolean().optional(),
  nextCursor: z.string().optional(),
});

/**
 * Un aviso de `/changes`.
 *
 * 📏 Forma verificada contra las cinco respuestas 200 del Spike 1
 * (`raw/018`, `020`, `022`, `023`, `024`), 125 avisos en total.
 *
 * ⚠️ **`link` es opcional porque de verdad falta**: 0 de 25 en `removed` y 1
 * de 25 en `upcoming`. Declararlo obligatorio haría que el `safeParse`
 * rechazara avisos legítimos y los perdiéramos en silencio.
 *
 * ⚠️ **Este objeto NO contiene `imdbId` ni detalle comercial** —ni `quality`,
 * ni `price`, ni `audios`, ni `subtitles`—. Todo eso viaja en `shows`,
 * dentro de la misma respuesta.
 */
export const cambioProveedor = z
  .object({
    changeType: z.enum(["new", "removed", "updated", "expiring", "upcoming"]),
    itemType: z.literal("show"),
    /** Identificador **del proveedor**. La clave de `shows`. */
    showId: z.string(),
    showType: z.enum(["movie", "series"]),
    service: servicioProveedor,
    streamingOptionType: tipoOfertaProveedor,
    addon: servicioProveedor.optional(),
    link: z.string().optional(),
    /** Marca de tiempo UNIX en **segundos**. Su semántica depende de `changeType`. */
    timestamp: z.number().int(),
  })
  .passthrough();

/**
 * Respuesta de `/changes`: **dos colecciones, no una**.
 *
 * 📏 `shows` es un **objeto indexado por `showId`**, nunca un array, y cubre
 * exactamente los shows que referencian los avisos de esa misma página: en las
 * cinco respuestas medidas hay **0 avisos huérfanos y 0 shows sobrantes**, y
 * los **110 shows validan contra `showProveedor`** sin una sola modificación.
 * Por eso `normalizarShow` se reutiliza tal cual y este pipeline **no necesita
 * pedir la ficha de ningún título por separado**.
 *
 * ⚠️ **Esta es la forma del CUERPO HTTP, con todo en la raíz.** Las claves
 * viajan al mismo nivel; no hay ningún envoltorio `{meta, body}`. Ese
 * envoltorio existe **solo en `spike-1/raw/`**, porque `spike-1/probe.mjs`
 * guarda `{ meta: <sus metadatos>, body: <la respuesta> }` — es el formato del
 * grabador, no del proveedor. Modelarlo aquí costó una request y un `ZodError`
 * en `path: body`.
 */
export const respuestaCambiosProveedor = z.object({
  changes: z.array(cambioProveedor),
  shows: z.record(z.string(), showProveedor),
  hasMore: z.boolean().optional(),
  nextCursor: z.string().optional(),
});

export type ShowProveedor = z.infer<typeof showProveedor>;
export type RespuestaBusquedaProveedor = z.infer<typeof respuestaBusquedaProveedor>;
export type CambioProveedor = z.infer<typeof cambioProveedor>;
export type RespuestaCambiosProveedor = z.infer<typeof respuestaCambiosProveedor>;
