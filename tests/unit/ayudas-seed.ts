/**
 * Dobles y fixtures del seed (ADR 0009), **sin red y sin base de datos**.
 *
 *   · `show()` y `crearProveedor()`: un proveedor falso de `search/filters`
 *     por estrato y cursor. Los fixtures se **generan** con la captura de
 *     verdad (`ejecutarCaptura`), así que el crudo que verifican los tests es
 *     el mismo formato que dejará la captura real.
 *   · `reempaquetar()`: rehace manifiesto y `SHA256SUMS` tras una mutación,
 *     para probar la coherencia interna con la integridad intacta.
 *   · `crearAlmacenDelSeed()`: un PostgreSQL de juguete que **obedece al SQL
 *     del upsert** —`DO NOTHING`, `EXCLUDED`, `GREATEST`— con transacciones de
 *     verdad, y el checkpoint de `ops_sync_runs` aplicado al libro **solo al
 *     confirmar**, como lo vería otra sesión.
 */
import { vi } from "vitest";

import type { EjecutorSql } from "../../jobs/ops/contratos.ts";
import { crearLibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import type { LibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import { leerPresupuesto } from "../../jobs/ops/presupuesto.ts";
import type {
  FuenteDePaginas,
  PeticionDePagina,
} from "../../jobs/pipelines/seed/captura.ts";
import { ejecutarCaptura } from "../../jobs/pipelines/seed/captura.ts";
import type { ContenidoDelCrudo } from "../../jobs/pipelines/seed/crudo/disco.ts";
import { crearAlmacenEnMemoria } from "../../jobs/pipelines/seed/crudo/almacen.ts";
import type {
  ManifiestoDelSeed,
  PlanDelSeed,
} from "../../jobs/pipelines/seed/crudo/formato.ts";
import {
  ESTRATOS_DEL_MVP,
  FICHERO_DE_SUMAS,
  FICHERO_DEL_MANIFIESTO,
  FORMATO_DEL_PLAN,
  MARGEN_DEL_ANCLA_SEGUNDOS,
  PARAMETROS_COMUNES,
  PLAZO_DEL_ANCLA_SEGUNDOS,
  VERSION_DEL_CRUDO,
} from "../../jobs/pipelines/seed/crudo/formato.ts";
import {
  construirSumas,
  jsonDeFichero,
  sha256,
} from "../../jobs/pipelines/seed/crudo/huella.ts";
import type { FilasCanonicas } from "../../jobs/pipelines/seed/huella-catalogo.ts";

/** El inicio de la captura de los fixtures: ciclo 202611, M1 en 202610. */
export const INICIO = new Date("2026-11-03T09:00:00.000Z");

/** Fija el reloj del sistema: `reservar()` compara el ciclo con `new Date()`. */
export function fijarReloj(instante: Date = INICIO): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(instante);
}

/** Un reloj que avanza `pasoMs` en cada lectura. */
export function crearReloj(inicio: Date = INICIO, pasoMs = 1000): () => Date {
  let t = inicio.getTime();
  return () => {
    const ahora = new Date(t);
    t += pasoMs;
    return ahora;
  };
}

export interface OpcionDeShow {
  readonly service: string;
  readonly type?: string;
  readonly link?: string;
  readonly quality?: string;
  readonly price?: { readonly amount: string; readonly currency: string };
}

/** Un show con la forma del proveedor. `imdb` nulo o vacío = sin identidad. */
export function show(
  imdb: string | null,
  entrada: {
    readonly tipo?: "movie" | "series";
    readonly titulo?: string;
    readonly opciones?: readonly OpcionDeShow[];
  } = {},
): Record<string, unknown> {
  const tipo = entrada.tipo ?? "movie";
  const id = (imdb ?? "x").replace(/\D/g, "") || "0";
  return {
    itemType: "show",
    showType: tipo,
    id,
    imdbId: imdb,
    title: entrada.titulo ?? `Título ${imdb ?? "sin id"}`,
    rating: 70,
    ...(tipo === "movie"
      ? { releaseYear: 2020 }
      : { firstAirYear: 2020, seasonCount: 2 }),
    genres: [{ id: "drama", name: "Drama" }],
    streamingOptions: {
      es: (entrada.opciones ?? [{ service: "netflix" }]).map((o) => ({
        service: { id: o.service, name: o.service },
        type: o.type ?? "subscription",
        link: o.link ?? `https://${o.service}.test/${id}`,
        ...(o.quality === undefined ? {} : { quality: o.quality }),
        ...(o.price === undefined ? {} : { price: o.price }),
      })),
    },
  };
}

/** Una página del proveedor falso. `hasMore` y `nextCursor` se deducen si faltan. */
export interface PaginaFalsa {
  readonly shows?: readonly Record<string, unknown>[];
  readonly hasMore?: boolean;
  readonly nextCursor?: string | null;
  /** Para forzar un cuerpo que no es una respuesta válida. */
  readonly cuerpoCrudo?: string;
  readonly status?: number;
}

/**
 * El proveedor falso: por estrato, una lista de páginas. La primera responde al
 * cursor `null`; la `i` responde al `nextCursor` de la `i − 1`. Un estrato sin
 * entrada devuelve una página vacía y agotada.
 */
export function crearProveedor(
  paginas: Readonly<Record<string, readonly PaginaFalsa[]>>,
) {
  const llamadas: PeticionDePagina[] = [];
  const cursorDe = (estrato: string, i: number, total: number): string | null => {
    const p = paginas[estrato]?.[i];
    if (p?.nextCursor !== undefined) return p.nextCursor;
    return i < total - 1 ? `${estrato}:${String(i + 1)}` : null;
  };
  const fuente: FuenteDePaginas = async (peticion, cuota) => {
    await cuota.pedirCuota();
    llamadas.push(peticion);
    const lista = paginas[peticion.estrato.estrato] ?? [{ shows: [], hasMore: false }];
    let i = 0;
    if (peticion.cursorDeEntrada !== null) {
      i = lista.findIndex(
        (_, k) =>
          k > 0 &&
          cursorDe(peticion.estrato.estrato, k - 1, lista.length) ===
            peticion.cursorDeEntrada,
      );
      if (i < 0)
        throw new Error(
          `sin página para ${peticion.estrato.estrato} @ ${peticion.cursorDeEntrada}`,
        );
    }
    const p = lista[i] ?? {};
    const siguiente = cursorDe(peticion.estrato.estrato, i, lista.length);
    const hasMore = p.hasMore ?? siguiente !== null;
    const cuerpo =
      p.cuerpoCrudo ??
      JSON.stringify({
        shows: p.shows ?? [],
        hasMore,
        ...(siguiente === null ? {} : { nextCursor: siguiente }),
      });
    return {
      status: p.status ?? 200,
      cuerpo: new TextEncoder().encode(cuerpo),
      cabeceras: {
        "x-quota-used": String(100 + llamadas.length),
        "x-quota-granted": "1000",
        "x-quota-reset": "2026-12-01T00:00:00Z",
      },
    };
  };
  return { fuente, llamadas };
}

/** Un plan v1 válido: los 12 estratos, M1 del ciclo anterior al de `INICIO`. */
export function crearPlan(parcial: Partial<PlanDelSeed> = {}): PlanDelSeed {
  return {
    formato: FORMATO_DEL_PLAN,
    v: VERSION_DEL_CRUDO,
    capturaId: "prueba-001",
    commit: null,
    pais: "es",
    parametrosComunes: { ...PARAMETROS_COMUNES },
    estratos: ESTRATOS_DEL_MVP.map((e) => ({
      ...e,
      orderBy: "popularity_alltime" as const,
      orderDirection: "desc" as const,
    })),
    objetivoUnicos: 5,
    tope: 50,
    margenDelAnclaSegundos: MARGEN_DEL_ANCLA_SEGUNDOS,
    plazoDelAnclaSegundos: PLAZO_DEL_ANCLA_SEGUNDOS,
    m1: { runId: "3", cicloClave: 202610, diaDeCiclo: 1 },
    ...parcial,
  };
}

/** Presupuesto **de test** para el seed. El del repositorio sigue en 0/0. */
export function presupuestoDeTest(tope = 50) {
  return leerPresupuesto({
    STREAMING_API_PER_RUN_CAPS: `seed=${String(tope)}`,
    // Holgado a propósito: el corte de estos tests es el del tope por ejecución.
    STREAMING_API_MONTHLY_PIPELINE_BUDGETS: `seed=${String(Math.max(tope, 500))}`,
  });
}

/** Una captura completa con fixtures. Devuelve el crudo en memoria. */
export async function capturar(entrada: {
  readonly paginas: Readonly<Record<string, readonly PaginaFalsa[]>>;
  readonly plan?: PlanDelSeed;
  readonly tope?: number;
  readonly libro?: LibroEnMemoria;
  readonly reloj?: () => Date;
  /** Para reanudar sobre el mismo crudo y el mismo diario. */
  readonly almacen?: ReturnType<typeof crearAlmacenEnMemoria>;
  readonly reanudar?: boolean;
  readonly proveedor?: ReturnType<typeof crearProveedor>;
  readonly fuente?: FuenteDePaginas;
  readonly relojDeT0?: () => Promise<Date>;
  readonly comprobarCuotaDelProveedor?: boolean;
}) {
  const libro = entrada.libro ?? crearLibroEnMemoria();
  const proveedor = entrada.proveedor ?? crearProveedor(entrada.paginas);
  const almacen = entrada.almacen ?? crearAlmacenEnMemoria();
  const salida = await ejecutarCaptura({
    ejecutorOps: libro.ejecutor,
    presupuesto: presupuestoDeTest(entrada.tope ?? 50),
    plan: entrada.plan ?? crearPlan(),
    fuente: entrada.fuente ?? proveedor.fuente,
    almacen,
    reloj: entrada.reloj ?? crearReloj(),
    ...(entrada.relojDeT0 === undefined ? {} : { relojDeT0: entrada.relojDeT0 }),
    destino: "rama-de-captura-de-prueba",
    reanudar: entrada.reanudar ?? false,
    comprobarCuotaDelProveedor: entrada.comprobarCuotaDelProveedor ?? true,
  });
  return {
    ...salida,
    contenido: almacen.contenido as ContenidoDelCrudo,
    almacen,
    libro,
    proveedor,
  };
}

const codificador = new TextEncoder();

/** Copia el crudo aplicando `mutar` al manifiesto, y rehace `SHA256SUMS`. */
export function reempaquetar(
  contenido: ContenidoDelCrudo,
  mutar: (m: ManifiestoDelSeed) => ManifiestoDelSeed,
  ficheros: (c: Map<string, Uint8Array>) => void = () => undefined,
): Map<string, Uint8Array> {
  const copia = new Map(contenido);
  const actual = JSON.parse(
    new TextDecoder().decode(copia.get(FICHERO_DEL_MANIFIESTO)),
  ) as ManifiestoDelSeed;
  copia.set(
    FICHERO_DEL_MANIFIESTO,
    codificador.encode(jsonDeFichero(mutar(structuredClone(actual)))),
  );
  ficheros(copia);
  return resellar(copia);
}

/** Rehace `SHA256SUMS` con lo que haya: la integridad vuelve a cuadrar. */
export function resellar(contenido: Map<string, Uint8Array>): Map<string, Uint8Array> {
  contenido.delete(FICHERO_DE_SUMAS);
  const sumas = [...contenido].map(([ruta, bytes]) => ({
    ruta,
    sha256: sha256(bytes),
  }));
  contenido.set(FICHERO_DE_SUMAS, codificador.encode(construirSumas(sumas)));
  return contenido;
}

// ── El almacén en memoria ───────────────────────────────────────────────────

type Fila = Record<string, unknown>;

const CLAVE_POR_CONSTRAINT: Readonly<Record<string, readonly string[]>> = {
  external_genres_pkey: ["id"],
  external_platforms_pkey: ["id"],
  external_platform_capabilities_pkey: ["platform_id", "country", "capability"],
  external_titles_imdb_id_key: ["imdb_id"],
  external_title_genres_pkey: ["title_id", "genre_id"],
  external_title_images_key: ["title_id", "type", "width", "language"],
  external_availability_key: [
    "title_id",
    "platform_id",
    "country",
    "offer_type",
    "addon",
  ],
  external_availability_options_key: ["availability_id", "link", "quality"],
};

const CON_ID = new Set([
  "external_titles",
  "external_title_images",
  "external_availability",
  "external_availability_options",
]);

const normal = (v: unknown): unknown => (v instanceof Date ? v.toISOString() : v);

export interface AlmacenDelSeed {
  /** La conexión de DATOS: tablas del catálogo + checkpoint de la fila. */
  readonly ejecutor: EjecutorSql;
  readonly libro: LibroEnMemoria;
  readonly sentencias: string[];
  filas(tabla: string): readonly Fila[];
  /** `imdb_id → id`: para comprobar que los ids no bailan. */
  idsDeTitulo(): ReadonlyMap<string, unknown>;
  /** Las tablas de estado en forma canónica, como las leería un validador. */
  filasCanonicas(): FilasCanonicas;
  /** Simula histórico ajeno al seed. */
  sembrarEventos(n: number): void;
  fallarUnaVezEn(predicado: (texto: string) => boolean): void;
}

export function crearAlmacenDelSeed(
  libro: LibroEnMemoria = crearLibroEnMemoria(),
): AlmacenDelSeed {
  let tablas = new Map<string, Map<string, Fila>>();
  let secuencia = 1;
  let eventos = 0;
  let copia: { tablas: Map<string, Map<string, Fila>>; secuencia: number } | null =
    null;
  let pendientes: { texto: string; valores: readonly unknown[] }[] = [];
  let fallo: ((t: string) => boolean) | null = null;
  const sentencias: string[] = [];

  const tabla = (nombre: string): Map<string, Fila> => {
    let t = tablas.get(nombre);
    if (t === undefined) {
      t = new Map();
      tablas.set(nombre, t);
    }
    return t;
  };

  const upsert = (texto: string, valores: readonly unknown[]): Fila[] => {
    const lineas = texto.split("\n");
    const cabecera = /^INSERT INTO (\w+) \(([^)]*)\)$/.exec(lineas[0] ?? "");
    const conflicto =
      /^ON CONFLICT ON CONSTRAINT (\w+) (DO NOTHING|DO UPDATE SET (.*))$/.exec(
        lineas[2] ?? "",
      );
    if (cabecera === null || conflicto === null)
      throw new Error(`INSERT no reconocido:\n${texto}`);
    const nombre = cabecera[1] ?? "";
    const columnas = (cabecera[2] ?? "")
      .split(",")
      .map((c) => c.trim().replace(/"/g, ""));
    const clave = CLAVE_POR_CONSTRAINT[conflicto[1] ?? ""];
    if (clave === undefined)
      throw new Error(`constraint desconocida: ${conflicto[1] ?? ""}`);
    const politicas = new Map<string, "sobrescribir" | "avanzar">();
    for (const m of (conflicto[3] ?? "").matchAll(/"(\w+)" = (GREATEST|EXCLUDED)/g)) {
      politicas.set(m[1] ?? "", m[2] === "GREATEST" ? "avanzar" : "sobrescribir");
    }
    const extra = [...(lineas[3] ?? "").matchAll(/"(\w+)"/g)].map((m) => m[1] ?? "");
    const t = tabla(nombre);
    const devueltas: Fila[] = [];
    for (let i = 0; i < valores.length; i += columnas.length) {
      const nueva: Fila = {};
      columnas.forEach((c, k) => (nueva[c] = valores[i + k] ?? null));
      const k = JSON.stringify(clave.map((c) => normal(nueva[c])));
      const existente = t.get(k);
      let insertada = false;
      let fila: Fila;
      if (existente === undefined) {
        fila = CON_ID.has(nombre) ? { id: secuencia++, ...nueva } : nueva;
        t.set(k, fila);
        insertada = true;
      } else if (conflicto[2] === "DO NOTHING") {
        continue;
      } else {
        fila = existente;
        for (const [c, politica] of politicas) {
          const v = nueva[c];
          if (politica === "sobrescribir") fila[c] = v;
          else {
            const a = fila[c];
            fila[c] =
              a instanceof Date && v instanceof Date
                ? a.getTime() >= v.getTime()
                  ? a
                  : v
                : v;
          }
        }
      }
      const salida: Fila = { insertada };
      for (const c of extra) salida[c] = fila[c];
      devueltas.push(salida);
    }
    return devueltas;
  };

  const ejecutar = async <T>(
    texto: string,
    valores: readonly unknown[] = [],
  ): Promise<readonly T[]> => {
    const t = texto.trim();
    sentencias.push(t);
    const r = (f: unknown[]) => f as readonly T[];
    if (fallo?.(t) === true) {
      fallo = null;
      throw new Error("fallo inyectado");
    }
    if (t === "BEGIN") {
      copia = { tablas: structuredClone(tablas), secuencia };
      pendientes = [];
      return r([]);
    }
    if (t === "COMMIT") {
      for (const p of pendientes) await libro.ejecutor.ejecutar(p.texto, p.valores);
      copia = null;
      pendientes = [];
      return r([]);
    }
    if (t === "ROLLBACK") {
      if (copia !== null) {
        tablas = copia.tablas;
        secuencia = copia.secuencia;
      }
      copia = null;
      pendientes = [];
      return r([]);
    }
    if (t.startsWith("INSERT INTO")) return r(upsert(t, valores));
    if (t.includes("AS escritores")) {
      const escritores = libro.filas.filter((f) =>
        ["deltas", "expiring", "upcoming", "updated"].includes(f.pipeline),
      ).length;
      return r([
        {
          titulos: String(tabla("external_titles").size),
          ofertas: String(tabla("external_availability").size),
          eventos: String(eventos),
          anuncios: "0",
          escritores: String(escritores),
        },
      ]);
    }
    if (t.includes("checkpoint ->> 'fase' = 'carga'")) {
      // Lo confirmado, como lo vería cualquier sesión.
      return libro.ejecutor.ejecutar<T>(texto, valores);
    }
    if (t.includes("SET checkpoint = $2::jsonb")) {
      const viva = libro.filas.find(
        (f) => f.id === Number(valores[0]) && f.status === "running",
      );
      if (viva === undefined) return r([]);
      pendientes.push({ texto, valores });
      return r([{ id: viva.id }]);
    }
    throw new Error(`sentencia no reconocida por el almacén:\n${t}`);
  };

  const canonicas = (): FilasCanonicas => {
    const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
    const escoger = (f: Fila, columnas: readonly string[]): Fila =>
      Object.fromEntries(columnas.map((c) => [c, iso(f[c])]));
    const imdbDe = new Map(
      [...tabla("external_titles").values()].map((f) => [String(f.id), f.imdb_id]),
    );
    const ofertaDe = new Map(
      [...tabla("external_availability").values()].map((f) => [String(f.id), f]),
    );
    const deOferta = (f: Fila): Fila => ({
      imdb_id: imdbDe.get(String(f.title_id)),
      platform_id: f.platform_id,
      country: f.country,
      offer_type: f.offer_type,
      addon: f.addon,
    });
    const todas = (n: string) => [...tabla(n).values()];
    return {
      external_platforms: todas("external_platforms").map((f) =>
        escoger(f, ["id", "name", "source", "source_id", "public_slug", "is_active"]),
      ),
      external_platform_capabilities: todas("external_platform_capabilities").map((f) =>
        escoger(f, ["platform_id", "country", "capability", "status"]),
      ),
      external_genres: todas("external_genres").map((f) => escoger(f, ["id", "name"])),
      external_titles: todas("external_titles").map((f) =>
        escoger(f, [
          "imdb_id",
          "type",
          "tmdb_id",
          "source",
          "source_id",
          "title",
          "original_title",
          "overview",
          "rating",
          "year",
          "end_year",
          "runtime_minutes",
          "season_count",
          "episode_count",
          "cast_members",
          "directors",
        ]),
      ),
      external_title_genres: todas("external_title_genres").map((f) => ({
        imdb_id: imdbDe.get(String(f.title_id)),
        genre_id: f.genre_id,
      })),
      external_title_images: todas("external_title_images").map((f) => ({
        imdb_id: imdbDe.get(String(f.title_id)),
        ...escoger(f, [
          "type",
          "width",
          "language",
          "observed_url",
          "url_expires_at",
          "captured_at",
          "is_placeholder",
        ]),
      })),
      external_availability: todas("external_availability").map((f) => ({
        ...deOferta(f),
        last_checked_at: iso(f.last_checked_at),
      })),
      external_availability_options: todas("external_availability_options").map((f) => {
        const oferta = ofertaDe.get(String(f.availability_id));
        if (oferta === undefined) throw new Error("opción huérfana en el almacén");
        return {
          ...deOferta(oferta),
          ...escoger(f, [
            "link",
            "quality",
            "video_link",
            "price_amount",
            "price_currency",
            "audio_languages",
            "subtitle_languages",
            "available_since",
            "expires_at",
            "first_seen_at",
            "last_seen_at",
          ]),
        };
      }),
    };
  };

  return {
    ejecutor: { ejecutar },
    libro,
    sentencias,
    filas: (n) => [...tabla(n).values()],
    idsDeTitulo: () =>
      new Map(
        [...tabla("external_titles").values()].map((f) => [String(f.imdb_id), f.id]),
      ),
    filasCanonicas: canonicas,
    sembrarEventos(n) {
      eventos += n;
    },
    fallarUnaVezEn(predicado) {
      fallo = predicado;
    },
  };
}
