/**
 * El contrato de mínimo privilegio del rol de solo lectura del runtime web
 * (`docs/04-lectura-del-catalogo.md`, sección «Permisos mínimos del rol de lectura»), **sin base de datos**.
 *
 * El rol aún no existe. Cuando se cree, este es el único `GRANT SELECT` que la
 * web necesita: lo que `catalogo-sql.ts` de verdad lee. Si una consulta nueva
 * toca otra tabla, o otra columna de `ops_sync_runs`, este test falla antes de
 * que la ficha, el radar o la portada den «permiso denegado» en producción; y
 * si alguien concede de más, el contrato ya dice qué sobra.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import * as esquema from "../../src/db/schema/index.ts";

/** Tablas del catálogo que la web lee: `SELECT` de tabla completa. */
const TABLAS_DEL_CATALOGO = [
  "external_availability",
  "external_availability_announcements",
  "external_availability_events",
  "external_availability_options",
  "external_genres",
  "external_platform_capabilities",
  "external_platforms",
  "external_title_genres",
  "external_title_images",
  "external_titles",
] as const;

/**
 * Del plano de operaciones, **solo `ops_sync_runs` y solo estas columnas**: la
 * vigencia de los anuncios (ADR 0007) y el ancla del seed (ADR 0009). No lee
 * cuota, errores ni commits: `GRANT SELECT (…) ON ops_sync_runs`.
 */
const COLUMNAS_DE_OPS_SYNC_RUNS = [
  "checkpoint",
  "error_count",
  "finished_at",
  "id",
  "pipeline",
  "status",
] as const;

/** Lo que la web **no** lee y no debe poder leer. */
const SIN_PERMISO = [
  "external_list_captures",
  "external_list_positions",
  "derived_ranking_definitions",
  "derived_ranking_entries",
] as const;

const SQL_DE_LECTURA = readFileSync(
  join(import.meta.dirname, "../../src/db/queries/catalogo-sql.ts"),
  "utf8",
);
const DOCUMENTO = readFileSync(
  join(import.meta.dirname, "../../docs/04-lectura-del-catalogo.md"),
  "utf8",
);

function unicos(valores: Iterable<string>): string[] {
  return [...new Set(valores)].sort();
}

const TABLAS = new Map<string, string[]>();
for (const valor of Object.values(esquema)) {
  if (typeof valor !== "object" || valor === null) continue;
  try {
    const config = getTableConfig(valor as PgTable);
    TABLAS.set(
      config.name,
      config.columns.map((c) => c.name),
    );
  } catch {
    // No es una tabla (enum, relaciones…).
  }
}

function columnasDe(nombre: string): string[] {
  const columnas = TABLAS.get(nombre);
  expect(columnas, `tabla ${nombre}`).toBeDefined();
  return columnas!;
}

describe("rol de solo lectura del runtime: contrato de permisos", () => {
  it("las consultas leen exactamente las tablas del contrato", () => {
    const leidas = unicos(
      [
        ...SQL_DE_LECTURA.matchAll(
          /\b(?:FROM|JOIN)\s+((?:external|ops|derived)_[a-z_]+)/g,
        ),
      ].map((m) => m[1]!),
    );
    expect(leidas).toEqual(unicos([...TABLAS_DEL_CATALOGO, "ops_sync_runs"]));
  });

  it("de ops_sync_runs solo se leen las columnas concedidas", () => {
    // Los alias `r` de `ops_sync_runs` son los de RECORRIDO_DE_REFERENCIA e
    // `inicioDelRegistro`: cualquier `r.columna` es de esa tabla.
    const usadas = unicos(
      [...SQL_DE_LECTURA.matchAll(/\br\.([a-z_]+)/g)].map((m) => m[1]!),
    );
    expect(usadas).toEqual([...COLUMNAS_DE_OPS_SYNC_RUNS]);
  });

  it("las columnas concedidas existen en el esquema", () => {
    const existentes = columnasDe("ops_sync_runs");
    for (const columna of COLUMNAS_DE_OPS_SYNC_RUNS)
      expect(existentes).toContain(columna);
    // Y la concesión deja fuera lo que es de los jobs: cuota, errores, commit.
    for (const privada of [
      "requests_made",
      "budget_limit",
      "error_samples",
      "commit_sha",
      "rows_affected",
    ]) {
      expect(COLUMNAS_DE_OPS_SYNC_RUNS).not.toContain(privada);
      expect(existentes).toContain(privada);
    }
  });

  it("las tablas del contrato existen y las que la web no lee siguen fuera", () => {
    for (const tabla of TABLAS_DEL_CATALOGO)
      expect(columnasDe(tabla).length).toBeGreaterThan(0);
    for (const tabla of SIN_PERMISO) {
      expect(TABLAS_DEL_CATALOGO).not.toContain(tabla);
      expect(SQL_DE_LECTURA).not.toContain(tabla);
    }
  });

  it("La documentación de lectura del catálogo nombra cada tabla y cada columna concedidas", () => {
    for (const tabla of [...TABLAS_DEL_CATALOGO, "ops_sync_runs"]) {
      expect(DOCUMENTO, tabla).toContain(tabla);
    }
    for (const columna of COLUMNAS_DE_OPS_SYNC_RUNS) {
      expect(DOCUMENTO, columna).toContain(columna);
    }
  });
});
