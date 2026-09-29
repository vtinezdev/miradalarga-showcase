/**
 * Plano `external_*` — plataformas y disponibilidad.
 *
 * La pieza central es la separación **oferta lógica / opciones**, que salió de
 * medir el corpus B: 2.239 opciones crudas se agrupan en **1.857 ofertas
 * lógicas**, y **340 (18,3 %)** tienen más de una opción, con un máximo de 9.
 *
 * `external_platforms` y `external_platform_capabilities` son **referencia
 * curada**: llevan decisiones nuestras que ninguna ingesta repone.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

import { externalTitles } from "./catalogo.ts";
import {
  capability,
  capabilityStatus,
  eventType,
  offerType,
  quality,
} from "./enums.ts";
import { opsSyncRuns } from "./operacion.ts";

/**
 * Referencia **curada a mano**, no ingerida.
 *
 * 📏 **Max es `hbo` en la fuente.** Separar nuestro `id` de `source_id`
 * convierte la trampa más cara del Spike 1 en una columna, y permite cambiar de
 * proveedor sin tocar URLs ni contenido editorial.
 */
export const externalPlatforms = pgTable(
  "external_platforms",
  {
    /** Identificador **propio**: `netflix`, `max`… */
    id: text("id").primaryKey(),
    name: text("name").notNull(),

    /** Identificador **del proveedor**: para Max, `hbo`. */
    source: text("source").notNull(),
    sourceId: text("source_id").notNull(),

    /** Slug de las URLs públicas. Decisión nuestra, no del proveedor. */
    publicSlug: text("public_slug").notNull(),
    isActive: boolean("is_active").notNull(),
  },
  (t) => [
    unique("external_platforms_public_slug_key").on(t.publicSlug),
    unique("external_platforms_source_key").on(t.source, t.sourceId),
  ],
);

/**
 * Qué puede publicarse de cada plataforma, **por país**.
 *
 * Tabla y no JSONB justamente porque la matriz es por país. Y los **cuatro**
 * estados en vez de un booleano, que colapsaría ⚪ y ❌ en el mismo valor.
 *
 * La interfaz solo muestra lo que aquí esté en `supported_with_data`.
 */
export const externalPlatformCapabilities = pgTable(
  "external_platform_capabilities",
  {
    platformId: text("platform_id")
      .notNull()
      .references(() => externalPlatforms.id, { onDelete: "restrict" }),
    /** ISO 3166-1 alfa-2 en minúsculas. Multi-país desde el diseño (invariante 6). */
    country: text("country").notNull(),
    capability: capability("capability").notNull(),
    status: capabilityStatus("status").notNull(),
  },
  (t) => [
    primaryKey({
      name: "external_platform_capabilities_pkey",
      columns: [t.platformId, t.country, t.capability],
    }),
  ],
);

/**
 * **Identidad estable de una oferta lógica, y nada más.**
 *
 * No contiene `status`, `quality`, `price_*`, idiomas, `available_since`,
 * `expires_at`, `link_count`, `missing_streak` ni `fingerprint`: o pertenecen a
 * las opciones, o son derivables de ellas (invariante 1).
 *
 * 📏 **El estado no se almacena, se deriva.** 0 de 25 ofertas anunciadas como
 * `upcoming` aparecían ya en el catálogo, y 0 de 2.239 ofertas actuales tenían
 * un `available_since` genuinamente futuro.
 *
 * Con `quality` fuera de la identidad, **un anuncio que se estrena no cambia de
 * fila padre**: la transición de anuncio a estreno no produce un falso par baja
 * + alta. Todo el movimiento ocurre entre hijos.
 */
export const externalAvailability = pgTable(
  "external_availability",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),

    titleId: bigint("title_id", { mode: "number" })
      .notNull()
      // RESTRICT: de esta fila cuelga histórico irrecuperable.
      .references(() => externalTitles.id, { onDelete: "restrict" }),
    platformId: text("platform_id")
      .notNull()
      .references(() => externalPlatforms.id, { onDelete: "restrict" }),
    country: text("country").notNull(),
    offerType: offerType("offer_type").notNull(),
    /** Nombre del canal adicional cuando la oferta es `addon`; `null` si no. */
    addon: text("addon"),

    /**
     * **Comprobar no es ver.** No es derivable de las opciones, y es lo que
     * alimenta el «Comprobado el {fecha}» que exige `docs/SEO.md`.
     */
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    /** Esta tabla no tiene trigger, así que el `UPDATE` implícito es legal. */
    syncRunId: bigint("sync_run_id", { mode: "number" }).references(
      () => opsSyncRuns.id,
      { onDelete: "set null" },
    ),
  },
  (t) => [
    unique("external_availability_key")
      .on(t.titleId, t.platformId, t.country, t.offerType, t.addon)
      .nullsNotDistinct(),
    index("external_availability_platform_country_idx").on(t.platformId, t.country),
  ],
);

/**
 * La **variante concreta observada** de una oferta lógica.
 *
 * 📏 `link` y `quality` son **dimensiones independientes y ninguna basta
 * sola**: 244 grupos comparten deeplink con calidades distintas —Prime vende sd
 * 5,99 €, hd 6,99 € y uhd 9,99 € por un único enlace— y 103 grupos tienen
 * enlaces distintos. El par `(link, quality)` **no colisiona ni una vez** en las
 * 2.239 opciones.
 *
 * 📏 **No toda opción es una variante comercial.** SkyShowtime devolvió el mismo
 * UUID bajo cuatro slugs: es rotación de URL. Por eso las altas y bajas se
 * emiten en el padre y nunca por opción.
 */
export const externalAvailabilityOptions = pgTable(
  "external_availability_options",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    availabilityId: bigint("availability_id", { mode: "number" })
      .notNull()
      .references(() => externalAvailability.id, { onDelete: "cascade" }),

    link: text("link").notNull(),
    videoLink: text("video_link"),
    /** 📏 Llega en el 74 % de las ofertas. `null` es «no consta». */
    quality: quality("quality"),

    /** Importe exacto. 📏 Solo la mitad de las ofertas transaccionales lo traen. */
    priceAmount: numeric("price_amount", { precision: 12, scale: 2 }),
    priceCurrency: text("price_currency"),

    /**
     * 📏 **Un array vacío significa «no consta», nunca «no tiene».** La clave
     * llega siempre; llega vacía en el 28,7 % (audio) y el 30,1 % (subtítulos).
     */
    audioLanguages: text("audio_languages").array().notNull(),
    subtitleLanguages: text("subtitle_languages").array().notNull(),

    availableSince: timestamp("available_since", { withTimezone: true }),
    /** **`null` no significa «para siempre»**: significa que no consta. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),

    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    /**
     * Comprobaciones consecutivas sin ver la opción. Una opción está activa si
     * `missing_streak < 2`.
     *
     * ⚠️ Regla de Fase 2: una opción futura **no acumula ausencia** por no
     * aparecer todavía en el catálogo. Solo cuenta a partir de su
     * `available_since`, o todo anuncio moriría antes de estrenarse.
     */
    missingStreak: integer("missing_streak").notNull().default(0),
  },
  (t) => [
    unique("external_availability_options_key")
      .on(t.availabilityId, t.link, t.quality)
      .nullsNotDistinct(),
    check(
      "external_availability_options_missing_streak_no_negativo",
      sql`${t.missingStreak} >= 0`,
    ),
    // El precio canónico del contrato, convertido en esquema: o van los dos, o
    // no va ninguno.
    check(
      "external_availability_options_precio_completo",
      sql`(${t.priceAmount} IS NULL) = (${t.priceCurrency} IS NULL)`,
    ),
  ],
);

/**
 * Histórico **inmutable** y *append-only* de la disponibilidad.
 *
 * ❌ **IRRECUPERABLE.** La fuente no lo devuelve: registra lo que observamos un
 * día concreto, y ese día no vuelve. Borrarlo destruye el diferencial de
 * producto —«en Netflix desde…», «abandona Max el…»—.
 *
 * **Idempotencia garantizada por la base de datos:** el único de cuatro
 * columnas más `ON CONFLICT DO NOTHING`. Reejecutar un pipeline dentro del
 * mismo *bucket* —reintentos, backfills, un job que corre dos veces— no escribe
 * nada. No depende del cuidado de quien escribe el pipeline.
 */
export const externalAvailabilityEvents = pgTable(
  "external_availability_events",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    availabilityId: bigint("availability_id", { mode: "number" })
      .notNull()
      // RESTRICT: no se borra una oferta que tiene histórico.
      .references(() => externalAvailability.id, { onDelete: "restrict" }),

    eventType: eventType("event_type").notNull(),
    /**
     * Qué cambió: `price`, `quality`, `audio_languages`, `expires_at`… y
     * **`options`** para la entrada o salida de una variante.
     */
    changedFields: text("changed_fields").array(),
    before: jsonb("before"),
    after: jsonb("after"),

    /** Hash determinista sobre `(changed_fields, before, after)`. */
    eventDigest: text("event_digest").notNull(),
    /**
     * *Bucket* de deduplicación. Con cadencia diaria es el inicio del día; si
     * algún día se pasa a cadencia horaria será el inicio de la hora, **sin
     * migrar el esquema**.
     *
     * ⚠️ Limitación consciente: dos cambios idénticos dentro del mismo *bucket*
     * se colapsan en uno. Se prefiere idempotencia garantizada por la base de
     * datos a capturar oscilaciones que hoy nadie consume.
     */
    dedupeBucketAt: timestamp("dedupe_bucket_at", { withTimezone: true }).notNull(),
    /** El instante real de la detección, sin redondear. */
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),

    /**
     * RESTRICT, no SET NULL: `SET NULL` ejecutaría un `UPDATE` sobre esta fila y
     * el trigger de inmutabilidad abortaría el borrado de la ejecución.
     */
    syncRunId: bigint("sync_run_id", { mode: "number" }).references(
      () => opsSyncRuns.id,
      { onDelete: "restrict" },
    ),
  },
  (t) => [
    unique("external_availability_events_key").on(
      t.availabilityId,
      t.eventType,
      t.eventDigest,
      t.dedupeBucketAt,
    ),
    index("external_availability_events_availability_bucket_idx").on(
      t.availabilityId,
      t.dedupeBucketAt,
    ),
  ],
);

/**
 * **Los anuncios de disponibilidad futura** que publica `/changes?change_type=upcoming`:
 * la fuente de verdad de «Próximamente» (ADR 0007).
 *
 * **No es disponibilidad.** `external_availability_options` guarda lo que se
 * **observa** en el catálogo; un anuncio es una promesa del proveedor sobre una
 * fecha futura. Mezclarlos obligaba a sintetizar opciones que nadie había
 * observado y, 📏 con **Prime sin `link`** (4 de 4 en `raw/032`, 3 de 3 en la
 * fila 50), ni siquiera eso era posible: `link` es `NOT NULL` en las opciones.
 *
 * **Una fila por oferta anunciada**, con la misma identidad que
 * `external_availability`. 📏 0 de 54 ofertas de la fila 50 traen dos fechas
 * futuras, y 24 de 24 anuncios observados el 21-sep y el 24-sep repiten fecha y
 * link: la fecha y el link son **atributos**, no identidad. Un aplazamiento
 * actualiza la misma fila.
 *
 * **Sin `status`, sin `cancelled` y sin `missing_streak`.** Que un anuncio deje
 * de listarse no dice si se canceló, se aplazó fuera del horizonte o cambió de
 * forma: por ahora solo se **cuenta** (`jobs/pipelines/upcoming/horizonte.ts`).
 */
export const externalAvailabilityAnnouncements = pgTable(
  "external_availability_announcements",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),

    titleId: bigint("title_id", { mode: "number" })
      .notNull()
      // RESTRICT: `first_seen_at` y `first_announced_for` son observaciones
      // que la fuente no devuelve. Como `external_availability.title_id`.
      .references(() => externalTitles.id, { onDelete: "restrict" }),
    platformId: text("platform_id")
      .notNull()
      .references(() => externalPlatforms.id, { onDelete: "restrict" }),
    country: text("country").notNull(),
    offerType: offerType("offer_type").notNull(),
    /** Nombre del canal adicional cuando la oferta es `addon`; `null` si no. */
    addon: text("addon"),

    /** La fecha anunciada **en la última observación**. Un aplazamiento la mueve. */
    announcedFor: timestamp("announced_for", { withTimezone: true }).notNull(),
    /** La fecha con la que se anunció **al empezar el ciclo**. No se mueve. */
    firstAnnouncedFor: timestamp("first_announced_for", {
      withTimezone: true,
    }).notNull(),
    /**
     * El deeplink anunciado en la última observación. **`null` es «no consta»**:
     * 📏 Prime anuncia sin él. Nunca se inventa.
     */
    link: text("link"),

    /** Primera observación **del ciclo en curso**. */
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    /**
     * Última observación aplicada. Distingue una observación nueva de la misma
     * otra vez y de una más vieja, igual que `external_availability.last_checked_at`.
     */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    /**
     * La ejecución de esa observación. SET NULL: esta tabla no tiene trigger de
     * inmutabilidad, como `external_availability.sync_run_id`. `null` también en
     * el ensayo y la reproducción, cuya ejecución vive en memoria.
     */
    lastSeenRunId: bigint("last_seen_run_id", { mode: "number" }).references(
      () => opsSyncRuns.id,
      { onDelete: "set null" },
    ),
  },
  (t) => [
    unique("external_availability_announcements_key")
      .on(t.titleId, t.platformId, t.country, t.offerType, t.addon)
      .nullsNotDistinct(),
    check(
      "external_availability_announcements_vistas_ordenadas",
      sql`${t.lastSeenAt} >= ${t.firstSeenAt}`,
    ),
    // «Próximamente» en un país, por fecha.
    index("external_availability_announcements_country_announced_for_idx").on(
      t.country,
      t.announcedFor,
    ),
  ],
);
