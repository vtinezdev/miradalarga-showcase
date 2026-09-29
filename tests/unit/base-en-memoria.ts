/**
 * Una base de datos **con estado** para probar `deltas` en secuencia: varias
 * observaciones, reproducciones y fallos parciales sobre las mismas filas.
 *
 * Modela solo lo que el pipeline toca —títulos, ofertas, opciones, eventos y
 * anuncios (ADR 0007)— y
 * **obedece al SQL que recibe**. Un `DO UPDATE SET "c" = EXCLUDED."c"`
 * sobrescribe; un `SET "c" = GREATEST(tabla."c", EXCLUDED."c")` solo avanza. Si
 * alguien quitara el `GREATEST` del upsert, estos tests lo verían.
 *
 * `BEGIN` / `COMMIT` / `ROLLBACK` son de verdad: `ROLLBACK` devuelve el estado
 * exacto del `BEGIN`.
 *
 * ⚠️ No sustituye a PostgreSQL: triggers, constraints y tipos los prueba el
 * ensayo contra Neon. Esto prueba la **lógica** de las secuencias.
 */
import type { EjecutorSql } from "../../jobs/ops/contratos.ts";

interface Oferta {
  id: number;
  titleId: number;
  platformId: string;
  country: string;
  offerType: string;
  addon: string | null;
  lastCheckedAt: Date | null;
}

export interface Opcion {
  id: number;
  availabilityId: number;
  link: string;
  videoLink: string | null;
  quality: string | null;
  priceAmount: string | null;
  priceCurrency: string | null;
  audioLanguages: string[];
  subtitleLanguages: string[];
  availableSince: Date | null;
  expiresAt: Date | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  missingStreak: number;
}

/** Una fila de `external_availability_announcements`. */
export interface Anuncio {
  id: number;
  titleId: number;
  platformId: string;
  country: string;
  offerType: string;
  addon: string | null;
  announcedFor: Date;
  firstAnnouncedFor: Date;
  link: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastSeenRunId: number | null;
}

/** Un anuncio sin id ni `title_id`, con la clave del título a la vista. */
export interface AnuncioVisible {
  readonly imdbId: string;
  readonly platformId: string;
  readonly offerType: string;
  readonly addon: string | null;
  readonly announcedFor: string;
  readonly firstAnnouncedFor: string;
  readonly link: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly lastSeenRunId: number | null;
}

interface Evento {
  id: number;
  availabilityId: number;
  eventType: string;
  digest: string;
  bucket: string;
}

interface Estado {
  siguienteId: number;
  titulos: Record<string, number>;
  ofertas: Oferta[];
  opciones: Opcion[];
  eventos: Evento[];
  anuncios: Anuncio[];
}

const CABECERA = /^INSERT INTO (\w+)\s*\(([^)]*)\)/;

function comoFecha(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  return typeof v === "string" || typeof v === "number" ? new Date(v) : null;
}

function mayor(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/** Qué hace el `DO UPDATE` con cada columna: sobrescribir o solo avanzar. */
function politicas(
  texto: string,
  tabla: string,
): Map<string, "sobrescribir" | "avanzar"> {
  const salida = new Map<string, "sobrescribir" | "avanzar">();
  const set = /DO UPDATE SET (.*)\n/.exec(texto)?.[1] ?? "";
  for (const m of set.matchAll(
    /"(\w+)" = (GREATEST\((\w+)\."\w+", EXCLUDED\."\w+"\)|EXCLUDED\."\w+")/g,
  )) {
    const columna = m[1] ?? "";
    const esGreatest = m[2]?.startsWith("GREATEST") === true && m[3] === tabla;
    salida.set(columna, esGreatest ? "avanzar" : "sobrescribir");
  }
  return salida;
}

export interface BaseEnMemoria {
  readonly ejecutor: EjecutorSql;
  readonly sentencias: readonly string[];
  opcion(link: string): Opcion | undefined;
  ultimaComprobacion(platformId: string): Date | null;
  eventos(): readonly Evento[];
  /** Los anuncios, ordenados por `imdb|plataforma|tipo|addon`. */
  anuncios(): readonly AnuncioVisible[];
  /** Hace que la PRÓXIMA sentencia que cumpla el predicado lance. Una vez. */
  fallarUnaVezEn(predicado: (texto: string) => boolean): void;
  /**
   * El estado entero, **sin ids** —que dependen del orden de inserción— y
   * ordenado, para comparar dos bases. Con `instantes: false` omite los
   * instantes de observación (`last_checked_at`, `first_seen_at`,
   * `last_seen_at`), que legítimamente difieren si dos ejecuciones observan en
   * momentos distintos.
   */
  foto(opciones?: { readonly instantes?: boolean }): unknown;
}

export function crearBaseEnMemoria(): BaseEnMemoria {
  let e: Estado = {
    siguienteId: 1,
    titulos: {},
    ofertas: [],
    opciones: [],
    eventos: [],
    anuncios: [],
  };
  let copia: Estado | null = null;
  const sentencias: string[] = [];
  let fallo: ((t: string) => boolean) | null = null;

  const ejecutar = <T>(
    texto: string,
    valores: readonly unknown[] = [],
  ): Promise<readonly T[]> => {
    const t = texto.trim();
    sentencias.push(t);
    const r = (filas: unknown[]) => Promise.resolve(filas as readonly T[]);

    if (fallo?.(t) === true) {
      fallo = null;
      return Promise.reject(new Error("fallo inyectado"));
    }

    if (t === "BEGIN") {
      copia = structuredClone(e);
      return r([]);
    }
    if (t === "COMMIT") {
      copia = null;
      return r([]);
    }
    if (t === "ROLLBACK") {
      if (copia !== null) e = copia;
      copia = null;
      return r([]);
    }

    const imdbDe = (titleId: number) =>
      Object.entries(e.titulos).find(([, id]) => id === titleId)?.[0];

    // ── Anuncios (ADR 0007) ─────────────────────────────────────────────
    // `anuncio`: lectura por títulos (`deltas/anuncios.ts`) · `vigente`: los
    // no observados en la ventana (`upcoming/horizonte.ts`).
    if (t.includes("FROM external_availability_announcements anuncio")) {
      const pais = String(valores[0]);
      const imdbs = new Set((valores[1] as string[]).map(String));
      return r(
        e.anuncios
          .filter((x) => x.country === pais && imdbs.has(imdbDe(x.titleId) ?? ""))
          .map((x) => ({
            imdb_id: imdbDe(x.titleId),
            id: x.id,
            platform_id: x.platformId,
            offer_type: x.offerType,
            addon: x.addon,
            announced_for: x.announcedFor,
            first_announced_for: x.firstAnnouncedFor,
            link: x.link,
            first_seen_at: x.firstSeenAt,
            last_seen_at: x.lastSeenAt,
            last_seen_run_id: x.lastSeenRunId,
          })),
      );
    }
    if (t.includes("FROM external_availability_announcements vigente")) {
      const pais = String(valores[0]);
      const desde = comoFecha(valores[1]) ?? new Date(0);
      const hasta = comoFecha(valores[2]) ?? new Date(0);
      const ahora = comoFecha(valores[3]) ?? new Date(0);
      const run = valores[4] === null ? null : Number(valores[4]);
      return r(
        e.anuncios
          .filter(
            (x) =>
              x.country === pais &&
              x.announcedFor >= desde &&
              x.announcedFor <= hasta &&
              x.lastSeenAt < ahora &&
              x.lastSeenRunId !== run,
          )
          .map((x) => ({
            imdb_id: imdbDe(x.titleId),
            platform_id: x.platformId,
            offer_type: x.offerType,
            addon: x.addon,
          })),
      );
    }
    if (t.includes("FROM external_availability_announcements proximo")) {
      const pais = String(valores[0]);
      const ahora = comoFecha(valores[1]) ?? new Date(0);
      const sinCobertura = new Set((valores[2] as string[]).map(String));
      const referencia = valores[3] === null ? null : Number(valores[3]);
      return r(
        e.anuncios
          .filter(
            (x) =>
              x.country === pais &&
              x.announcedFor > ahora &&
              (sinCobertura.has(x.platformId) ||
                (referencia !== null &&
                  x.lastSeenRunId !== null &&
                  x.lastSeenRunId >= referencia)),
          )
          .map((x) => ({
            imdb_id: imdbDe(x.titleId),
            platform_id: x.platformId,
            offer_type: x.offerType,
            addon: x.addon,
            announced_for: x.announcedFor,
            link: x.link,
          })),
      );
    }
    if (t.startsWith("UPDATE external_availability_announcements")) {
      const a = e.anuncios.find((x) => x.id === Number(valores[0]));
      const vista = comoFecha(valores[5]) ?? new Date(0);
      // La guarda de la sentencia: `AND last_seen_at <= $6`.
      if (a === undefined || a.lastSeenAt > vista) return r([]);
      a.announcedFor = comoFecha(valores[1]) ?? a.announcedFor;
      a.firstAnnouncedFor = comoFecha(valores[2]) ?? a.firstAnnouncedFor;
      a.link = (valores[3] as string | null) ?? null;
      a.firstSeenAt = comoFecha(valores[4]) ?? a.firstSeenAt;
      a.lastSeenAt = vista;
      a.lastSeenRunId = valores[6] === null ? null : Number(valores[6]);
      if (a.lastSeenAt < a.firstSeenAt) {
        return Promise.reject(new Error("CHECK vistas_ordenadas"));
      }
      return r([{ id: a.id }]);
    }

    // ── Ofertas con una fecha de salida dentro del horizonte ────────────
    // `oferta`: `expiring/horizonte.ts`.
    if (t.includes("FROM external_availability oferta")) {
      const pais = String(valores[0]);
      const umbral = Number(valores[1]);
      const desde = comoFecha(valores[2]) ?? new Date(0);
      const hasta = comoFecha(valores[3]) ?? new Date(0);
      const filas: Record<string, unknown>[] = [];
      for (const o of e.ofertas) {
        if (o.country !== pais) continue;
        const dentro = e.opciones.some((x) => {
          const fecha = x.expiresAt;
          return (
            x.availabilityId === o.id &&
            x.missingStreak < umbral &&
            fecha !== null &&
            fecha >= desde &&
            fecha <= hasta
          );
        });
        if (!dentro) continue;
        filas.push({
          imdb_id: imdbDe(o.titleId),
          platform_id: o.platformId,
          offer_type: o.offerType,
          addon: o.addon,
        });
      }
      return r(filas);
    }

    // ── Títulos que ya existen (`soloTitulosConocidos`, `updated`) ───────
    if (t.startsWith("SELECT imdb_id FROM external_titles")) {
      const imdbs = (valores[0] as string[]).map(String);
      return r(imdbs.filter((i) => i in e.titulos).map((i) => ({ imdb_id: i })));
    }

    // ── Estado anterior ─────────────────────────────────────────────────
    if (t.includes("FROM external_availability a")) {
      const pais = String(valores[0]);
      const imdbs = new Set((valores[1] as string[]).map(String));
      const filas: Record<string, unknown>[] = [];
      for (const [imdb, titleId] of Object.entries(e.titulos)) {
        if (!imdbs.has(imdb)) continue;
        for (const o of e.ofertas.filter(
          (x) => x.titleId === titleId && x.country === pais,
        )) {
          const base = {
            imdb_id: imdb,
            availability_id: o.id,
            platform_id: o.platformId,
            offer_type: o.offerType,
            addon: o.addon,
            last_checked_at: o.lastCheckedAt,
          };
          const hijas = e.opciones.filter((x) => x.availabilityId === o.id);
          if (hijas.length === 0) filas.push({ ...base, option_id: null, link: null });
          for (const h of hijas) {
            filas.push({
              ...base,
              option_id: h.id,
              link: h.link,
              video_link: h.videoLink,
              quality: h.quality,
              price_amount: h.priceAmount,
              price_currency: h.priceCurrency,
              audio_languages: h.audioLanguages,
              subtitle_languages: h.subtitleLanguages,
              available_since: h.availableSince,
              expires_at: h.expiresAt,
              first_seen_at: h.firstSeenAt,
              missing_streak: h.missingStreak,
            });
          }
        }
      }
      return r(filas);
    }

    // ── Reconciliación ──────────────────────────────────────────────────
    const ids = (v: unknown) => new Set((v as unknown[]).map(Number));
    if (t.startsWith("DELETE FROM external_availability_options")) {
      const borrar = ids(valores[0]);
      e.opciones = e.opciones.filter((o) => !borrar.has(o.id));
      return r([]);
    }
    if (t.includes("SET missing_streak = 0, last_seen_at = $2")) {
      const vistas = ids(valores[0]);
      for (const o of e.opciones) {
        if (!vistas.has(o.id)) continue;
        o.missingStreak = 0;
        o.lastSeenAt = comoFecha(valores[1]) ?? o.lastSeenAt;
      }
      return r([]);
    }
    if (t.includes("SET missing_streak = $2")) {
      const ausentes = ids(valores[0]);
      for (const o of e.opciones)
        if (ausentes.has(o.id)) o.missingStreak = Number(valores[1]);
      return r([]);
    }
    if (t.includes("SET first_seen_at = LEAST")) {
      for (const o of e.opciones) {
        if (o.availabilityId !== Number(valores[0]) || o.link !== valores[1]) continue;
        const desde = comoFecha(valores[2]);
        if (desde !== null && desde < o.firstSeenAt) o.firstSeenAt = desde;
      }
      return r([]);
    }

    // ── Inserciones ─────────────────────────────────────────────────────
    const cabecera = CABECERA.exec(t);
    if (cabecera === null) return r([]);
    const tabla = cabecera[1] ?? "";
    const columnas = (cabecera[2] ?? "")
      .split(",")
      .map((c) => c.trim().replace(/"/g, ""));
    const tuplas: Record<string, unknown>[] = [];
    for (let i = 0; i + columnas.length <= valores.length; i += columnas.length) {
      const fila: Record<string, unknown> = {};
      columnas.forEach((c, j) => (fila[c] = valores[i + j]));
      tuplas.push(fila);
    }
    const pol = politicas(t, tabla);
    const aplicar = (
      actual: Date | null,
      nuevo: unknown,
      columna: string,
    ): Date | null =>
      pol.get(columna) === "avanzar"
        ? mayor(actual, comoFecha(nuevo))
        : comoFecha(nuevo);

    if (tabla === "external_titles") {
      return r(
        tuplas.map((f) => {
          const imdb = String(f.imdb_id);
          const existe = e.titulos[imdb];
          const id = existe ?? e.siguienteId++;
          e.titulos[imdb] = id;
          return { insertada: existe === undefined, id, imdb_id: imdb };
        }),
      );
    }

    if (tabla === "external_availability") {
      return r(
        tuplas.map((f) => {
          const addon = typeof f.addon === "string" ? f.addon : null;
          let o = e.ofertas.find(
            (x) =>
              x.titleId === Number(f.title_id) &&
              x.platformId === f.platform_id &&
              x.country === f.country &&
              x.offerType === f.offer_type &&
              x.addon === addon,
          );
          const insertada = o === undefined;
          if (o === undefined) {
            o = {
              id: e.siguienteId++,
              titleId: Number(f.title_id),
              platformId: String(f.platform_id),
              country: String(f.country),
              offerType: String(f.offer_type),
              addon,
              lastCheckedAt: comoFecha(f.last_checked_at),
            };
            e.ofertas.push(o);
          } else if (pol.has("last_checked_at")) {
            o.lastCheckedAt = aplicar(
              o.lastCheckedAt,
              f.last_checked_at,
              "last_checked_at",
            );
          }
          return {
            insertada,
            id: o.id,
            title_id: o.titleId,
            platform_id: o.platformId,
            offer_type: o.offerType,
            addon: o.addon,
          };
        }),
      );
    }

    if (tabla === "external_availability_options") {
      return r(
        tuplas.map((f) => {
          const quality = typeof f.quality === "string" ? f.quality : null;
          let o = e.opciones.find(
            (x) =>
              x.availabilityId === Number(f.availability_id) &&
              x.link === f.link &&
              x.quality === quality,
          );
          const insertada = o === undefined;
          if (o === undefined) {
            o = {
              id: e.siguienteId++,
              availabilityId: Number(f.availability_id),
              link: String(f.link),
              videoLink: (f.video_link as string | null | undefined) ?? null,
              quality,
              priceAmount: (f.price_amount as string | null) ?? null,
              priceCurrency: (f.price_currency as string | null) ?? null,
              audioLanguages: [...(f.audio_languages as string[])],
              subtitleLanguages: [...(f.subtitle_languages as string[])],
              availableSince: comoFecha(f.available_since),
              expiresAt: comoFecha(f.expires_at),
              firstSeenAt: comoFecha(f.first_seen_at) ?? new Date(0),
              lastSeenAt: comoFecha(f.last_seen_at) ?? new Date(0),
              missingStreak: 0,
            };
            e.opciones.push(o);
          } else {
            // Todo lo que el `DO UPDATE` sobrescribe con EXCLUDED, como en
            // PostgreSQL: así un upsert que pisa `video_link` o los idiomas
            // con el dato de un anuncio se ve en la foto.
            if (pol.has("video_link")) {
              o.videoLink = (f.video_link as string | null | undefined) ?? null;
            }
            if (pol.has("price_amount")) {
              o.priceAmount = (f.price_amount as string | null | undefined) ?? null;
            }
            if (pol.has("price_currency")) {
              o.priceCurrency = (f.price_currency as string | null | undefined) ?? null;
            }
            if (pol.has("audio_languages")) {
              o.audioLanguages = [...(f.audio_languages as string[])];
            }
            if (pol.has("subtitle_languages")) {
              o.subtitleLanguages = [...(f.subtitle_languages as string[])];
            }
            o.availableSince = comoFecha(f.available_since);
            o.expiresAt = comoFecha(f.expires_at);
            o.lastSeenAt =
              aplicar(o.lastSeenAt, f.last_seen_at, "last_seen_at") ?? o.lastSeenAt;
          }
          return { insertada };
        }),
      );
    }

    if (tabla === "external_availability_announcements") {
      const f = tuplas[0] ?? {};
      const addon = typeof f.addon === "string" ? f.addon : null;
      // La clave natural, con NULLS NOT DISTINCT: un INSERT duplicado es un
      // error en PostgreSQL, y aquí también.
      const repetido = e.anuncios.some(
        (x) =>
          x.titleId === Number(f.title_id) &&
          x.platformId === f.platform_id &&
          x.country === f.country &&
          x.offerType === f.offer_type &&
          x.addon === addon,
      );
      if (repetido) {
        return Promise.reject(new Error("external_availability_announcements_key"));
      }
      const a: Anuncio = {
        id: e.siguienteId++,
        titleId: Number(f.title_id),
        platformId: String(f.platform_id),
        country: String(f.country),
        offerType: String(f.offer_type),
        addon,
        announcedFor: comoFecha(f.announced_for) ?? new Date(0),
        firstAnnouncedFor: comoFecha(f.first_announced_for) ?? new Date(0),
        link: typeof f.link === "string" ? f.link : null,
        firstSeenAt: comoFecha(f.first_seen_at) ?? new Date(0),
        lastSeenAt: comoFecha(f.last_seen_at) ?? new Date(0),
        lastSeenRunId:
          f.last_seen_run_id === null || f.last_seen_run_id === undefined
            ? null
            : Number(f.last_seen_run_id),
      };
      if (a.lastSeenAt < a.firstSeenAt) {
        return Promise.reject(new Error("CHECK vistas_ordenadas"));
      }
      e.anuncios.push(a);
      return r([]);
    }

    if (tabla === "external_availability_events") {
      const f = tuplas[0] ?? {};
      const bucket = (comoFecha(f.dedupe_bucket_at) ?? new Date(0)).toISOString();
      const repetido = e.eventos.some(
        (x) =>
          x.availabilityId === Number(f.availability_id) &&
          x.eventType === f.event_type &&
          x.digest === f.event_digest &&
          x.bucket === bucket,
      );
      if (repetido) return r([]);
      const ev: Evento = {
        id: e.siguienteId++,
        availabilityId: Number(f.availability_id),
        eventType: String(f.event_type),
        digest: String(f.event_digest),
        bucket,
      };
      e.eventos.push(ev);
      return r([{ id: ev.id }]);
    }

    // Géneros, plataformas, imágenes: no intervienen en estas secuencias.
    return r(tuplas.map(() => ({ insertada: true })));
  };

  return {
    ejecutor: { ejecutar },
    sentencias,
    opcion: (link) => e.opciones.find((o) => o.link === link),
    ultimaComprobacion: (platformId) =>
      e.ofertas.find((o) => o.platformId === platformId)?.lastCheckedAt ?? null,
    eventos: () => [...e.eventos],
    anuncios: () => anunciosVisibles(e),
    fallarUnaVezEn(predicado) {
      fallo = predicado;
    },
    foto({ instantes = true } = {}) {
      const imdbDe = new Map(Object.entries(e.titulos).map(([imdb, id]) => [id, imdb]));
      const ofertaDe = new Map(e.ofertas.map((o) => [o.id, o]));
      const clave = (availabilityId: number) => {
        const o = ofertaDe.get(availabilityId);
        return o === undefined
          ? "?"
          : `${imdbDe.get(o.titleId) ?? "?"}|${o.platformId}|${o.offerType}|${o.addon ?? ""}`;
      };
      const iso = (d: Date | null) => (instantes ? (d?.toISOString() ?? null) : "—");
      const ordenar = <T>(xs: T[]) =>
        xs.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return {
        titulos: Object.keys(e.titulos).sort(),
        ofertas: ordenar(
          e.ofertas.map((o) => ({
            oferta: clave(o.id),
            lastCheckedAt: iso(o.lastCheckedAt),
          })),
        ),
        opciones: ordenar(
          e.opciones.map((o) => ({
            oferta: clave(o.availabilityId),
            link: o.link,
            videoLink: o.videoLink,
            quality: o.quality,
            priceAmount: o.priceAmount,
            audioLanguages: o.audioLanguages,
            subtitleLanguages: o.subtitleLanguages,
            missingStreak: o.missingStreak,
            availableSince: o.availableSince?.toISOString() ?? null,
            expiresAt: o.expiresAt?.toISOString() ?? null,
            firstSeenAt: iso(o.firstSeenAt),
            lastSeenAt: iso(o.lastSeenAt),
          })),
        ),
        eventos: ordenar(
          e.eventos.map((ev) => ({
            oferta: clave(ev.availabilityId),
            tipo: ev.eventType,
            digest: ev.digest,
            bucket: ev.bucket,
          })),
        ),
        anuncios: anunciosVisibles(e).map((a) => ({
          ...a,
          firstSeenAt: instantes ? a.firstSeenAt : "—",
          lastSeenAt: instantes ? a.lastSeenAt : "—",
          lastSeenRunId: instantes ? a.lastSeenRunId : "—",
        })),
      };
    },
  };
}

function anunciosVisibles(e: Estado): AnuncioVisible[] {
  const imdbDe = new Map(Object.entries(e.titulos).map(([imdb, id]) => [id, imdb]));
  return e.anuncios
    .map((a) => ({
      imdbId: imdbDe.get(a.titleId) ?? "?",
      platformId: a.platformId,
      offerType: a.offerType,
      addon: a.addon,
      announcedFor: a.announcedFor.toISOString(),
      firstAnnouncedFor: a.firstAnnouncedFor.toISOString(),
      link: a.link,
      firstSeenAt: a.firstSeenAt.toISOString(),
      lastSeenAt: a.lastSeenAt.toISOString(),
      lastSeenRunId: a.lastSeenRunId,
    }))
    .sort((x, y) => {
      const kx = `${x.imdbId}|${x.platformId}|${x.offerType}|${x.addon ?? ""}`;
      const ky = `${y.imdbId}|${y.platformId}|${y.offerType}|${y.addon ?? ""}`;
      return kx < ky ? -1 : kx > ky ? 1 : 0;
    });
}
