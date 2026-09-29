/**
 * Las consultas de lectura del catálogo, **una por necesidad**: ninguna
 * megaconsulta universal. Todas son `sql` de Drizzle parametrizado y todas
 * llevan `LIMIT` o están acotadas por construcción (una lista de ids, las
 * plataformas del MVP). Solo `SELECT`.
 *
 * Reglas derivadas que se aplican aquí, en la base, y no en JavaScript —cada
 * una implementa una decisión ya documentada, no una nueva—:
 *
 * - **Opción activa:** `missing_streak < 2` (docs/DATA-MODEL.md).
 * - **Oferta disponible hoy:** alguna opción activa con `available_since`
 *   pasado o que no consta (`esFutura` de los jobs: `null` no es futuro).
 * - **Título publicable:** con año y con `imdb_id` enrutable (`src/lib/slug.ts`).
 *   El modelo de la web exige ambos; un título sin ellos no tiene ficha.
 * - **Salida próxima** (`leaving_soon`): la menor `expires_at` **futura** de
 *   las opciones activas, a ≤ 30 días (`salidaProxima`, 336/336 medidas), y
 *   solo en plataformas con `expiring` en ✅.
 * - **Anuncio vigente** (ADR 0007, `jobs/pipelines/upcoming/vigencia.ts`):
 *   fecha futura **y** observado por el último recorrido completo de
 *   `upcoming` o uno posterior, y solo con `upcoming` en ✅. Las plataformas
 *   sin cobertura del endpoint (SkyShowtime) tienen `upcoming` ❌, así que la
 *   rama «solo la fecha» de la regla nunca llega a publicarse.
 * - **Plataforma publicada:** activa en Neon **y** con presentación en la web
 *   (`PLATAFORMAS_PUBLICAS`). De Neon solo se lee el id canónico: el nombre y el
 *   slug públicos no salen de la base.
 * - **País** `es`.
 *
 * Los alias son fijos (`t` título, `a` oferta, `o` opción, `n` anuncio, `e`
 * evento, `p` plataforma): los fragmentos de abajo los dan por supuestos.
 */
import { type SQL, sql } from "drizzle-orm";
import type { TipoDeObra } from "@/features/catalogo/modelo.ts";
import { IDS_DE_PLATAFORMAS_PUBLICAS } from "@/features/catalogo/plataformas.ts";
import { CAMPOS_PRESENTABLES, tipoDeTitleType } from "./mapeo.ts";

export const PAIS = "es";

/**
 * Orden alfabético en español. La base es `C.UTF-8`: sin colación explícita,
 * «Ámbar» iría detrás de «Zeta». ICU viene de serie en Neon; la validación
 * (`pnpm db:validate:catalogo`) comprueba que exista antes de consultar.
 */
export const COLACION = "es-x-icu";
const POR_TITULO = sql.raw(`t.title COLLATE "${COLACION}", t.imdb_id`);

/** Tope de seguridad de `slugs()`: el contrato pide todos, la base no puede dar infinitos. */
export const TOPE_DE_SLUGS = 20_000;
/** Palabras de una búsqueda que se comparan: el resto no afina nada. */
export const MAXIMO_DE_PALABRAS = 12;

// ── Fragmentos ─────────────────────────────────────────────────────────────

/** `p` está activa en Neon y la web la publica. */
const PLATAFORMA_PUBLICADA = sql`p.is_active AND p.id IN ${[...IDS_DE_PLATAFORMAS_PUBLICAS]}`;

const TITULO_PUBLICABLE = sql.raw(
  `t.year IS NOT NULL AND t.imdb_id ~ '^tt[0-9]{1,12}$'`,
);

const OPCION_ACTIVA = sql.raw(`o.missing_streak < 2`);

/** `a` tiene hoy alguna opción activa ya disponible. */
const OFERTA_DISPONIBLE = sql`EXISTS (
  SELECT 1 FROM external_availability_options o
   WHERE o.availability_id = a.id AND ${OPCION_ACTIVA}
     AND (o.available_since IS NULL OR o.available_since <= now()))`;

function capacidadEnVerde(columna: string, capacidad: string): SQL {
  return sql`EXISTS (
    SELECT 1 FROM external_platform_capabilities c
     WHERE c.platform_id = ${sql.raw(columna)} AND c.country = ${PAIS}
       AND c.capability = ${capacidad} AND c.status = 'supported_with_data')`;
}

/** `t` está disponible hoy (en una plataforma, si se da). */
function tituloDisponible(plataforma?: string): SQL {
  return sql`EXISTS (
    SELECT 1 FROM external_availability a
      JOIN external_platforms p ON p.id = a.platform_id AND ${PLATAFORMA_PUBLICADA}
     WHERE a.title_id = t.id AND a.country = ${PAIS}
       ${plataforma === undefined ? sql`` : sql`AND a.platform_id = ${plataforma}`}
       AND ${OFERTA_DISPONIBLE})`;
}

/** El último recorrido completo, `succeeded` y sin errores de `upcoming` (ADR 0007). */
const RECORRIDO_DE_REFERENCIA = sql`(
  SELECT r.id FROM ops_sync_runs r
   WHERE r.pipeline = 'upcoming' AND r.status = 'succeeded'
     AND r.finished_at IS NOT NULL AND r.error_count = 0
     AND jsonb_typeof(r.checkpoint) = 'object'
     AND r.checkpoint -> 'pendiente' = 'null'::jsonb
   ORDER BY r.id DESC LIMIT 1)`;

/** Sin referencia, `>= NULL` es `NULL`: ningún anuncio vigente. Como la regla. */
const ANUNCIO_VIGENTE = sql`n.country = ${PAIS}
  AND n.announced_for > now()
  AND n.last_seen_run_id >= ${RECORRIDO_DE_REFERENCIA}
  AND ${capacidadEnVerde("n.platform_id", "upcoming")}`;

/** Menor `expires_at` futura a ≤ 30 días de las opciones activas de `a`. */
const SALIDA_PROXIMA = sql`(
  SELECT min(o.expires_at) FROM external_availability_options o
   WHERE o.availability_id = a.id AND ${OPCION_ACTIVA}
     AND o.expires_at > now() AND o.expires_at <= now() + interval '30 days')`;

/** Precio mínimo en céntimos de euro, solo con `prices` en ✅. Otra moneda no se convierte. */
const CENTIMOS_DESDE = sql`CASE WHEN ${capacidadEnVerde("a.platform_id", "prices")} THEN (
  SELECT (min(o.price_amount) * 100)::int FROM external_availability_options o
   WHERE o.availability_id = a.id AND ${OPCION_ACTIVA} AND o.price_currency = 'EUR'
     AND (o.available_since IS NULL OR o.available_since <= now())) END`;

/**
 * Columnas de la tarjeta de un título `t`: géneros, disponibilidad resumida
 * (una por plataforma y tipo) y la última salida registrada. Subconsultas
 * correlacionadas **sobre una lista acotada de títulos**: nunca sobre el
 * catálogo entero.
 */
const COLUMNAS_DE_TARJETA = sql`
  t.imdb_id, t.type, t.title, t.year, t.season_count,
  (SELECT array_agg(g.name ORDER BY g.name) FROM external_title_genres tg
     JOIN external_genres g ON g.id = tg.genre_id WHERE tg.title_id = t.id) AS generos,
  (SELECT json_agg(json_build_object('plataforma', d.platform_id, 'tipo', d.offer_type,
            'centimos', d.centimos) ORDER BY d.platform_id, d.offer_type)
     FROM (SELECT a.platform_id, a.offer_type, min(${CENTIMOS_DESDE}) AS centimos
             FROM external_availability a
             JOIN external_platforms p ON p.id = a.platform_id AND ${PLATAFORMA_PUBLICADA}
            WHERE a.title_id = t.id AND a.country = ${PAIS} AND ${OFERTA_DISPONIBLE}
            GROUP BY a.platform_id, a.offer_type) d) AS disponibilidad,
  (SELECT max(e.detected_at) FROM external_availability_events e
     JOIN external_availability a ON a.id = e.availability_id
    WHERE a.title_id = t.id AND a.country = ${PAIS} AND e.event_type = 'removed') AS ultima_salida`;

/** Solo el id canónico: nombre y slug públicos los pone `mapeo.ts`. */
const PLATAFORMA = sql.raw(`p.id AS platform_id`);

// ── Referencia ─────────────────────────────────────────────────────────────

export const plataformas = () => sql`
  SELECT ${PLATAFORMA} FROM external_platforms p
   WHERE ${PLATAFORMA_PUBLICADA} LIMIT 50`;

export const capacidades = () => sql`
  SELECT c.platform_id, c.capability, c.status
    FROM external_platform_capabilities c
    JOIN external_platforms p ON p.id = c.platform_id AND ${PLATAFORMA_PUBLICADA}
   WHERE c.country = ${PAIS} LIMIT 500`;

/** La observación más reciente de la disponibilidad: «Comprobado el…». */
export const ultimaComprobacion = () => sql`
  SELECT max(a.last_checked_at) AS comprobado FROM external_availability a
   WHERE a.country = ${PAIS}`;

/** El ancla del seed (ADR 0009) y, si no la hay, el primer evento registrado. */
export const inicioDelRegistro = () => sql`
  SELECT (SELECT r.checkpoint ->> 'ancla' FROM ops_sync_runs r
           WHERE r.pipeline = 'seed' AND r.checkpoint ->> 'fase' = 'carga'
             AND r.checkpoint ->> 'estado' = 'cargada'
           ORDER BY r.id DESC LIMIT 1) AS ancla,
         (SELECT min(e.detected_at) FROM external_availability_events e) AS primer_evento`;

// ── Títulos ────────────────────────────────────────────────────────────────

/** Tarjetas de una lista de `imdb_id`. `ids` no vacío: lo garantiza quien llama. */
export const tarjetas = (ids: readonly string[]) => sql`
  SELECT ${COLUMNAS_DE_TARJETA} FROM external_titles t
   WHERE t.imdb_id IN ${[...ids]} AND ${TITULO_PUBLICABLE}
   LIMIT ${ids.length}`;

export const fichaBase = (tipo: TipoDeObra, imdbId: string) => sql`
  SELECT ${COLUMNAS_DE_TARJETA},
         t.original_title, t.overview, t.rating, t.runtime_minutes, t.episode_count,
         t.directors, t.cast_members,
         (SELECT max(a.last_checked_at) FROM external_availability a
           WHERE a.title_id = t.id AND a.country = ${PAIS}) AS comprobado_en
    FROM external_titles t
   WHERE t.imdb_id = ${imdbId} AND t.type = ${tipoDeTitleType(tipo)} AND ${TITULO_PUBLICABLE}
   LIMIT 1`;

/**
 * Las ofertas disponibles de un título, **una por oferta lógica**, con los
 * agregados de sus opciones activas (docs/DATA-MODEL.md): precio mínimo,
 * calidad máxima, idiomas en unión, salida próxima y el enlace de la opción
 * preferida (`last_seen_at DESC`, con `video_link`, `link ASC`).
 */
export const ofertasDeFicha = (tipo: TipoDeObra, imdbId: string) => sql`
  SELECT ${PLATAFORMA}, a.offer_type, a.addon,
         (SELECT o.link FROM external_availability_options o
           WHERE o.availability_id = a.id AND ${OPCION_ACTIVA}
           ORDER BY o.last_seen_at DESC, (o.video_link IS NOT NULL) DESC, o.link ASC
           LIMIT 1) AS enlace,
         ${CENTIMOS_DESDE} AS centimos,
         -- Calidad máxima, salvo que haya precio y varias calidades: «desde
         -- 5,99 €» junto a «4K» mezclaría dos variantes (📏 Prime: sd 5,99 ·
         -- hd 6,99 · uhd 9,99 por un mismo enlace). Entonces no se afirma.
         (SELECT CASE WHEN count(DISTINCT o.quality) > 1 AND count(o.price_amount) > 0
                      THEN NULL
                      ELSE max(CASE o.quality WHEN 'uhd' THEN 3 WHEN 'hd' THEN 2 WHEN 'sd' THEN 1 END)
                 END
            FROM external_availability_options o
           WHERE o.availability_id = a.id AND ${OPCION_ACTIVA}) AS calidad,
         (SELECT array_agg(DISTINCT l ORDER BY l) FROM external_availability_options o,
                 unnest(o.audio_languages) l
           WHERE o.availability_id = a.id AND ${OPCION_ACTIVA}) AS audio,
         (SELECT array_agg(DISTINCT l ORDER BY l) FROM external_availability_options o,
                 unnest(o.subtitle_languages) l
           WHERE o.availability_id = a.id AND ${OPCION_ACTIVA}) AS subtitulos,
         CASE WHEN ${capacidadEnVerde("a.platform_id", "expiring")}
              THEN ${SALIDA_PROXIMA} END AS salida
    FROM external_titles t
    JOIN external_availability a ON a.title_id = t.id AND a.country = ${PAIS}
    JOIN external_platforms p ON p.id = a.platform_id AND ${PLATAFORMA_PUBLICADA}
   WHERE t.imdb_id = ${imdbId} AND t.type = ${tipoDeTitleType(tipo)} AND ${OFERTA_DISPONIBLE}
   ORDER BY p.id, a.offer_type, a.addon NULLS FIRST
   LIMIT 100`;

export const anunciosDeFicha = (tipo: TipoDeObra, imdbId: string) => sql`
  SELECT ${PLATAFORMA}, n.offer_type, n.announced_for
    FROM external_titles t
    JOIN external_availability_announcements n ON n.title_id = t.id
    JOIN external_platforms p ON p.id = n.platform_id AND ${PLATAFORMA_PUBLICADA}
   WHERE t.imdb_id = ${imdbId} AND t.type = ${tipoDeTitleType(tipo)} AND ${ANUNCIO_VIGENTE}
   ORDER BY n.announced_for, p.id
   LIMIT 20`;

/** Todos los títulos publicables de un tipo, para `generateStaticParams` y el sitemap. */
export const slugs = (tipo: TipoDeObra) => sql`
  SELECT t.imdb_id, t.title FROM external_titles t
   WHERE t.type = ${tipoDeTitleType(tipo)} AND ${TITULO_PUBLICABLE}
   ORDER BY t.imdb_id LIMIT ${TOPE_DE_SLUGS}`;

export const delMismoDirector = (imdbId: string, limite: number) => sql`
  SELECT t.imdb_id, t.title
    FROM external_titles propio
    JOIN external_titles t ON t.id <> propio.id
   WHERE propio.imdb_id = ${imdbId} AND ${TITULO_PUBLICABLE}
     AND EXISTS (SELECT 1 FROM unnest(t.directors) d
                  WHERE d <> '' AND d = ANY (propio.directors))
   ORDER BY ${POR_TITULO}
   LIMIT ${limite}`;

// ── Catálogo disponible ────────────────────────────────────────────────────

export interface FiltroSql {
  tipo?: TipoDeObra;
  plataforma?: string;
  genero?: string;
}

function filtroDeCatalogo(filtro: FiltroSql): SQL {
  const partes: SQL[] = [TITULO_PUBLICABLE, tituloDisponible(filtro.plataforma)];
  if (filtro.tipo !== undefined)
    partes.push(sql`t.type = ${tipoDeTitleType(filtro.tipo)}`);
  if (filtro.genero !== undefined) {
    partes.push(sql`EXISTS (SELECT 1 FROM external_title_genres tg
      JOIN external_genres g ON g.id = tg.genre_id
     WHERE tg.title_id = t.id AND g.name = ${filtro.genero})`);
  }
  return sql.join(partes, sql` AND `);
}

/** Una página en orden alfabético con el total de coincidencias. */
export const explorar = (filtro: FiltroSql, limite: number) => sql`
  SELECT t.imdb_id, t.title, count(*) OVER () AS total
    FROM external_titles t
   WHERE ${filtroDeCatalogo(filtro)}
   ORDER BY ${POR_TITULO}
   LIMIT ${limite}`;

export const contarDisponibles = (filtro: FiltroSql) => sql`
  SELECT count(*) AS total FROM external_titles t WHERE ${filtroDeCatalogo(filtro)}`;

export const generos = (filtro: Omit<FiltroSql, "genero">) => sql`
  SELECT g.name, count(DISTINCT t.id) AS recuento
    FROM external_titles t
    JOIN external_title_genres tg ON tg.title_id = t.id
    JOIN external_genres g ON g.id = tg.genre_id
   WHERE ${filtroDeCatalogo(filtro)}
   GROUP BY g.name
   ORDER BY recuento DESC, g.name
   LIMIT 200`;

export const recuentoPorPlataforma = () => sql`
  SELECT a.platform_id, t.type, count(DISTINCT t.id) AS recuento
    FROM external_availability a
    JOIN external_platforms p ON p.id = a.platform_id AND ${PLATAFORMA_PUBLICADA}
    JOIN external_titles t ON t.id = a.title_id
   WHERE a.country = ${PAIS} AND ${TITULO_PUBLICABLE} AND ${OFERTA_DISPONIBLE}
   GROUP BY a.platform_id, t.type
   LIMIT 100`;

/**
 * Candidatas del Ranking A (docs/RANKINGS.md): con valoración, disponibles hoy
 * y con ficha mínima —`imdb_id`, año y **un póster conocido** que no sea el
 * placeholder del proveedor—. «Conocido» no es «publicable» (ADR 0008): aquí
 * solo se usa como criterio de ficha mínima, nunca se muestra.
 *
 * Devuelve las `limite` mejores **más todos los empates en la frontera**: el
 * desempate neutral (`compararTitulos`, es-ES + `imdb_id`) se aplica en
 * JavaScript, con la misma función que el adaptador de desarrollo.
 */
export const candidatasMejorValoradas = (
  tipo: TipoDeObra,
  limite: number,
  plataforma?: string,
) => sql`
  WITH candidatas AS (
    SELECT t.imdb_id, t.title, t.rating FROM external_titles t
     WHERE t.type = ${tipoDeTitleType(tipo)} AND ${TITULO_PUBLICABLE}
       AND t.rating IS NOT NULL
       AND EXISTS (SELECT 1 FROM external_title_images i
                    WHERE i.title_id = t.id AND i.type = 'vertical_poster'
                      AND NOT i.is_placeholder)
       AND ${tituloDisponible(plataforma)})
  SELECT imdb_id, title, rating FROM candidatas
   WHERE rating >= COALESCE((SELECT rating FROM candidatas
                              ORDER BY rating DESC LIMIT 1 OFFSET ${limite - 1}), 0)
   -- El mismo orden que el desempate: si el tope corta un empate enorme, corta
   -- por el final del alfabeto, no por el imdb.
   ORDER BY rating DESC, title COLLATE "${sql.raw(COLACION)}", imdb_id
   LIMIT ${limite * 20}`;

// ── Movimientos ────────────────────────────────────────────────────────────

export interface VentanaSql {
  plataforma?: string;
  obra?: TipoDeObra;
  desde?: string;
  hasta?: string;
}

function filtroDeMovimiento(columnaPlataforma: string, v: VentanaSql): SQL {
  const partes: SQL[] = [TITULO_PUBLICABLE];
  if (v.plataforma !== undefined)
    partes.push(sql`${sql.raw(columnaPlataforma)} = ${v.plataforma}`);
  if (v.obra !== undefined) partes.push(sql`t.type = ${tipoDeTitleType(v.obra)}`);
  return sql.join(partes, sql` AND `);
}

function ventana(columna: SQL, v: VentanaSql): SQL {
  const partes: SQL[] = [];
  if (v.desde !== undefined) partes.push(sql`${columna} >= ${v.desde}::timestamptz`);
  if (v.hasta !== undefined) partes.push(sql`${columna} <= ${v.hasta}::timestamptz`);
  return partes.length === 0 ? sql`TRUE` : sql.join(partes, sql` AND `);
}

const CAMPOS = Object.keys(CAMPOS_PRESENTABLES);

/**
 * «Llega», «se fue» y «cambio» salen del **histórico inmutable**
 * (`external_availability_events`: `added`, `removed`, `changed`), nunca del
 * estado actual. Uno por título y plataforma: las ofertas de alquiler y compra
 * de un mismo estreno son **un** movimiento, con la fecha más reciente.
 *
 * - `se-fue` exige además que **hoy** no quede ninguna oferta disponible de
 *   ese título en esa plataforma: si se retiró el alquiler pero sigue la
 *   compra, el título no «se fue».
 * - `cambio` solo con campos presentables (`CAMPOS_PRESENTABLES`).
 */
export const movimientosDelHistorico = (
  evento: "added" | "removed" | "changed",
  limite: number,
  v: VentanaSql,
) => sql`
  SELECT t.imdb_id, ${PLATAFORMA}, max(e.detected_at) AS fecha
         ${evento === "changed" ? sql`, array_agg(DISTINCT f.campo) FILTER (WHERE f.campo IN ${CAMPOS}) AS campos` : sql``}
    FROM external_availability_events e
    JOIN external_availability a ON a.id = e.availability_id AND a.country = ${PAIS}
    JOIN external_platforms p ON p.id = a.platform_id AND ${PLATAFORMA_PUBLICADA}
    JOIN external_titles t ON t.id = a.title_id
    ${evento === "changed" ? sql`CROSS JOIN LATERAL unnest(e.changed_fields) AS f(campo)` : sql``}
   WHERE e.event_type = ${evento}
     AND ${filtroDeMovimiento("a.platform_id", v)}
     AND ${ventana(sql`e.detected_at`, v)}
     ${evento === "changed" ? sql`AND f.campo IN ${CAMPOS}` : sql``}
     ${
       evento === "removed"
         ? sql`AND NOT EXISTS (SELECT 1 FROM external_availability a2
                 WHERE a2.title_id = a.title_id AND a2.platform_id = a.platform_id
                   AND a2.country = ${PAIS}
                   AND EXISTS (SELECT 1 FROM external_availability_options o
                                WHERE o.availability_id = a2.id AND ${OPCION_ACTIVA}
                                  AND (o.available_since IS NULL OR o.available_since <= now())))`
         : sql``
     }
   GROUP BY t.imdb_id, p.id
   ORDER BY fecha DESC, t.imdb_id, p.id
   LIMIT ${limite}`;

/** «Se va»: la salida próxima por título y plataforma, con `expiring` en ✅. */
export const movimientosSeVa = (limite: number, v: VentanaSql) => sql`
  SELECT imdb_id, platform_id, min(salida) AS fecha
    FROM (SELECT t.imdb_id, ${PLATAFORMA}, ${SALIDA_PROXIMA} AS salida
            FROM external_availability a
            JOIN external_platforms p ON p.id = a.platform_id AND ${PLATAFORMA_PUBLICADA}
            JOIN external_titles t ON t.id = a.title_id
           WHERE a.country = ${PAIS} AND ${filtroDeMovimiento("a.platform_id", v)}
             AND ${capacidadEnVerde("a.platform_id", "expiring")}
             AND ${OFERTA_DISPONIBLE}) s
   WHERE salida IS NOT NULL AND ${ventana(sql`salida`, v)}
   GROUP BY imdb_id, platform_id
   ORDER BY fecha ASC, imdb_id, platform_id
   LIMIT ${limite}`;

/** «Próximamente»: anuncios vigentes (ADR 0007), por título y plataforma. */
export const movimientosProximamente = (limite: number, v: VentanaSql) => sql`
  SELECT t.imdb_id, ${PLATAFORMA}, min(n.announced_for) AS fecha
    FROM external_availability_announcements n
    JOIN external_platforms p ON p.id = n.platform_id AND ${PLATAFORMA_PUBLICADA}
    JOIN external_titles t ON t.id = n.title_id
   WHERE ${ANUNCIO_VIGENTE} AND ${filtroDeMovimiento("n.platform_id", v)}
     AND ${ventana(sql`n.announced_for`, v)}
   GROUP BY t.imdb_id, p.id
   ORDER BY fecha ASC, t.imdb_id, p.id
   LIMIT ${limite}`;

/**
 * Los movimientos pasados de **un** título, para su ficha: por plataforma, tipo
 * y día (el *bucket* de deduplicación de los eventos).
 */
export const historicoDeTitulo = (tipo: TipoDeObra, imdbId: string) => sql`
  SELECT t.imdb_id, ${PLATAFORMA}, e.event_type, max(e.detected_at) AS fecha,
         array_agg(DISTINCT f.campo) FILTER (WHERE f.campo IN ${CAMPOS}) AS campos
    FROM external_titles t
    JOIN external_availability a ON a.title_id = t.id AND a.country = ${PAIS}
    JOIN external_platforms p ON p.id = a.platform_id AND ${PLATAFORMA_PUBLICADA}
    JOIN external_availability_events e ON e.availability_id = a.id
    LEFT JOIN LATERAL unnest(e.changed_fields) AS f(campo) ON TRUE
   WHERE t.imdb_id = ${imdbId} AND t.type = ${tipoDeTitleType(tipo)}
     AND e.event_type IN ('added', 'removed', 'changed')
   GROUP BY t.imdb_id, p.id, e.event_type, e.dedupe_bucket_at
  HAVING e.event_type <> 'changed'
      OR bool_or(f.campo IN ${CAMPOS})
   ORDER BY fecha DESC
   LIMIT 60`;

// ── Búsqueda ───────────────────────────────────────────────────────────────

/**
 * Normalización de `docs`/`busqueda.ts` en SQL, **sin extensiones**: la base
 * no tiene `unaccent` y crearla sería tocar el esquema. `translate` quita las
 * tildes y diacríticos del español y de las lenguas latinas más comunes;
 * `lower` sobre lo que queda es ASCII y no depende de la colación.
 */
const CON_TILDE = "ÁÀÂÄÃÅÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÑÇÝáàâäãåéèêëíìîïóòôöõúùûüñçýÿ";
const SIN_TILDE = "AAAAAAEEEEIIIIOOOOOUUUUNCYaaaaaaeeeeiiiiooooouuuuncyy";

function normalizado(columna: string): SQL {
  return sql`btrim(regexp_replace(lower(translate(coalesce(${sql.raw(columna)}, ''), ${CON_TILDE}, ${SIN_TILDE})), '\\s+', ' ', 'g'))`;
}

/** `%`, `_` y `\` son comodines de `LIKE`: se escapan. */
export function escaparLike(texto: string): string {
  return texto.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function contieneTodas(columna: string, palabras: readonly string[]): SQL {
  return sql.join(
    palabras.map(
      (p) => sql`${sql.raw(columna)} LIKE ${`%${escaparLike(p)}%`} ESCAPE '\\'`,
    ),
    sql` AND `,
  );
}

/** 0 exacto · 1 empieza por la consulta · 2 una palabra empieza por la primera · 3 el resto. */
function puntos(columna: string, consulta: string, primera: string): SQL {
  const c = sql.raw(columna);
  return sql`CASE WHEN ${c} = ${consulta} THEN 0
    WHEN ${c} LIKE ${`${escaparLike(consulta)}%`} ESCAPE '\\' THEN 1
    WHEN (' ' || ${c}) LIKE ${`% ${escaparLike(primera)}%`} ESCAPE '\\' THEN 2
    ELSE 3 END`;
}

/**
 * Búsqueda por título español u original, todas las palabras, sin mayúsculas
 * ni tildes. `consulta` y `palabras` llegan ya normalizadas por `busqueda.ts`.
 * Recorre `external_titles` completo (unos miles de filas): sin índice de
 * trigramas, que exigiría `pg_trgm` y una migración (`docs/NEON-ADAPTER.md` §14).
 */
export const buscar = (
  consulta: string,
  palabras: readonly string[],
  limite: number,
) => {
  const [primera = consulta] = palabras;
  return sql`
  WITH base AS (
    SELECT t.imdb_id, t.title, t.original_title,
           ${normalizado("t.title")} AS nt, ${normalizado("t.original_title")} AS nor
      FROM external_titles t WHERE ${TITULO_PUBLICABLE}),
  coinciden AS (
    SELECT imdb_id, title, original_title,
           (${contieneTodas("nt", palabras)}) AS en_titulo,
           (original_title IS NOT NULL AND ${contieneTodas("nor", palabras)}) AS en_original,
           nt, nor
      FROM base)
  SELECT imdb_id, title, original_title, en_titulo,
         CASE WHEN en_titulo THEN ${puntos("nt", consulta, primera)}
              ELSE ${puntos("nor", consulta, primera)} END AS puntos,
         count(*) OVER () AS total
    FROM coinciden
   WHERE en_titulo OR en_original
   ORDER BY puntos, title COLLATE "${sql.raw(COLACION)}", imdb_id
   LIMIT ${limite}`;
};
