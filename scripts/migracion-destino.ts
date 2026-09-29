/**
 * **El camino de migración de `production`**, y su ensayo idéntico en la rama
 * del seed real (ADR 0010). Lo usan `db:preflight:production` y
 * `db:migrate:production`.
 *
 * ⚖️ **Un solo camino, dos destinos.** La migración de `production` no puede
 * ensayarse en `production`; se ensaya **el mismo código** contra
 * la rama del seed real, que deriva de `production` y está en el mismo estado
 * (solo `spike_ping`, 0 migraciones). Solo cambia la guarda de destino.
 *
 * Aplica las migraciones con el **mismo migrador que usa `drizzle-kit
 * migrate`** con el driver de Neon (`drizzle-orm/neon-serverless/migrator`,
 * comprobado en `node_modules/drizzle-kit/bin.cjs`): mismo registro en
 * `drizzle.__drizzle_migrations` (hash sha256 del fichero, `created_at` = el
 * `when` del journal) y **todas las pendientes en una sola transacción**: si
 * una sentencia falla, no queda ninguna aplicada.
 *
 * Antes de escribir decide, con una lectura, si el destino es migrable:
 *
 *   · **virgen** — 0 migraciones y ninguna tabla en `public` salvo
 *     `spike_ping` → se aplican `0000`–`0004`;
 *   · **exacta** — exactamente `0000`–`0004`, mismos hashes y `created_at` →
 *     no hay nada que hacer (idempotente);
 *   · **cualquier otra cosa** → se niega sin escribir: un estado parcial,
 *     tablas ajenas o migraciones de más los mira una persona.
 *
 * Nunca se imprime la cadena de conexión.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { Client, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { migrate } from "drizzle-orm/neon-serverless/migrator";

import type { EjecutorSql } from "../jobs/ops/contratos.ts";
import { sanearTexto } from "../jobs/ops/diagnostico.ts";
import { MIGRACIONES_ESPERADAS, TABLAS_V1 } from "./seed-comun.ts";
import { RAIZ } from "./seed-referencias.ts";

export const DIRECTORIO_DE_MIGRACIONES = join(RAIZ, "drizzle");

/** La única tabla ajena al modelo que un destino virgen puede tener. */
export const TABLA_HEREDADA = "spike_ping";

export interface MigracionLocal {
  readonly tag: string;
  /** `when` del journal: lo que drizzle guarda como `created_at`. */
  readonly when: number;
  /** sha256 del fichero `.sql`: lo que drizzle guarda como `hash`. */
  readonly hash: string;
}

/** Las migraciones del repositorio. Lanza si no son exactamente `0000`–`0004`. */
export function migracionesLocales(
  directorio: string = DIRECTORIO_DE_MIGRACIONES,
): readonly MigracionLocal[] {
  const journal = (
    JSON.parse(readFileSync(join(directorio, "meta", "_journal.json"), "utf8")) as {
      entries: { tag: string; when: number }[];
    }
  ).entries;
  const tags = journal.map((e) => e.tag);
  if (JSON.stringify(tags) !== JSON.stringify(MIGRACIONES_ESPERADAS)) {
    throw new Error(`El journal no es exactamente 0000–0004: ${tags.join(", ")}`);
  }
  const sql = readdirSync(directorio).filter((f) => f.endsWith(".sql"));
  if (sql.length !== journal.length) {
    throw new Error(
      `Descuadre: ${String(sql.length)} ficheros .sql y ${String(journal.length)} en el journal.`,
    );
  }
  return journal.map((e) => ({
    tag: e.tag,
    when: e.when,
    hash: createHash("sha256")
      .update(readFileSync(join(directorio, `${e.tag}.sql`)).toString())
      .digest("hex"),
  }));
}

/** Lo que se lee del destino antes de decidir. */
export interface EstadoParaMigrar {
  readonly tablasPublicas: readonly string[];
  /** Las filas de `drizzle.__drizzle_migrations`, por `id`. Vacío si no existe. */
  readonly aplicadas: readonly { readonly hash: string; readonly createdAt: number }[];
}

export type DecisionDeMigracion =
  | { readonly tipo: "aplicar"; readonly pendientes: readonly string[] }
  | { readonly tipo: "nada" }
  | { readonly tipo: "negada"; readonly motivo: string };

/** Función pura: ¿se puede migrar este destino, y qué? */
export function decidirMigracion(
  estado: EstadoParaMigrar,
  locales: readonly MigracionLocal[],
): DecisionDeMigracion {
  const ajenas = estado.tablasPublicas.filter((t) => t !== TABLA_HEREDADA);
  if (estado.aplicadas.length === 0) {
    if (ajenas.length > 0) {
      return {
        tipo: "negada",
        motivo: `sin migraciones pero con tablas en public (${ajenas.join(", ")}): no es un destino virgen`,
      };
    }
    return { tipo: "aplicar", pendientes: locales.map((m) => m.tag) };
  }
  const exacta =
    estado.aplicadas.length === locales.length &&
    locales.every(
      (m, i) =>
        estado.aplicadas[i]?.hash === m.hash &&
        estado.aplicadas[i]?.createdAt === m.when,
    );
  if (exacta) {
    const faltan = TABLAS_V1.filter((t) => !estado.tablasPublicas.includes(t));
    if (faltan.length > 0) {
      return {
        tipo: "negada",
        motivo: `migraciones registradas pero faltan tablas del modelo: ${faltan.join(", ")}`,
      };
    }
    return { tipo: "nada" };
  }
  return {
    tipo: "negada",
    motivo:
      `el destino tiene ${String(estado.aplicadas.length)} migraciones que no son ` +
      `exactamente las ${String(locales.length)} del repositorio: estado parcial o distinto`,
  };
}

/** Lee el estado del destino. Solo `SELECT`. */
export async function leerEstadoParaMigrar(e: EjecutorSql): Promise<EstadoParaMigrar> {
  const tablas = await e.ejecutar<{ t: string }>(
    `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1`,
  );
  const [existe] = await e.ejecutar<{ existe: boolean }>(
    "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS existe",
  );
  const aplicadas =
    existe?.existe === true
      ? await e.ejecutar<{ hash: string; created_at: string | number }>(
          "SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id",
        )
      : [];
  return {
    tablasPublicas: tablas.map((f) => f.t),
    aplicadas: aplicadas.map((f) => ({
      hash: f.hash,
      createdAt: Number(f.created_at),
    })),
  };
}

export interface SesionDeMigracion {
  readonly ejecutor: EjecutorSql;
  /** Aplica las pendientes con el migrador de drizzle, en una transacción. */
  aplicar(): Promise<void>;
  cerrar(): Promise<void>;
}

/** Una sesión directa (WebSocket), la que usa `drizzle-kit migrate` con Neon. */
export async function abrirSesion(url: string): Promise<SesionDeMigracion> {
  if (typeof WebSocket === "undefined") {
    throw new Error("Este Node no expone WebSocket global y Neon lo necesita.");
  }
  neonConfig.webSocketConstructor = WebSocket;
  const cliente = new Client(url);
  cliente.on("error", () => undefined);
  try {
    await cliente.connect();
  } catch (error) {
    throw new Error(
      `No se pudo conectar: ${sanearTexto(error instanceof Error ? error.message : String(error))}`,
    );
  }
  return {
    ejecutor: {
      async ejecutar<T>(texto: string, valores: readonly unknown[] = []) {
        const r: { rows: unknown[] } = await cliente.query(texto, [...valores]);
        return r.rows as readonly T[];
      },
    },
    async aplicar() {
      await migrate(drizzle(cliente), { migrationsFolder: DIRECTORIO_DE_MIGRACIONES });
    },
    async cerrar() {
      await cliente.end().catch(() => undefined);
    },
  };
}

/** Describe una decisión en una línea. */
export function describirDecision(d: DecisionDeMigracion): string {
  switch (d.tipo) {
    case "aplicar":
      return `destino virgen: se aplicarían ${String(d.pendientes.length)} migraciones (${d.pendientes.join(", ")})`;
    case "nada":
      return "ya tiene exactamente 0000–0004: nada que aplicar";
    case "negada":
      return `NEGADA: ${d.motivo}`;
  }
}
