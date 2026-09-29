/**
 * Validación de **solo lectura** del esquema v1 realmente creado en Neon.
 *
 * Los tests de `tests/contract/` comprueban lo que el esquema *declara* y lo
 * que drizzle-kit *emite*. Esto comprueba la tercera cosa, que es la única que
 * de verdad importa: **lo que PostgreSQL acabó teniendo**. Entre las tres hay
 * sitio de sobra para que algo se pierda por el camino.
 *
 *   pnpm db:validate:schema
 *
 * **Solo `SELECT` sobre catálogos.** Ni un `INSERT`, ni un `UPDATE`, ni un
 * `DELETE`, ni una línea de DDL. No aplica migraciones y no las modifica.
 *
 * Usa las mismas guardas que `drizzle.migrate.config.ts`: conexión directa sin
 * `-pooler`, hostname idéntico a `NEON_VALIDATION_HOST` y `MIGRATION_TARGET`
 * exacto. Si alguna falla, el proceso muere antes de abrir conexión. **Nunca se
 * imprime la cadena de conexión, el usuario ni la contraseña.**
 *
 * Sale con código distinto de 0 si algo no coincide.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { destinoDeProduction } from "./production-comun.ts";

const DIRECTORIO_MIGRACIONES = join(import.meta.dirname, "..", "drizzle");

// ── Lo que el esquema v1 DEBE tener ────────────────────────────────────────
// Extraído de las migraciones de `drizzle/` (0000, 0002, 0003 y 0004), no
// escrito de memoria.

const TABLAS = [
  "derived_ranking_definitions",
  "derived_ranking_entries",
  "external_availability",
  "external_availability_announcements",
  "external_availability_events",
  "external_availability_options",
  "external_genres",
  "external_list_captures",
  "external_list_positions",
  "external_platform_capabilities",
  "external_platforms",
  "external_title_genres",
  "external_title_images",
  "external_titles",
  "ops_sync_runs",
] as const;

const ENUMS: Readonly<Record<string, readonly string[]>> = {
  capability: ["expiring", "upcoming", "official_top", "prices", "popularity_order"],
  capability_status: [
    "supported_with_data",
    "supported_no_data_in_sample",
    "not_supported",
    "unknown",
  ],
  event_type: ["announced", "added", "changed", "removed"],
  image_type: [
    "vertical_poster",
    "horizontal_poster",
    "vertical_backdrop",
    "horizontal_backdrop",
  ],
  list_kind: ["popularity", "official_top"],
  offer_type: ["subscription", "rent", "buy", "free", "addon"],
  popularity_window: ["1week", "1month", "1year", "alltime"],
  quality: ["sd", "hd", "uhd"],
  sync_run_status: ["running", "succeeded", "failed", "budget_stopped"],
  title_type: ["movie", "series"],
};

/** Los cinco únicos que dependen de `NULLS NOT DISTINCT` para deduplicar. */
const UNICOS_NND: Readonly<Record<string, string>> = {
  external_title_images_key: "title_id,type,width,language",
  external_availability_key: "title_id,platform_id,country,offer_type,addon",
  // ADR 0007 · migración 0003. Sin `announced_for` ni `link`: son atributos.
  external_availability_announcements_key:
    "title_id,platform_id,country,offer_type,addon",
  external_availability_options_key: "availability_id,link,quality",
  external_list_captures_key:
    "list_kind,platform_id,country,title_type,window,bucket_start_at",
};

const CHECKS = [
  "derived_ranking_entries_position_positiva",
  "external_availability_options_missing_streak_no_negativo",
  "external_availability_options_precio_completo",
  "external_list_captures_obtained_depth_no_negativo",
  "external_list_captures_requested_depth_positivo",
  "external_list_captures_ventana_coherente",
  "external_list_positions_position_positiva",
  "external_titles_rating_rango",
  "ops_sync_runs_error_count_no_negativo",
  // ADR 0006 · migración 0002.
  "ops_sync_runs_checkpoint_objeto",
  // ADR 0007 · migración 0003.
  "external_availability_announcements_vistas_ordenadas",
  // Identidad vacía (`imdbId: ""`, medición de `updated`) · migración 0004.
  "external_titles_imdb_id_no_vacio",
] as const;

/**
 * Las 19 claves ajenas, **identificadas por su forma y no por su nombre**.
 *
 * ⚠️ El nombre de un constraint NO sirve para identificarlo. PostgreSQL trunca
 * los identificadores a 63 bytes (`NAMEDATALEN - 1`), y cuatro de los nombres
 * que genera Drizzle se pasan —hasta 73 caracteres—, así que en la base de
 * datos aparecen cortados. Compararlos por nombre da **cuatro falsos
 * negativos**: cuatro claves «ausentes» y cuatro «sobrantes» que en realidad
 * son las mismas.
 *
 * La identidad lógica de una clave ajena es `origen(columnas) → destino(columnas)`.
 * Eso no lo trunca nadie. El nombre se conserva solo como información.
 *
 * Reparto: 4 cascade · 13 restrict · 2 set null. Las tres de
 * `external_availability_announcements` (ADR 0007) son 2 restrict y 1 set null.
 */
const CLAVES_AJENAS: Readonly<Record<string, string>> = {
  "derived_ranking_entries(ranking_id) -> derived_ranking_definitions(id)": "cascade",
  "external_availability_options(availability_id) -> external_availability(id)":
    "cascade",
  "external_title_genres(title_id) -> external_titles(id)": "cascade",
  "external_title_images(title_id) -> external_titles(id)": "cascade",

  "derived_ranking_entries(title_id) -> external_titles(id)": "restrict",
  "external_availability(platform_id) -> external_platforms(id)": "restrict",
  "external_availability(title_id) -> external_titles(id)": "restrict",
  "external_availability_events(availability_id) -> external_availability(id)":
    "restrict",
  "external_availability_events(sync_run_id) -> ops_sync_runs(id)": "restrict",
  "external_list_captures(platform_id) -> external_platforms(id)": "restrict",
  "external_list_captures(sync_run_id) -> ops_sync_runs(id)": "restrict",
  "external_list_positions(capture_id) -> external_list_captures(id)": "restrict",
  "external_list_positions(title_id) -> external_titles(id)": "restrict",
  "external_platform_capabilities(platform_id) -> external_platforms(id)": "restrict",
  "external_title_genres(genre_id) -> external_genres(id)": "restrict",
  "external_availability_announcements(title_id) -> external_titles(id)": "restrict",
  "external_availability_announcements(platform_id) -> external_platforms(id)":
    "restrict",

  "external_availability(sync_run_id) -> ops_sync_runs(id)": "set null",
  "external_availability_announcements(last_seen_run_id) -> ops_sync_runs(id)":
    "set null",
};

/** Cuántas claves ajenas hay en total, y su reparto. Salen de la tabla de arriba. */
const TOTAL_DE_CLAVES_AJENAS = Object.keys(CLAVES_AJENAS).length;
const REPARTO_ESPERADO = {
  cascade: Object.values(CLAVES_AJENAS).filter((a) => a === "cascade").length,
  restrict: Object.values(CLAVES_AJENAS).filter((a) => a === "restrict").length,
  "set null": Object.values(CLAVES_AJENAS).filter((a) => a === "set null").length,
};

/** La que hace ejecutable la retención en dos pasos. */
const RETENCION_EN_DOS_PASOS =
  "external_list_positions(capture_id) -> external_list_captures(id)";

/** Límite de PostgreSQL para un identificador: `NAMEDATALEN - 1`. */
const LIMITE_DE_IDENTIFICADOR = 63;

const INDICES = [
  "external_availability_announcements_country_announced_for_idx",
  "external_availability_events_availability_bucket_idx",
  "external_availability_platform_country_idx",
  "external_list_positions_title_id_idx",
  "external_title_genres_genre_id_idx",
  "external_title_images_title_id_idx",
  "ops_sync_runs_pipeline_started_at_idx",
] as const;

const FUNCION_INMUTABILIDAD = "raise_immutable_history";

/** Los tres triggers, y su asimetría: solo eventos bloquea el `DELETE`. */
const TRIGGERS: Readonly<Record<string, { tabla: string; operaciones: string }>> = {
  external_availability_events_immutable: {
    tabla: "external_availability_events",
    operaciones: "BEFORE ROW: DELETE, UPDATE",
  },
  external_list_captures_immutable: {
    tabla: "external_list_captures",
    operaciones: "BEFORE ROW: UPDATE",
  },
  external_list_positions_immutable: {
    tabla: "external_list_positions",
    operaciones: "BEFORE ROW: UPDATE",
  },
};

/** Las tablas que pueden estar ahí sin ser nuestras, y por qué. */
const AJENAS_CONOCIDAS: Readonly<Record<string, string>> = {
  spike_ping: "tabla desechable del Spike 2, heredada de production",
};

// ── Mecánica del informe ───────────────────────────────────────────────────

let fallos = 0;

function seccion(titulo: string): void {
  console.log(`\n${titulo}`);
}

function comprobar(nombre: string, correcto: boolean, detalle?: string): void {
  if (!correcto) fallos++;
  console.log(`  ${correcto ? "✅" : "❌"} ${nombre}`);
  if (!correcto && detalle !== undefined && detalle !== "") {
    for (const linea of detalle.split("\n")) console.log(`       ${linea}`);
  }
}

function informar(nota: string): void {
  console.log(`  ℹ️  ${nota}`);
}

/** Compara dos conjuntos y describe la diferencia en lenguaje llano. */
function diferencia(
  esperados: readonly string[],
  observados: readonly string[],
): string {
  const faltan = esperados.filter((e) => !observados.includes(e));
  const sobran = observados.filter((o) => !esperados.includes(o));
  const partes: string[] = [];
  if (faltan.length > 0) partes.push(`faltan: ${faltan.join(", ")}`);
  if (sobran.length > 0) partes.push(`sobran: ${sobran.join(", ")}`);
  return partes.join("\n");
}

const ACCIONES_DE_BORRADO: Readonly<Record<string, string>> = {
  a: "no action",
  r: "restrict",
  c: "cascade",
  n: "set null",
  d: "set default",
};

// ── Comparación semántica de expresiones CHECK ─────────────────────────────
//
// PostgreSQL **no devuelve el texto que se le dio**: lo reescribe. Expande
// `BETWEEN` en dos desigualdades, añade el cast explícito a los literales de
// enum (`'popularity'::list_kind`), quita los paréntesis que la precedencia
// hace redundantes y entrecomilla lo que le parece. Comparar cadenas tal cual
// daría 9 falsos negativos.
//
// Así que se reducen **los dos lados** a la misma forma canónica y se comparan
// ahí. Es normalización estructural, no una prueba de equivalencia lógica: dos
// expresiones lógicamente iguales pero escritas distinto —con los operandos de
// un `AND` en otro orden, por ejemplo— darían diferencia. Para lo que hace
// falta aquí basta, porque el lado izquierdo es literalmente el fichero que
// generó el esquema.

/** Reduce una expresión SQL a una forma comparable entre Drizzle y PostgreSQL. */
export function normalizarExpresion(expresion: string): string {
  return (
    expresion
      .toLowerCase()
      // `check (...)` envolvente, que solo trae el lado de PostgreSQL.
      .replace(/^\s*check\s*/, "")
      // Cualificadores de tabla: `"external_titles"."rating"` → `rating`.
      .replace(/"[a-z_0-9]+"\."([a-z_0-9]+)"/g, "$1")
      // Lo que quede entrecomillado: `"window"` → `window`.
      .replace(/"([a-z_0-9]+)"/g, "$1")
      // Casts que PostgreSQL añade por su cuenta: `'popularity'::list_kind`.
      //
      // El nombre del tipo NO puede llevar espacios sueltos, o el patrón se
      // comería el `and` que viene detrás y dos condiciones distintas
      // normalizarían igual. Los tipos de varias palabras van enumerados.
      .replace(
        /::\s*"?[a-z_0-9]+"?(?:\s+with(?:out)?\s+time\s+zone|\s+varying|\s+precision)?/g,
        "",
      )
      // `x between a and b` es exactamente `x >= a and x <= b`, que es como lo
      // devuelve PostgreSQL.
      .replace(
        /\b([a-z_0-9]+)\s+between\s+(\S+)\s+and\s+(\S+)/g,
        "$1 >= $2 and $1 <= $3",
      )
      // Los paréntesis sobran una vez que los dos lados tienen el mismo árbol.
      .replace(/[()]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** Los nombres de clave ajena que las migraciones **pidieron**, antes de truncar. */
export function clavesAjenasDeLaMigracion(): readonly string[] {
  return [...leerMigraciones().matchAll(/ADD CONSTRAINT "([a-z_0-9]+)" FOREIGN KEY/g)]
    .map((m) => m[1])
    .filter((n): n is string => n !== undefined);
}

/**
 * Todas las migraciones, en orden, concatenadas.
 *
 * Hasta la 0002 los `CHECK` vivían solo en la 0000; desde el ADR 0006 hay uno
 * en la 0002, desde el ADR 0007 otro en la 0003 y otro más en la 0004
 * (`imdb_id` no vacío). La 0001 no declara ninguno
 * (lo vigila su test de contrato), así que leerlas todas no mete nada ajeno.
 */
function leerMigraciones(): string {
  const ficheros = readdirSync(DIRECTORIO_MIGRACIONES)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  if (!ficheros.some((f) => f.startsWith("0000_"))) {
    throw new Error("No encuentro la migración 0000.");
  }
  return ficheros
    .map((f) => readFileSync(join(DIRECTORIO_MIGRACIONES, f), "utf8"))
    .join("\n");
}

/**
 * Extrae los `CHECK` de las migraciones, que son **la fuente de la verdad**
 * sobre qué se le pidió a PostgreSQL. Escanea paréntesis equilibrados porque
 * las expresiones llevan los suyos.
 */
export function checksDeLaMigracion(): ReadonlyMap<string, string> {
  const sql = leerMigraciones();

  const salida = new Map<string, string>();
  const inicio = /CONSTRAINT "([a-z_0-9]+)" CHECK \(/g;
  let coincidencia: RegExpExecArray | null;

  while ((coincidencia = inicio.exec(sql)) !== null) {
    const nombre = coincidencia[1];
    if (nombre === undefined) continue;

    let profundidad = 1;
    let i = coincidencia.index + coincidencia[0].length;
    let enCadena = false;
    for (; i < sql.length && profundidad > 0; i++) {
      const c = sql[i];
      if (c === "'") enCadena = !enCadena;
      else if (!enCadena && c === "(") profundidad++;
      else if (!enCadena && c === ")") profundidad--;
    }
    salida.set(nombre, sql.slice(coincidencia.index + coincidencia[0].length, i - 1));
  }
  return salida;
}

// ── Las consultas: SOLO SELECT sobre catálogos ─────────────────────────────

interface FilaNombre {
  readonly nombre: string;
}
interface FilaEnum {
  readonly nombre: string;
  readonly labels: string;
}
interface FilaUnico {
  readonly nombre: string;
  readonly nnd: boolean;
  readonly columnas: string | null;
}
interface FilaCheck {
  readonly nombre: string;
  readonly definicion: string;
}
interface FilaClaveAjena {
  readonly nombre: string;
  readonly tabla: string;
  readonly columnas: string | null;
  readonly tabla_destino: string;
  readonly columnas_destino: string | null;
  readonly accion: string;
}

/** `origen(columnas) -> destino(columnas)`. Lo que PostgreSQL no puede truncar. */
function identidadDeClaveAjena(fila: FilaClaveAjena): string {
  return (
    `${fila.tabla}(${fila.columnas ?? "?"})` +
    ` -> ${fila.tabla_destino}(${fila.columnas_destino ?? "?"})`
  );
}
interface FilaFuncion {
  readonly nombre: string;
  readonly lenguaje: string;
  readonly retorno: string;
}
interface FilaTrigger {
  readonly nombre: string;
  readonly tabla: string;
  readonly por_fila: boolean;
  readonly es_before: boolean;
  readonly en_insert: boolean;
  readonly en_update: boolean;
  readonly en_delete: boolean;
  readonly funcion: string;
}
interface FilaMigracion {
  readonly id: number;
  readonly hash: string;
  readonly aplicada_en: string | null;
}

async function principal(): Promise<void> {
  // Las guardas corren al cargar el módulo, igual que para drizzle-kit.
  // Solo lectura (o sin COMMIT): admite también la rama del seed, para validar
  // que sus migraciones dejan el esquema v1 exacto (ADR 0009 §9).
  // Con `--production` (ADR 0010): sus guardas; solo lectura, sin autorización.
  let destino: {
    readonly url: string;
    readonly hostname: string;
    readonly rama: string;
  };
  if (process.argv.includes("--production")) {
    destino = destinoDeProduction();
  } else {
    const { RAMAS_DE_VALIDACION, verificarDestino } =
      await import("../drizzle.migrate.config.ts");
    destino = verificarDestino(process.env, RAMAS_DE_VALIDACION);
  }

  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(destino.url);

  console.log("VALIDACIÓN DEL ESQUEMA v1 CONTRA POSTGRESQL — solo lectura\n");
  console.log(`  hostname          ${destino.hostname}`);
  console.log(`  conexión directa  sí (sin "-pooler")`);
  console.log(`  MIGRATION_TARGET  ${destino.rama}`);

  const version = (await sql`
    SELECT current_setting('server_version') AS nombre
  `) as unknown as readonly FilaNombre[];
  const baseDatos = (await sql`
    SELECT current_database() AS nombre
  `) as unknown as readonly FilaNombre[];
  console.log(`  PostgreSQL        ${version[0]?.nombre ?? "?"}`);
  console.log(`  base de datos     ${baseDatos[0]?.nombre ?? "?"}`);

  // 1 ─ Tablas ──────────────────────────────────────────────────────────────
  seccion("1 · Tablas");
  const tablas = (await sql`
    SELECT c.relname AS nombre
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY 1
  `) as unknown as readonly FilaNombre[];
  const nombresTabla = tablas.map((t) => t.nombre);

  // A propósito NO se cuenta el total: la rama hereda `spike_ping` de
  // production y Drizzle guarda su journal en su propio schema.
  const faltanTablas = TABLAS.filter((t) => !nombresTabla.includes(t));
  comprobar(
    `las ${String(TABLAS.length)} tablas del modelo existen`,
    faltanTablas.length === 0,
    faltanTablas.length > 0 ? `faltan: ${faltanTablas.join(", ")}` : "",
  );

  const ajenas = nombresTabla.filter((t) => !TABLAS.some((e) => e === t));
  if (ajenas.length > 0) {
    for (const t of ajenas) {
      const motivo = AJENAS_CONOCIDAS[t];
      informar(
        motivo === undefined
          ? `tabla ajena al modelo, sin origen conocido: ${t}`
          : `${t} — ${motivo} (esperada, no es un fallo)`,
      );
    }
  }

  // 2 ─ Enums ───────────────────────────────────────────────────────────────
  seccion("2 · Enums y sus labels");
  const enums = (await sql`
    SELECT t.typname AS nombre,
           string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
    GROUP BY t.typname
    ORDER BY 1
  `) as unknown as readonly FilaEnum[];

  const esperadosEnum = Object.keys(ENUMS).sort();
  comprobar(
    `hay 10 enums, y son los esperados`,
    enums.length === esperadosEnum.length &&
      diferencia(
        esperadosEnum,
        enums.map((e) => e.nombre),
      ) === "",
    `observados ${enums.length}\n${diferencia(
      esperadosEnum,
      enums.map((e) => e.nombre),
    )}`,
  );
  for (const nombre of esperadosEnum) {
    const esperado = (ENUMS[nombre] ?? []).join(",");
    const observado = enums.find((e) => e.nombre === nombre)?.labels;
    comprobar(
      `${nombre} — ${esperado.split(",").length} labels, en orden`,
      observado === esperado,
      `esperado:  ${esperado}\nobservado: ${observado ?? "(el enum no existe)"}`,
    );
  }
  comprobar(
    `no existe el enum ranking_kind, eliminado a propósito`,
    !enums.some((e) => e.nombre === "ranking_kind"),
  );

  // 3 ─ UNIQUE con NULLS NOT DISTINCT ───────────────────────────────────────
  seccion("3 · UNIQUE con NULLS NOT DISTINCT");
  const unicos = (await sql`
    SELECT con.conname AS nombre,
           i.indnullsnotdistinct AS nnd,
           (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
              FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a
                ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS columnas
    FROM pg_constraint con
    JOIN pg_index i ON i.indexrelid = con.conindid
    JOIN pg_namespace n ON n.oid = con.connamespace
    WHERE con.contype = 'u' AND n.nspname = 'public'
    ORDER BY 1
  `) as unknown as readonly FilaUnico[];

  const conNnd = unicos.filter((u) => u.nnd);
  comprobar(
    `exactamente ${String(Object.keys(UNICOS_NND).length)} únicos llevan NULLS NOT DISTINCT`,
    conNnd.length === Object.keys(UNICOS_NND).length,
    `observados ${conNnd.length}: ${conNnd.map((u) => u.nombre).join(", ")}`,
  );
  for (const [nombre, columnas] of Object.entries(UNICOS_NND)) {
    const fila = unicos.find((u) => u.nombre === nombre);
    comprobar(
      `${nombre} — NND sobre (${columnas})`,
      fila?.nnd === true && fila.columnas === columnas,
      fila === undefined
        ? "el constraint no existe"
        : `nnd=${String(fila.nnd)}\nesperado:  ${columnas}\nobservado: ${fila.columnas ?? "?"}`,
    );
  }

  // 4 ─ CHECK ───────────────────────────────────────────────────────────────
  seccion("4 · CHECK constraints");
  const checks = (await sql`
    SELECT con.conname AS nombre,
           pg_get_constraintdef(con.oid) AS definicion
    FROM pg_constraint con
    JOIN pg_namespace n ON n.oid = con.connamespace
    JOIN pg_class c ON c.oid = con.conrelid
    WHERE con.contype = 'c' AND n.nspname = 'public'
      AND c.relname <> 'spike_ping'
    ORDER BY 1
  `) as unknown as readonly FilaCheck[];
  const nombresCheck = checks.map((c) => c.nombre);
  comprobar(
    `los ${String(CHECKS.length)} CHECK del modelo existen, y no hay otros`,
    nombresCheck.length === CHECKS.length &&
      diferencia([...CHECKS], nombresCheck) === "",
    `observados ${nombresCheck.length}\n${diferencia([...CHECKS], nombresCheck)}`,
  );

  // Que el nombre esté no dice nada de la condición. Un CHECK bien nombrado y
  // mal escrito pasaría desapercibido, y el de `rating` es justamente el que
  // impide que el `0` del proveedor entre como si fuera una valoración.
  const declarados = checksDeLaMigracion();
  comprobar(
    `las migraciones declaran los ${String(CHECKS.length)} CHECK`,
    declarados.size === CHECKS.length,
    `extraídos del .sql: ${declarados.size}`,
  );

  for (const nombre of CHECKS) {
    const enMigracion = declarados.get(nombre);
    const enPostgres = checks.find((c) => c.nombre === nombre)?.definicion;

    if (enMigracion === undefined || enPostgres === undefined) {
      comprobar(
        `${nombre} — expresión`,
        false,
        enMigracion === undefined
          ? "no aparece en ninguna migración"
          : "no existe en PostgreSQL",
      );
      continue;
    }

    const izquierda = normalizarExpresion(enMigracion);
    const derecha = normalizarExpresion(enPostgres);
    comprobar(
      `${nombre} — expresión`,
      izquierda === derecha,
      `migraciones:     ${izquierda}\n` +
        `PostgreSQL:      ${derecha}\n` +
        `(crudo en PG)    ${enPostgres}`,
    );
  }

  // 5 ─ Claves ajenas y su ON DELETE ────────────────────────────────────────
  seccion("5 · Claves ajenas y su ON DELETE");
  // Se identifican por FORMA, nunca por nombre: PostgreSQL trunca los
  // identificadores a 63 bytes y cuatro de los que genera Drizzle se pasan.
  const fks = (await sql`
    SELECT con.conname AS nombre,
           cl.relname AS tabla,
           (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
              FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a
                ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS columnas,
           cf.relname AS tabla_destino,
           (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
              FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a
                ON a.attrelid = con.confrelid
               AND a.attnum = k.attnum) AS columnas_destino,
           con.confdeltype AS accion
    FROM pg_constraint con
    JOIN pg_class cl ON cl.oid = con.conrelid
    JOIN pg_class cf ON cf.oid = con.confrelid
    JOIN pg_namespace n ON n.oid = con.connamespace
    WHERE con.contype = 'f' AND n.nspname = 'public'
    ORDER BY 2, 3
  `) as unknown as readonly FilaClaveAjena[];

  const esperadasFk = Object.keys(CLAVES_AJENAS).sort();
  const observadasFk = fks.map(identidadDeClaveAjena);

  comprobar(
    `hay ${String(TOTAL_DE_CLAVES_AJENAS)} claves ajenas`,
    fks.length === TOTAL_DE_CLAVES_AJENAS,
    `observadas ${fks.length}`,
  );
  comprobar(
    `las ${String(TOTAL_DE_CLAVES_AJENAS)} relaciones estructurales son las esperadas`,
    diferencia(esperadasFk, observadasFk) === "",
    diferencia(esperadasFk, observadasFk),
  );

  // Una relación duplicada no se vería comparando conjuntos.
  const duplicadas = esperadasFk.filter(
    (e) => observadasFk.filter((o) => o === e).length !== 1,
  );
  comprobar(
    `cada relación existe exactamente una vez`,
    duplicadas.length === 0,
    duplicadas
      .map((d) => `${d}: aparece ${observadasFk.filter((o) => o === d).length} veces`)
      .join("\n"),
  );

  const recuento = { cascade: 0, restrict: 0, "set null": 0 };
  let accionesCorrectas = true;
  const desviadas: string[] = [];
  for (const [identidad, esperada] of Object.entries(CLAVES_AJENAS)) {
    const fila = fks.find((f) => identidadDeClaveAjena(f) === identidad);
    const observada =
      fila === undefined ? "(no existe)" : (ACCIONES_DE_BORRADO[fila.accion] ?? "?");
    if (observada !== esperada) {
      accionesCorrectas = false;
      desviadas.push(`${identidad}: esperada ${esperada}, observada ${observada}`);
    } else if (observada === "cascade" || observada === "restrict") {
      recuento[observada]++;
    } else if (observada === "set null") {
      recuento["set null"]++;
    }
  }
  comprobar(`cada ON DELETE es el declarado`, accionesCorrectas, desviadas.join("\n"));
  comprobar(
    `reparto ${String(REPARTO_ESPERADO.cascade)} cascade · ${String(REPARTO_ESPERADO.restrict)} restrict · ${String(REPARTO_ESPERADO["set null"])} set null`,
    recuento.cascade === REPARTO_ESPERADO.cascade &&
      recuento.restrict === REPARTO_ESPERADO.restrict &&
      recuento["set null"] === REPARTO_ESPERADO["set null"],
    `observado ${recuento.cascade} cascade · ${recuento.restrict} restrict · ${recuento["set null"]} set null`,
  );

  // El cerrojo que hace ejecutable la retención en dos pasos.
  const posiciones = fks.find(
    (f) => identidadDeClaveAjena(f) === RETENCION_EN_DOS_PASOS,
  );
  comprobar(
    `list_positions → captures es RESTRICT, no CASCADE`,
    posiciones !== undefined && ACCIONES_DE_BORRADO[posiciones.accion] === "restrict",
    `una cascada aquí disparíar el trigger de las posiciones y abortaría la retención`,
  );

  // Informativo: cuántos nombres perdió PostgreSQL por el camino, y la
  // constancia de que eso ya no invalida nada.
  const declaradosFk = clavesAjenasDeLaMigracion();
  const largos = declaradosFk.filter((d) => d.length > LIMITE_DE_IDENTIFICADOR);
  const truncadas = fks.filter(
    (f) =>
      f.nombre.length === LIMITE_DE_IDENTIFICADOR &&
      largos.some((d) => d.startsWith(f.nombre)),
  );
  informar(
    `PostgreSQL truncó ${truncadas.length} de ${String(TOTAL_DE_CLAVES_AJENAS)} nombres a ${LIMITE_DE_IDENTIFICADOR} bytes;` +
      ` la migración declara ${largos.length} por encima del límite`,
  );
  for (const f of truncadas) {
    informar(`    ${f.nombre}… → ${identidadDeClaveAjena(f)}`);
  }
  comprobar(
    `los nombres truncados no provocan falsos negativos`,
    truncadas.length === largos.length &&
      truncadas.every((f) => esperadasFk.includes(identidadDeClaveAjena(f))),
    `truncados ${truncadas.length}, declarados por encima del límite ${largos.length}`,
  );
  // 6 ─ Índices ─────────────────────────────────────────────────────────────
  seccion("6 · Índices propios del esquema");
  const indices = (await sql`
    SELECT i.relname AS nombre
    FROM pg_class i
    JOIN pg_index x ON x.indexrelid = i.oid
    JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = i.relnamespace
    WHERE n.nspname = 'public' AND i.relkind = 'i'
      AND NOT x.indisunique AND NOT x.indisprimary
      AND t.relname <> 'spike_ping'
    ORDER BY 1
  `) as unknown as readonly FilaNombre[];
  const nombresIndice = indices.map((i) => i.nombre);
  comprobar(
    `los ${String(INDICES.length)} índices existen, y no hay otros`,
    nombresIndice.length === INDICES.length &&
      diferencia([...INDICES], nombresIndice) === "",
    `observados ${nombresIndice.length}\n${diferencia([...INDICES], nombresIndice)}`,
  );

  // 7 ─ La función de inmutabilidad ─────────────────────────────────────────
  seccion("7 · Función de inmutabilidad");
  const funciones = (await sql`
    SELECT p.proname AS nombre,
           l.lanname AS lenguaje,
           pg_get_function_result(p.oid) AS retorno
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    WHERE n.nspname = 'public' AND p.proname = ${FUNCION_INMUTABILIDAD}
  `) as unknown as readonly FilaFuncion[];
  const funcion = funciones[0];
  comprobar(
    `${FUNCION_INMUTABILIDAD}() existe y devuelve trigger`,
    funcion?.retorno === "trigger",
    funcion === undefined
      ? "no existe: la migración 0001 no se ha aplicado"
      : `retorno observado: ${funcion.retorno}`,
  );

  // 8 ─ Triggers ────────────────────────────────────────────────────────────
  seccion("8 · Triggers, y su asimetría");
  const triggers = (await sql`
    SELECT t.tgname AS nombre,
           c.relname AS tabla,
           (t.tgtype & 1)  <> 0 AS por_fila,
           (t.tgtype & 2)  <> 0 AS es_before,
           (t.tgtype & 4)  <> 0 AS en_insert,
           (t.tgtype & 16) <> 0 AS en_update,
           (t.tgtype & 8)  <> 0 AS en_delete,
           p.proname AS funcion
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE NOT t.tgisinternal AND n.nspname = 'public'
    ORDER BY 1
  `) as unknown as readonly FilaTrigger[];

  const esperadosTrigger = Object.keys(TRIGGERS).sort();
  comprobar(
    `hay exactamente 3 triggers, y son los esperados`,
    triggers.length === 3 &&
      diferencia(
        esperadosTrigger,
        triggers.map((t) => t.nombre),
      ) === "",
    `observados ${triggers.length}\n${diferencia(
      esperadosTrigger,
      triggers.map((t) => t.nombre),
    )}`,
  );

  for (const [nombre, esperado] of Object.entries(TRIGGERS)) {
    const t = triggers.find((x) => x.nombre === nombre);
    if (t === undefined) {
      comprobar(`${nombre} — ${esperado.operaciones}`, false, "no existe");
      continue;
    }
    const ops: string[] = [];
    if (t.en_delete) ops.push("DELETE");
    if (t.en_insert) ops.push("INSERT");
    if (t.en_update) ops.push("UPDATE");
    const observado = `${t.es_before ? "BEFORE" : "AFTER"} ${
      t.por_fila ? "ROW" : "STATEMENT"
    }: ${ops.join(", ")}`;
    comprobar(
      `${nombre} — ${esperado.operaciones}`,
      t.tabla === esperado.tabla &&
        observado === esperado.operaciones &&
        t.funcion === FUNCION_INMUTABILIDAD,
      `tabla:     ${t.tabla} (esperada ${esperado.tabla})\n` +
        `observado: ${observado}\n` +
        `función:   ${t.funcion}`,
    );
  }

  // La corrección que hace ejecutable la retención: si capturas o posiciones
  // bloquearan el DELETE, la poda de 180 días sería imposible.
  const bloqueanDelete = triggers.filter((t) => t.en_delete).map((t) => t.tabla);
  comprobar(
    `solo eventos bloquea el DELETE; capturas y posiciones se podan`,
    bloqueanDelete.length === 1 &&
      bloqueanDelete.at(0) === "external_availability_events",
    `bloquean DELETE: ${bloqueanDelete.join(", ")}`,
  );

  // 9 ─ Journal de Drizzle ──────────────────────────────────────────────────
  seccion("9 · Journal de migraciones aplicadas");
  // Si el journal no existiera, la consulta revienta. Se captura para que el
  // informe termine con un ❌ legible en vez de con un volcado de pila.
  let aplicadas: readonly FilaMigracion[] = [];
  try {
    aplicadas = (await sql`
      SELECT id, hash, created_at::text AS aplicada_en
      FROM drizzle.__drizzle_migrations
      ORDER BY id
    `) as unknown as readonly FilaMigracion[];
  } catch {
    comprobar(
      "drizzle.__drizzle_migrations existe",
      false,
      "no se puede leer: ninguna migración se ha aplicado en esta rama",
    );
  }

  const journalLocal: unknown = JSON.parse(
    readFileSync(join(DIRECTORIO_MIGRACIONES, "meta", "_journal.json"), "utf8"),
  );
  const locales = (journalLocal as { entries: { tag: string }[] }).entries;

  comprobar(
    `Neon registra ${locales.length} migraciones aplicadas`,
    aplicadas.length === locales.length,
    `locales ${locales.length}, aplicadas ${aplicadas.length}`,
  );
  for (const [i, entrada] of locales.entries()) {
    const fila = aplicadas[i];
    comprobar(
      `${entrada.tag}`,
      fila !== undefined,
      "no consta como aplicada en la rama",
    );
  }

  // ── Veredicto ────────────────────────────────────────────────────────────
  console.log("");
  if (fallos === 0) {
    console.log("✅ El esquema en PostgreSQL coincide con el modelo v1 aprobado.");
  } else {
    console.log(`❌ ${fallos} comprobación(es) no coinciden con el modelo v1.`);
    process.exitCode = 1;
  }
}

// Solo se ejecuta si se invoca directamente. Así `normalizarExpresion` y
// `checksDeLaMigracion` se pueden importar y probar **sin abrir conexión**.
const invocadoDirectamente =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invocadoDirectamente) {
  principal().catch((error: unknown) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
