/**
 * **M1 — ¿ordena `popularity_alltime` en cada plataforma?** (ADR 0009 §1, §3,
 * «Mediciones pendientes»). Funciones puras: evaluar una página, decidir el
 * orden de cada plataforma, el formato de `m1.json` y su verificación offline.
 *
 * ── Qué se mide ──────────────────────────────────────────────────────────────
 *
 * La página 1 de `search/filters` con `order_by=popularity_alltime&order_direction=desc`
 * en los **10 estratos sin medir** —Prime, Disney+, Max, Apple TV y
 * SkyShowtime × película/serie—: **≤ 10 requests**. Netflix no se vuelve a
 * medir: su evidencia es la del Spike 3 (`spike-3/raw/016`, `027`), que se
 * evalúa con **las mismas reglas**, a 0 requests.
 *
 * ── Qué significa «ordena» ───────────────────────────────────────────────────
 *
 * ⚠️ El proveedor **no devuelve la puntuación de popularidad**, así que no hay
 * forma de comprobar que el orden sea el correcto. M1 comprueba lo que sí se
 * puede observar y **descarta las señales de que el orden se ignoró**:
 *
 *   · HTTP 200, envoltorio y **cada** show dentro del schema, al menos un show;
 *   · `hasMore=true` con un cursor, o `hasMore=false` con una página no llena;
 *   · el cursor **no tiene la forma del orden por defecto** (📏 `<id>:<título>`,
 *     `spike-1/raw/003`, `044`); el de popularidad del Spike 3 es numérico
 *     (📏 `6218:117630`, `194:73645`, `16:65512`);
 *   · la secuencia **no es la de la página 1 por defecto** del mismo estrato
 *     (📏 `spike-1/raw/003–014`, comparada a 0 requests);
 *   · los títulos **no están en orden alfabético**.
 *
 * Una plataforma usa `popularity_alltime` **solo si sus dos estratos pasan**;
 * si no, `rating` descendente (respaldo por plataforma). Un 400 o un timeout
 * **no demuestran** que el orden no exista (memoria del proyecto): solo que no
 * se puede usar con evidencia.
 *
 * Este módulo no lee disco ni llama a nadie.
 */
import { z } from "zod";

import type { EstratoDelMvp, EstratoDelPlan } from "./crudo/formato.ts";
import {
  ESTRATOS_DEL_MVP,
  claveDeCiclo,
  idDeOps,
  queryDePagina,
} from "./crudo/formato.ts";
import {
  construirSumas,
  jsonCanonico,
  jsonDeFichero,
  leerSumas,
  sha256,
} from "./crudo/huella.ts";
import { leerPagina } from "./pagina.ts";
import { PLATAFORMAS_MVP } from "./plataformas.ts";

export const FORMATO_DE_LA_SONDA = "mirada-larga.seed.sonda";
export const FORMATO_DEL_RESULTADO_M1 = "mirada-larga.seed.m1";
export const VERSION_DE_M1 = 1;
export const FICHERO_DE_LA_SONDA = "sonda.json";
export const FICHERO_DEL_RESULTADO_M1 = "m1.json";

/** La plataforma con evidencia histórica de `popularity_alltime` (Spike 3). */
export const PLATAFORMA_CON_EVIDENCIA = "netflix";

/** Los 10 estratos que M1 mide, en el orden fijo del plan. */
export const ESTRATOS_DE_M1: readonly EstratoDelMvp[] = ESTRATOS_DEL_MVP.filter(
  (e) => e.plataforma !== PLATAFORMA_CON_EVIDENCIA,
);

/** ⚖️ Máximo de requests de M1: una por estrato sin medir. */
export const MAXIMO_DE_REQUESTS_M1 = ESTRATOS_DE_M1.length;

/** Página llena de `search/filters` (📏 Spike 1: 20 por página). */
export const TITULOS_POR_PAGINA = 20;

/** El estrato con el orden que M1 prueba. */
export function estratoDeM1(e: EstratoDelMvp): EstratoDelPlan {
  return { ...e, orderBy: "popularity_alltime", orderDirection: "desc" };
}

/** La query exacta de M1 para un estrato: página 1, sin credencial. */
export function queryDeM1(e: EstratoDelMvp): Readonly<Record<string, string>> {
  return queryDePagina(estratoDeM1(e), null);
}

export const MOTIVOS_DE_RECHAZO = [
  "sin_respuesta",
  "http_no_2xx",
  "cuerpo_invalido",
  "sin_shows",
  "sin_cursor",
  "agotada_con_pagina_llena",
  "cursor_de_orden_por_defecto",
  "sin_referencia_por_defecto",
  "igual_al_orden_por_defecto",
  "orden_alfabetico",
] as const;
export type MotivoDeRechazo = (typeof MOTIVOS_DE_RECHAZO)[number];

export type FormaDelCursor = "popularidad" | "por_defecto" | "otra";

/**
 * 📏 `<n>:<n>` es la forma de los cursores de `popularity_alltime` en el Spike 3;
 * `<id>:<texto>` la del orden por defecto (`<id>:<título>`).
 */
export function formaDelCursor(cursor: string): FormaDelCursor {
  if (/^\d+:\d+$/.test(cursor)) return "popularidad";
  if (/^\d+:.*\D/.test(cursor)) return "por_defecto";
  return "otra";
}

const evaluacionV1 = z.strictObject({
  estrato: z.string().min(1),
  plataforma: z.string().min(1),
  fuente: z.enum(["medido", "evidencia_historica"]),
  /** De dónde sale la página evaluada: fichero del crudo o del Spike 3. */
  pagina: z.string().min(1).nullable(),
  referencia: z.string().min(1).nullable(),
  http: z.number().int().nullable(),
  resultado: z.enum(["valida", "rechazada"]),
  motivos: z.array(z.enum(MOTIVOS_DE_RECHAZO)),
  shows: z.number().int().nonnegative().nullable(),
  hasMore: z.boolean().nullable(),
  formaDelCursor: z.enum(["popularidad", "por_defecto", "otra"]).nullable(),
  /** Fracción de ids de la página por defecto que reaparecen. Solo descriptiva. */
  coincidenciaConDefecto: z.number().min(0).max(1).nullable(),
});
export type EvaluacionDeEstrato = z.infer<typeof evaluacionV1>;

export interface EntradaDeEvaluacion {
  readonly estrato: EstratoDelMvp;
  readonly fuente: EvaluacionDeEstrato["fuente"];
  readonly pagina: string | null;
  /** `null` = sin respuesta (timeout, error de red): la request sigue contada. */
  readonly http: number | null;
  readonly cuerpo: Uint8Array | null;
  /** La página 1 por defecto del mismo estrato (Spike 1), ya sin envoltorio. */
  readonly referencia: {
    readonly nombre: string;
    readonly shows: readonly unknown[];
  } | null;
}

function idDeShow(s: unknown): string {
  const o = typeof s === "object" && s !== null ? (s as Record<string, unknown>) : {};
  return typeof o.id === "string" ? o.id : JSON.stringify(o.imdbId ?? null);
}

function tituloDeShow(s: unknown): string {
  const o = typeof s === "object" && s !== null ? (s as Record<string, unknown>) : {};
  return typeof o.title === "string" ? o.title : "";
}

const cotejo = new Intl.Collator("es", { sensitivity: "base" });

/** Evalúa una página de M1 con las reglas de arriba. Pura. */
export function evaluarEstratoDeM1(e: EntradaDeEvaluacion): EvaluacionDeEstrato {
  const base = {
    estrato: e.estrato.estrato,
    plataforma: e.estrato.plataforma,
    fuente: e.fuente,
    pagina: e.pagina,
    referencia: e.referencia?.nombre ?? null,
    http: e.http,
  };
  const rechazo = (
    motivos: MotivoDeRechazo[],
    extra: Partial<EvaluacionDeEstrato> = {},
  ): EvaluacionDeEstrato => ({
    ...base,
    resultado: "rechazada",
    motivos,
    shows: null,
    hasMore: null,
    formaDelCursor: null,
    coincidenciaConDefecto: null,
    ...extra,
  });
  if (e.http === null || e.cuerpo === null) return rechazo(["sin_respuesta"]);
  const leida = leerPagina(e.http, e.cuerpo);
  if (!leida.valida) {
    return rechazo([leida.causa === "http" ? "http_no_2xx" : "cuerpo_invalido"]);
  }
  const { shows, hasMore, nextCursor } = leida.pagina;
  const motivos: MotivoDeRechazo[] = [];
  if (shows.length === 0) motivos.push("sin_shows");
  if (hasMore && (nextCursor === null || nextCursor.trim() === ""))
    motivos.push("sin_cursor");
  if (!hasMore && shows.length >= TITULOS_POR_PAGINA)
    motivos.push("agotada_con_pagina_llena");
  const forma =
    hasMore && nextCursor !== null && nextCursor !== ""
      ? formaDelCursor(nextCursor)
      : null;
  if (forma === "por_defecto") motivos.push("cursor_de_orden_por_defecto");

  const ids = shows.map(idDeShow);
  let coincidencia: number | null = null;
  if (e.referencia === null) {
    motivos.push("sin_referencia_por_defecto");
  } else {
    const ref = e.referencia.shows.map(idDeShow);
    const enRef = new Set(ref);
    coincidencia =
      ref.length === 0 ? 0 : ids.filter((i) => enRef.has(i)).length / ref.length;
    if (
      ids.length > 0 &&
      ids.length === ref.length &&
      ids.every((i, k) => i === ref[k])
    ) {
      motivos.push("igual_al_orden_por_defecto");
    }
  }
  const titulos = shows.map(tituloDeShow);
  if (
    titulos.length >= 5 &&
    titulos.every((t, k) => k === 0 || cotejo.compare(titulos[k - 1] ?? "", t) <= 0)
  ) {
    motivos.push("orden_alfabetico");
  }
  return {
    ...base,
    resultado: motivos.length === 0 ? "valida" : "rechazada",
    motivos,
    shows: shows.length,
    hasMore,
    formaDelCursor: forma,
    coincidenciaConDefecto:
      coincidencia === null ? null : Math.round(coincidencia * 1000) / 1000,
  };
}

const decisionV1 = z.strictObject({
  plataforma: z.string().min(1),
  orderBy: z.enum(["popularity_alltime", "rating"]),
  fuente: z.enum(["medido", "evidencia_historica"]),
  motivo: z.string().min(1),
});
export type DecisionDeOrden = z.infer<typeof decisionV1>;

/**
 * **Una decisión por plataforma**, en el orden de `PLATAFORMAS_MVP`:
 * `popularity_alltime` si sus dos estratos son válidos; si no, `rating`.
 */
export function decidirOrdenes(
  evaluaciones: readonly EvaluacionDeEstrato[],
): DecisionDeOrden[] {
  return PLATAFORMAS_MVP.map((p) => {
    const suyas = evaluaciones.filter((e) => e.plataforma === p.id);
    const fuente = suyas[0]?.fuente ?? "medido";
    if (suyas.length !== 2) {
      return {
        plataforma: p.id,
        orderBy: "rating" as const,
        fuente,
        motivo: `respaldo: ${String(suyas.length)} de 2 estratos evaluados`,
      };
    }
    const rechazadas = suyas.filter((e) => e.resultado !== "valida");
    return rechazadas.length === 0
      ? {
          plataforma: p.id,
          orderBy: "popularity_alltime" as const,
          fuente,
          motivo: "los dos estratos pasan M1",
        }
      : {
          plataforma: p.id,
          orderBy: "rating" as const,
          fuente,
          motivo: `respaldo por rating: ${rechazadas.map((e) => `${e.estrato} (${e.motivos.join(", ")})`).join("; ")}`,
        };
  });
}

// ── Ficheros ────────────────────────────────────────────────────────────────

const instante = z.iso.datetime({ offset: false });
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/** `sonda.json`: lo que se va a pedir, escrito ANTES de la primera request. */
export const sondaV1 = z.strictObject({
  formato: z.literal(FORMATO_DE_LA_SONDA),
  v: z.literal(VERSION_DE_M1),
  sondaId: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/),
  commit: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/)
    .nullable(),
  estratos: z.array(
    z.strictObject({ estrato: z.string(), query: z.record(z.string(), z.string()) }),
  ),
  /** La página 1 por defecto de cada estrato (Spike 1), con su sha256. */
  referencias: z.array(
    z.strictObject({ estrato: z.string(), ruta: z.string(), sha256: sha256Hex }),
  ),
  /** Netflix: las páginas del Spike 3 que sustituyen a la medición. */
  evidencia: z.array(
    z.strictObject({ estrato: z.string(), ruta: z.string(), sha256: sha256Hex }),
  ),
});
export type SondaDelSeed = z.infer<typeof sondaV1>;

const paginaDeSondaV1 = z.strictObject({
  n: z.number().int().positive(),
  estrato: z.string(),
  fichero: z.string().nullable(),
  query: z.record(z.string(), z.string()),
  reservadaEn: instante,
  respondidaEn: instante.nullable(),
  http: z.number().int().nullable(),
  bytes: z.number().int().nonnegative().nullable(),
  sha256: sha256Hex.nullable(),
  cuota: z
    .strictObject({
      usada: z.number().int(),
      concedida: z.number().int(),
      reinicio: z.string(),
    })
    .nullable(),
  error: z.string().nullable(),
});
export type PaginaDeSonda = z.infer<typeof paginaDeSondaV1>;

/** `m1.json`: el resultado, que el plan de la captura referencia por sha256. */
export const resultadoM1V1 = z.strictObject({
  formato: z.literal(FORMATO_DEL_RESULTADO_M1),
  v: z.literal(VERSION_DE_M1),
  sondaId: z.string().min(1),
  /** La fila `seed`/`sonda` de `ops_sync_runs`, en texto decimal. */
  runId: idDeOps,
  destino: z.string().min(1),
  /** El ciclo de cuota en que corrió M1. La captura solo vale en el siguiente. */
  cicloClave: claveDeCiclo,
  diaDeCiclo: z.number().int().min(1).max(28),
  estado: z.enum(["succeeded", "budget_stopped", "failed"]),
  motivo: z.string().min(1),
  requestsReservadas: z.number().int().nonnegative(),
  paginas: z.array(paginaDeSondaV1),
  evaluaciones: z.array(evaluacionV1),
  decisiones: z.array(decisionV1),
});
export type ResultadoM1 = z.infer<typeof resultadoM1V1>;

export interface ContenidoDeSonda {
  readonly get: (ruta: string) => Uint8Array | undefined;
  readonly keys: () => IterableIterator<string>;
}

export interface VerificacionDeM1 {
  readonly ok: boolean;
  readonly problemas: readonly string[];
  readonly resultado: ResultadoM1 | null;
  /** sha256 de `m1.json`: la huella que el plan lleva en `huellaDelResultado`. */
  readonly huella: string | null;
  /** Si el resultado sirve para fijar un plan: completo y `succeeded`. */
  readonly utilizable: boolean;
}

const decodificador = new TextDecoder("utf-8", { fatal: true });

function json(bytes: Uint8Array | undefined): unknown {
  if (bytes === undefined) return undefined;
  try {
    return JSON.parse(decodificador.decode(bytes));
  } catch {
    return undefined;
  }
}

/**
 * **Verifica una sonda offline**: sumas, formatos, y que **cada evaluación se
 * reproduce** desde los cuerpos del crudo y las referencias. `externos` son
 * los ficheros del Spike (referencias y evidencia), por ruta; se comprueban
 * contra el sha256 que `sonda.json` registró.
 */
export function verificarM1(
  contenido: ContenidoDeSonda,
  externos: ReadonlyMap<string, Uint8Array>,
): VerificacionDeM1 {
  const problemas: string[] = [];
  const fin = (
    resultado: ResultadoM1 | null,
    huella: string | null,
  ): VerificacionDeM1 => ({
    ok: problemas.length === 0,
    problemas,
    resultado: problemas.length === 0 ? resultado : null,
    huella,
    utilizable:
      problemas.length === 0 &&
      resultado !== null &&
      resultado.estado === "succeeded" &&
      resultado.paginas.length === MAXIMO_DE_REQUESTS_M1,
  });

  const sumas = contenido.get("SHA256SUMS");
  const leidas = sumas === undefined ? null : leerSumas(decodificador.decode(sumas));
  if (leidas?.ok !== true) {
    problemas.push("SHA256SUMS ausente o inválido");
    return fin(null, null);
  }
  const listadas = new Set(leidas.sumas.map((s) => s.ruta));
  for (const s of leidas.sumas) {
    const b = contenido.get(s.ruta);
    if (b === undefined) problemas.push(`falta ${s.ruta}`);
    else if (sha256(b) !== s.sha256) problemas.push(`sha256 incorrecto: ${s.ruta}`);
  }
  for (const r of contenido.keys()) {
    if (r !== "SHA256SUMS" && !listadas.has(r)) problemas.push(`fichero de más: ${r}`);
  }
  const sonda = sondaV1.safeParse(json(contenido.get(FICHERO_DE_LA_SONDA)));
  const bytesM1 = contenido.get(FICHERO_DEL_RESULTADO_M1);
  const resultado = resultadoM1V1.safeParse(json(bytesM1));
  if (!sonda.success) problemas.push("sonda.json no cumple el formato v1");
  if (!resultado.success) problemas.push("m1.json no cumple el formato v1");
  if (!sonda.success || !resultado.success || bytesM1 === undefined)
    return fin(null, null);
  const huella = sha256(bytesM1);
  const r = resultado.data;
  if (r.sondaId !== sonda.data.sondaId)
    problemas.push("sondaId distinto en sonda.json y m1.json");

  const externo = (ruta: string, esperado: string): Uint8Array | null => {
    const b = externos.get(ruta);
    if (b === undefined) {
      problemas.push(`falta el fichero externo ${ruta}`);
      return null;
    }
    if (sha256(b) !== esperado) {
      problemas.push(`el fichero externo ${ruta} no es el que registró la sonda`);
      return null;
    }
    return b;
  };
  const showsDe = (b: Uint8Array | null): readonly unknown[] | null => {
    const v = json(b ?? undefined) as
      { body?: { shows?: unknown }; shows?: unknown } | undefined;
    const s = v?.body?.shows ?? v?.shows;
    return Array.isArray(s) ? s : null;
  };

  const esperadas: EvaluacionDeEstrato[] = [];
  for (const e of ESTRATOS_DEL_MVP) {
    const ref = sonda.data.referencias.find((x) => x.estrato === e.estrato);
    const refShows = ref === undefined ? null : showsDe(externo(ref.ruta, ref.sha256));
    const referencia =
      ref === undefined || refShows === null
        ? null
        : { nombre: ref.ruta, shows: refShows };
    if (e.plataforma === PLATAFORMA_CON_EVIDENCIA) {
      const ev = sonda.data.evidencia.find((x) => x.estrato === e.estrato);
      if (ev === undefined) {
        problemas.push(`sin evidencia histórica para ${e.estrato}`);
        continue;
      }
      const b = externo(ev.ruta, ev.sha256);
      const v = json(b ?? undefined) as
        { meta?: { status?: number }; body?: unknown } | undefined;
      esperadas.push(
        evaluarEstratoDeM1({
          estrato: e,
          fuente: "evidencia_historica",
          pagina: ev.ruta,
          http: v?.meta?.status ?? null,
          cuerpo:
            v?.body === undefined
              ? null
              : new TextEncoder().encode(JSON.stringify(v.body)),
          referencia,
        }),
      );
      continue;
    }
    const p = r.paginas.find((x) => x.estrato === e.estrato);
    const cuerpo = p?.fichero == null ? null : (contenido.get(p.fichero) ?? null);
    if (p !== undefined && p.fichero !== null) {
      if (cuerpo === null) problemas.push(`falta el cuerpo ${p.fichero}`);
      else if (sha256(cuerpo) !== p.sha256)
        problemas.push(`sha256 del manifiesto: ${p.fichero}`);
      const q = queryDeM1(e);
      if (jsonCanonico(p.query) !== jsonCanonico(q))
        problemas.push(`query incoherente: ${e.estrato}`);
    }
    if (p === undefined) continue;
    esperadas.push(
      evaluarEstratoDeM1({
        estrato: e,
        fuente: "medido",
        pagina: p.fichero,
        http: p.http,
        cuerpo,
        referencia,
      }),
    );
  }
  if (jsonCanonico(esperadas) !== jsonCanonico(r.evaluaciones)) {
    problemas.push("las evaluaciones de m1.json no se reproducen desde los cuerpos");
  }
  if (jsonCanonico(decidirOrdenes(esperadas)) !== jsonCanonico(r.decisiones)) {
    problemas.push("las decisiones de m1.json no se reproducen desde las evaluaciones");
  }
  if (
    r.paginas.length > MAXIMO_DE_REQUESTS_M1 ||
    r.requestsReservadas > MAXIMO_DE_REQUESTS_M1
  ) {
    problemas.push(`M1 no puede pasar de ${String(MAXIMO_DE_REQUESTS_M1)} requests`);
  }
  if (r.paginas.some((p) => p.estrato.startsWith(`${PLATAFORMA_CON_EVIDENCIA}-`))) {
    problemas.push("M1 no mide Netflix: usa la evidencia histórica");
  }
  return fin(r, huella);
}

/** El `SHA256SUMS` de un conjunto de ficheros de la sonda. */
export function sumasDeSonda(ficheros: ReadonlyMap<string, Uint8Array>): string {
  return construirSumas(
    [...ficheros].map(([ruta, b]) => ({ ruta, sha256: sha256(b) })),
  );
}

export { jsonDeFichero };
