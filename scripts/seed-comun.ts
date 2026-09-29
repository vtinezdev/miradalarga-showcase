/**
 * Lo común a los scripts del seed que tocan una base (`seed:cargar`,
 * `seed:validar`, `seed:validar:primer-deltas`).
 *
 *   · **Solo las ramas del seed.** `verificarDestino` con las dos ramas del
 *     seed: nunca la histórica. Con `--production` (ADR 0010), **solo**
 *     `production`, por sus propias guardas (`destino-production.ts`). El
 *     régimen tiene que ser el estricto (`bootstrap_del_seed`): un destino con
 *     ancla.
 *   · **Sin credencial de la API en el proceso.** Se borra de `process.env`
 *     antes de nada: la carga tiene 0 requests por construcción (no importa el
 *     transporte), y además no tendría con qué autenticarse.
 *   · **Migraciones exactas `0000`–`0004`**, por nombre, `created_at` y hash
 *     del fichero: ni una de menos, ni una de más, ni una distinta.
 *   · **El reloj es el del servidor** (`now()`), el dominio de `finished_at`
 *     (ADR 0009 §7).
 *
 * Nunca se imprime la cadena de conexión.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { DESTINO_PRODUCTION } from "../destino-production.ts";
import type { EjecutorSql } from "../jobs/ops/contratos.ts";
import { regimenDelDestino } from "../jobs/pipelines/arranque.ts";
import { leerDirectorioDelCrudo } from "../jobs/pipelines/seed/crudo/disco.ts";
import type { CrudoVerificado } from "../jobs/pipelines/seed/crudo/verificar.ts";
import { destinoDeProduction } from "./production-comun.ts";
import {
  describirVerificacion,
  verificarCrudo,
} from "../jobs/pipelines/seed/crudo/verificar.ts";

const RAIZ = resolve(import.meta.dirname, "..");

/** Donde quedan los informes de cada carga y validación. Fuera de git. */
export const DIRECTORIO_DE_INFORMES = join(RAIZ, ".seed-cargas");

/** Las migraciones de la v1, **exactamente**. */
export const MIGRACIONES_ESPERADAS = [
  "0000_chilly_jackpot",
  "0001_immutable_history_triggers",
  "0002_checkpoint_de_reanudacion",
  "0003_anuncios_de_disponibilidad",
  "0004_imdb_id_no_vacio",
] as const;

/** Las 15 tablas del modelo v1. `spike_ping` no es del modelo. */
export const TABLAS_V1 = [
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

/** Las que el seed **no** escribe y en la rama del seed tienen que seguir vacías. */
export const TABLAS_AJENAS_AL_SEED = [
  "derived_ranking_definitions",
  "derived_ranking_entries",
  "external_availability_announcements",
  "external_availability_events",
  "external_list_captures",
  "external_list_positions",
] as const;

export interface DestinoDelSeed {
  readonly url: string;
  readonly hostname: string;
  readonly rama: string;
}

/**
 * **Qué crudo va a qué rama** (ADR 0009 §9). Un crudo de ensayo —cuerpos del
 * Spike, M1 sintética— **solo** a la rama del ensayo; un crudo real **solo** a
 * la rama limpia del seed real. Mezclarlos daría un destino que no reproduce
 * `production` o un catálogo de ensayo mantenido por `deltas` de verdad.
 */
export function exigirCrudoParaRama(esEnsayo: boolean, rama: string): void {
  if (rama === DESTINO_PRODUCTION) {
    // A production solo va un crudo real, y solo tras la compuerta (ADR 0010).
    if (esEnsayo) throw new Error("Un crudo de ensayo nunca se carga en production.");
    return;
  }
  const esperada = esEnsayo ? "seed-bootstrap-v1-test" : "seed-real-v1-test";
  if (rama !== esperada) {
    throw new Error(
      `Un crudo ${esEnsayo ? "de ensayo" : "real"} solo se carga en ${esperada}, no en ${rama}.`,
    );
  }
}

/**
 * Las guardas, antes de abrir ningún socket. Con `production`, las de
 * `destino-production.ts` —solo las de entorno: la autorización en código la
 * exige cada script cuando ya conoce la huella del crudo— y **nunca** las de
 * validación, cuyo módulo aborta en una sesión de `production`.
 */
export async function destinoDelSeed(production = false): Promise<DestinoDelSeed> {
  // La carga no necesita la credencial de la API: que no esté ni en memoria.
  delete process.env.STREAMING_AVAILABILITY_API_KEY;
  if (production) {
    const destino = destinoDeProduction();
    if (regimenDelDestino(destino.rama) !== "bootstrap_del_seed") {
      throw new Error(`${destino.rama} no está en el régimen estricto del seed.`);
    }
    console.log(`  régimen           bootstrap_del_seed (estricto)`);
    console.log(`  credencial API    no cargada en este proceso`);
    return { url: destino.url, hostname: destino.hostname, rama: destino.rama };
  }
  const { RAMA_DEL_SEED, RAMA_DEL_SEED_REAL, verificarDestino } =
    await import("../drizzle.migrate.config.ts");
  const destino = verificarDestino(process.env, [RAMA_DEL_SEED, RAMA_DEL_SEED_REAL]);
  if (regimenDelDestino(destino.rama) !== "bootstrap_del_seed") {
    throw new Error(`${destino.rama} no está en el régimen estricto del seed.`);
  }
  if (typeof WebSocket === "undefined") {
    throw new Error("Este Node no expone WebSocket global y Neon lo necesita.");
  }
  console.log(`  hostname          ${destino.hostname}`);
  console.log(`  MIGRATION_TARGET  ${destino.rama}`);
  console.log(`  régimen           bootstrap_del_seed (estricto)`);
  console.log(`  credencial API    no cargada en este proceso`);
  return { url: destino.url, hostname: destino.hostname, rama: destino.rama };
}

/** Lee y verifica el crudo; sin él íntegro y cargable no hay nada que hacer. */
export function crudoCargable(directorio: string): CrudoVerificado {
  const resultado = verificarCrudo(leerDirectorioDelCrudo(directorio));
  for (const linea of describirVerificacion(resultado)) console.log(`  ${linea}`);
  if (!resultado.ok || resultado.crudo === null) {
    throw new Error("El crudo no pasa seed:verificar: no se carga ni se valida.");
  }
  if (!resultado.crudo.cargable) {
    throw new Error(
      `El crudo es íntegro pero no cargable (${resultado.crudo.motivoNoCargable ?? "?"}).`,
    );
  }
  return resultado.crudo;
}

export interface InstanteDelServidor {
  readonly ahora: Date;
  readonly version: string;
}

/** `now()` y la versión de PostgreSQL: el reloj que decide el ancla. */
export async function instanteDelServidor(
  ejecutor: EjecutorSql,
): Promise<InstanteDelServidor> {
  const [fila] = await ejecutor.ejecutar<{ ahora: Date | string; version: string }>(
    "SELECT now() AS ahora, current_setting('server_version') AS version",
  );
  if (fila === undefined) throw new Error("El servidor no devolvió now().");
  return { ahora: new Date(fila.ahora), version: fila.version };
}

export interface MigracionAplicada {
  readonly tag: string;
  readonly when: number;
  readonly hashCoincide: boolean;
}

export interface EstadoDeMigraciones {
  readonly exactas: boolean;
  readonly aplicadas: readonly MigracionAplicada[];
  readonly pendientes: number;
  readonly problemas: readonly string[];
}

interface EntradaDelJournal {
  readonly tag: string;
  readonly when: number;
}

/**
 * **Exactamente `0000`–`0004`** en el journal local **y** en la rama: mismo
 * número, mismo `created_at` (el `when` del journal) y mismo hash del fichero
 * que drizzle registró al aplicarlo. Solo lectura.
 */
export async function comprobarMigraciones(
  ejecutor: EjecutorSql,
): Promise<EstadoDeMigraciones> {
  const problemas: string[] = [];
  const journal = (
    JSON.parse(
      readFileSync(join(RAIZ, "drizzle", "meta", "_journal.json"), "utf8"),
    ) as { entries: EntradaDelJournal[] }
  ).entries;
  const tags = journal.map((e) => e.tag);
  if (JSON.stringify(tags) !== JSON.stringify(MIGRACIONES_ESPERADAS)) {
    problemas.push(`el journal local no es exactamente 0000–0004: ${tags.join(", ")}`);
  }

  const [existe] = await ejecutor.ejecutar<{ existe: boolean }>(
    "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS existe",
  );
  const filas =
    existe?.existe === true
      ? await ejecutor.ejecutar<{ hash: string; created_at: string | number }>(
          "SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id",
        )
      : [];

  const aplicadas: MigracionAplicada[] = [];
  journal.forEach((entrada, i) => {
    const fila = filas[i];
    if (fila === undefined) return;
    const texto = readFileSync(join(RAIZ, "drizzle", `${entrada.tag}.sql`)).toString();
    const hash = createHash("sha256").update(texto).digest("hex");
    const when = Number(fila.created_at);
    if (when !== entrada.when) {
      problemas.push(`la migración ${String(i + 1)} de la rama no es ${entrada.tag}`);
    }
    aplicadas.push({ tag: entrada.tag, when, hashCoincide: fila.hash === hash });
    if (fila.hash !== hash) problemas.push(`${entrada.tag}: el hash no coincide`);
  });
  if (filas.length > journal.length) {
    problemas.push(
      `la rama tiene ${String(filas.length)} migraciones aplicadas, más que el journal`,
    );
  }
  const pendientes = Math.max(0, journal.length - filas.length);
  if (pendientes > 0) problemas.push(`${String(pendientes)} migraciones pendientes`);
  return { exactas: problemas.length === 0, aplicadas, pendientes, problemas };
}

/** Filas de cada una de las 15 tablas. */
export async function recuentoPorTabla(
  ejecutor: EjecutorSql,
): Promise<Record<string, number>> {
  const sql = TABLAS_V1.map(
    (t) => `SELECT '${t}' AS tabla, count(*)::int AS filas FROM ${t}`,
  ).join(" UNION ALL ");
  const filas = await ejecutor.ejecutar<{ tabla: string; filas: number }>(sql);
  return Object.fromEntries(filas.map((f) => [f.tabla, Number(f.filas)]));
}

/**
 * **La huella de los ids**: sha256 de `clave natural → id` en las cuatro tablas
 * con identidad propia. Dos lecturas con la misma huella = ningún id bailó.
 */
export async function huellaDeIds(ejecutor: EjecutorSql): Promise<string> {
  const partes = await ejecutor.ejecutar<{ k: string }>(`
    SELECT 't|' || imdb_id || '=' || id AS k FROM external_titles
    UNION ALL
    SELECT 'i|' || t.imdb_id || '|' || i.type || '|' || i.width || '|' || coalesce(i.language, '∅')
           || '=' || i.id
      FROM external_title_images i JOIN external_titles t ON t.id = i.title_id
    UNION ALL
    SELECT 'a|' || t.imdb_id || '|' || a.platform_id || '|' || a.country || '|' || a.offer_type
           || '|' || coalesce(a.addon, '∅') || '=' || a.id
      FROM external_availability a JOIN external_titles t ON t.id = a.title_id
    UNION ALL
    SELECT 'o|' || o.availability_id || '|' || o.link || '|' || coalesce(o.quality::text, '∅')
           || '=' || o.id
      FROM external_availability_options o`);
  const claves = partes.map((p) => p.k).sort();
  return createHash("sha256").update(claves.join("\n")).digest("hex");
}

/** Escribe un informe JSON en `.seed-cargas/`. Nunca lleva secretos. */
export function guardarInforme(nombre: string, informe: unknown): string {
  mkdirSync(DIRECTORIO_DE_INFORMES, { recursive: true });
  const ruta = join(
    DIRECTORIO_DE_INFORMES,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${nombre}.json`,
  );
  writeFileSync(ruta, `${JSON.stringify(informe, null, 2)}\n`, "utf8");
  return ruta;
}
