/**
 * El SQL que drizzle-kit **emitió**, no el que el esquema **declara**.
 *
 * Es el punto donde un ORM puede traicionar el diseño en silencio: un
 * `nullsNotDistinct()` que se declara pero no se genera produce un único normal,
 * y con `NULL` cada fila es distinta de las demás — la deduplicación de ofertas
 * dejaría de funcionar sin que nada fallara.
 *
 * También vigila la migración 0001, que está escrita a mano porque Drizzle no
 * modela triggers y por tanto **no aparece en ningún snapshot**.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIRECTORIO = join(import.meta.dirname, "..", "..", "drizzle");

function leer(patron: RegExp): string {
  const fichero = readdirSync(DIRECTORIO).find((f) => patron.test(f));
  if (!fichero) throw new Error(`No hay migración que case con ${patron.source}`);
  return readFileSync(join(DIRECTORIO, fichero), "utf8");
}

const inicial = leer(/^0000_.*\.sql$/);
const triggers = leer(/^0001_immutable_history_triggers\.sql$/);
const checkpoint = leer(/^0002_checkpoint_de_reanudacion\.sql$/);
const anuncios = leer(/^0003_anuncios_de_disponibilidad\.sql$/);
const imdbNoVacio = leer(/^0004_imdb_id_no_vacio\.sql$/);

/**
 * El SQL sin comentarios.
 *
 * La migración 0001 explica en su cabecera por qué el horizonte de retención NO
 * se codifica en un trigger, y para explicarlo tiene que nombrar los 180 días.
 * Lo que se comprueba es lo que la base de datos **ejecuta**, no la prosa.
 */
const triggersEjecutable = triggers
  .split("\n")
  .filter((linea) => !linea.trimStart().startsWith("--"))
  .join("\n");

describe("0000 — esquema generado", () => {
  it("emite NULLS NOT DISTINCT exactamente cuatro veces", () => {
    expect(inicial.match(/NULLS NOT DISTINCT/g)).toHaveLength(4);
  });

  it("emite el CHECK que impide que un rating 0 entre en la base de datos", () => {
    expect(inicial).toMatch(/BETWEEN 1 AND 100/);
  });

  it("entrecomilla window, que es palabra reservada en PostgreSQL", () => {
    expect(inicial).toContain('"window" "popularity_window"');
  });

  it("usa bigint generated always as identity en las claves subrogadas", () => {
    expect(inicial).toContain("bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY");
    expect(inicial).not.toMatch(/\bserial\b/i);
    expect(inicial).not.toMatch(/\buuid\b/i);
  });

  it("crea las 14 tablas y ni una más", () => {
    expect(inicial.match(/^CREATE TABLE /gm)).toHaveLength(14);
  });

  it("crea los 10 enums, con popularity_order y sin ranking_kind", () => {
    expect(inicial.match(/^CREATE TYPE /gm)).toHaveLength(10);
    expect(inicial).toContain("'popularity_order'");
    expect(inicial).not.toContain("ranking_kind");
    expect(inicial).not.toContain("'editorial'");
  });
});

describe("0001 — triggers de inmutabilidad, SQL manual", () => {
  it("define la función compartida", () => {
    expect(triggers).toMatch(/FUNCTION raise_immutable_history\(\)/);
  });

  it("crea exactamente tres triggers", () => {
    expect(triggers.match(/^CREATE TRIGGER /gm)).toHaveLength(3);
  });

  it("solo el de eventos cubre DELETE: capturas y posiciones se podan", () => {
    expect(triggers).toMatch(/BEFORE UPDATE OR DELETE ON external_availability_events/);
    expect(triggers).toMatch(/BEFORE UPDATE ON external_list_captures/);
    expect(triggers).toMatch(/BEFORE UPDATE ON external_list_positions/);

    expect(triggers).not.toMatch(/DELETE ON external_list_captures/);
    expect(triggers).not.toMatch(/DELETE ON external_list_positions/);
  });

  it("no clava el horizonte de retención en el SQL ejecutable", () => {
    expect(triggersEjecutable).not.toMatch(/180/);
    expect(triggersEjecutable.toLowerCase()).not.toContain("interval");
  });

  it("no mezcla ningún otro cambio", () => {
    expect(triggersEjecutable).not.toMatch(/CREATE TABLE /);
    expect(triggersEjecutable).not.toMatch(/ALTER TABLE /);
    expect(triggersEjecutable).not.toMatch(/CREATE TYPE /);
  });
});

describe("0002 — checkpoint de reanudación, generada por drizzle-kit (ADR 0006)", () => {
  /** Las sentencias, sin el separador de drizzle-kit. */
  const sentencias = checkpoint
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s !== "");

  it("son exactamente dos sentencias: la columna y su CHECK", () => {
    expect(sentencias).toHaveLength(2);
    expect(sentencias[0]).toBe(
      'ALTER TABLE "ops_sync_runs" ADD COLUMN "checkpoint" jsonb;',
    );
    expect(sentencias[1]).toMatch(
      /^ALTER TABLE "ops_sync_runs" ADD CONSTRAINT "ops_sync_runs_checkpoint_objeto" CHECK \(/,
    );
  });

  it("la columna es nullable y SIN default: no reescribe la tabla", () => {
    // Un DEFAULT volátil o un NOT NULL obligarían a tocar las filas que ya
    // existen. Nullable y sin default es un cambio de catálogo.
    expect(checkpoint).not.toMatch(/NOT NULL/);
    expect(checkpoint).not.toMatch(/DEFAULT/);
  });

  it("el CHECK admite NULL y exige un objeto, nada más", () => {
    expect(sentencias[1]).toContain('"ops_sync_runs"."checkpoint" IS NULL');
    expect(sentencias[1]).toContain(
      `jsonb_typeof("ops_sync_runs"."checkpoint") = 'object'`,
    );
  });

  it("no toca ninguna otra tabla, tipo ni trigger", () => {
    expect(checkpoint.match(/ALTER TABLE "([a-z_]+)"/g)).toEqual([
      'ALTER TABLE "ops_sync_runs"',
      'ALTER TABLE "ops_sync_runs"',
    ]);
    expect(checkpoint).not.toMatch(/CREATE (TABLE|TYPE|TRIGGER|INDEX)/);
    expect(checkpoint).not.toMatch(/DROP /);
  });
});

describe("0003 — anuncios de disponibilidad, generada por drizzle-kit (ADR 0007)", () => {
  const sentencias = anuncios
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s !== "");

  it("crea UNA tabla, sus tres claves ajenas y su índice, y nada más", () => {
    expect(anuncios.match(/^CREATE TABLE /gm)).toHaveLength(1);
    expect(anuncios).toMatch(/^CREATE TABLE "external_availability_announcements" \(/m);
    expect(anuncios.match(/FOREIGN KEY/g)).toHaveLength(3);
    expect(anuncios.match(/^CREATE INDEX /gm)).toHaveLength(1);
    expect(sentencias).toHaveLength(5);
  });

  it("emite la clave natural con NULLS NOT DISTINCT, sin fecha ni link", () => {
    expect(anuncios.match(/NULLS NOT DISTINCT/g)).toHaveLength(1);
    expect(anuncios).toContain(
      'CONSTRAINT "external_availability_announcements_key" UNIQUE NULLS NOT DISTINCT' +
        '("title_id","platform_id","country","offer_type","addon")',
    );
  });

  it("link y last_seen_run_id nullable; las fechas, NOT NULL", () => {
    expect(anuncios).toMatch(/^\s*"link" text,$/m);
    expect(anuncios).toMatch(/^\s*"last_seen_run_id" bigint,$/m);
    for (const c of [
      "announced_for",
      "first_announced_for",
      "first_seen_at",
      "last_seen_at",
    ]) {
      expect(anuncios).toContain(`"${c}" timestamp with time zone NOT NULL`);
    }
  });

  it("el CHECK exige last_seen_at >= first_seen_at", () => {
    expect(anuncios).toContain(
      'CONSTRAINT "external_availability_announcements_vistas_ordenadas" CHECK ' +
        '("external_availability_announcements"."last_seen_at" >= ' +
        '"external_availability_announcements"."first_seen_at")',
    );
  });

  it("borrado: título y plataforma RESTRICT, ejecución SET NULL", () => {
    expect(anuncios).toMatch(
      /FOREIGN KEY \("title_id"\) REFERENCES "public"\."external_titles"\("id"\) ON DELETE restrict/,
    );
    expect(anuncios).toMatch(
      /FOREIGN KEY \("platform_id"\) REFERENCES "public"\."external_platforms"\("id"\) ON DELETE restrict/,
    );
    expect(anuncios).toMatch(
      /FOREIGN KEY \("last_seen_run_id"\) REFERENCES "public"\."ops_sync_runs"\("id"\) ON DELETE set null/,
    );
  });

  it("indexa (country, announced_for)", () => {
    expect(anuncios).toContain(
      'CREATE INDEX "external_availability_announcements_country_announced_for_idx" ' +
        'ON "external_availability_announcements" USING btree ("country","announced_for");',
    );
  });

  it("no toca ninguna otra tabla, ni tipos, ni triggers, ni borra nada", () => {
    for (const m of anuncios.matchAll(/ALTER TABLE "([a-z_]+)"/g)) {
      expect(m[1]).toBe("external_availability_announcements");
    }
    expect(anuncios).not.toMatch(/CREATE TYPE|CREATE TRIGGER|ALTER TYPE/);
    expect(anuncios).not.toMatch(/DROP /);
    // Ningún DEFAULT: cada valor lo escribe el pipeline.
    expect(anuncios).not.toMatch(/DEFAULT/);
  });
});

describe("0004 — external_titles.imdb_id no vacío, generada por drizzle-kit", () => {
  const sentencias = imdbNoVacio
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s !== "");

  it("es exactamente una sentencia: el CHECK", () => {
    expect(sentencias).toEqual([
      'ALTER TABLE "external_titles" ADD CONSTRAINT "external_titles_imdb_id_no_vacio" ' +
        `CHECK ("external_titles"."imdb_id" ~ '[^[:space:]]');`,
    ]);
  });

  it("exige un carácter fuera de [[:space:]], no solo espacios: btrim() no bastaba", () => {
    expect(imdbNoVacio).toContain(`~ '[^[:space:]]'`);
    expect(imdbNoVacio).not.toMatch(/btrim|length\(/);
  });

  it("no impone el formato tt…: solo que la identidad exista", () => {
    expect(imdbNoVacio).not.toMatch(/tt|LIKE|SIMILAR/i);
  });

  it("no toca ninguna otra tabla, columna, tipo ni trigger, ni borra nada", () => {
    expect(imdbNoVacio).not.toMatch(
      /CREATE |DROP |ADD COLUMN|ALTER COLUMN|UPDATE |DELETE /,
    );
  });
});

describe("journal", () => {
  it("registra las cinco migraciones, en orden", () => {
    const journal: unknown = JSON.parse(
      readFileSync(join(DIRECTORIO, "meta", "_journal.json"), "utf8"),
    );
    const entradas = (journal as { entries: { idx: number; tag: string }[] }).entries;
    expect(entradas).toHaveLength(5);
    expect(entradas[0]?.tag).toMatch(/^0000_/);
    expect(entradas[1]?.tag).toBe("0001_immutable_history_triggers");
    expect(entradas[2]?.tag).toBe("0002_checkpoint_de_reanudacion");
    expect(entradas[3]?.tag).toBe("0003_anuncios_de_disponibilidad");
    expect(entradas[4]?.tag).toBe("0004_imdb_id_no_vacio");
  });
});
