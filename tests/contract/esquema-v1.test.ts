/**
 * El esquema v1 como invariante comprobable, **sin base de datos**.
 *
 * `getTableConfig()` de Drizzle expone columnas, claves, índices, `CHECK` y —lo
 * que importa aquí— `uniqueConstraints[].nullsNotDistinct`. Eso basta para
 * verificar contra `docs/DATA-MODEL.md` sin conectar con Neon.
 *
 * Estos tests no comprueban que el código compile: comprueban que **el diseño
 * congelado sigue siendo el que está implementado**. Si alguien añade `status` a
 * `external_availability` o una columna de puntuación a las posiciones, esto
 * falla, que es exactamente para lo que existe.
 */
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import * as esquema from "../../src/db/schema/index.ts";

/**
 * Las 15 tablas de v1, por su nombre SQL: las 14 del diseño congelado y
 * `external_availability_announcements` (ADR 0007).
 */
const TABLAS_V1 = [
  "external_titles",
  "external_genres",
  "external_title_genres",
  "external_title_images",
  "external_platforms",
  "external_platform_capabilities",
  "external_availability",
  "external_availability_options",
  "external_availability_events",
  "external_availability_announcements",
  "external_list_captures",
  "external_list_positions",
  "derived_ranking_definitions",
  "derived_ranking_entries",
  "ops_sync_runs",
] as const;

function esTabla(valor: unknown): valor is PgTable {
  if (typeof valor !== "object" || valor === null) return false;
  try {
    getTableConfig(valor as PgTable);
    return true;
  } catch {
    return false;
  }
}

const tablas = new Map<string, ReturnType<typeof getTableConfig>>();
for (const valor of Object.values(esquema)) {
  if (esTabla(valor)) {
    const config = getTableConfig(valor);
    tablas.set(config.name, config);
  }
}

function tabla(nombre: string): ReturnType<typeof getTableConfig> {
  const config = tablas.get(nombre);
  if (!config) throw new Error(`No existe la tabla ${nombre}`);
  return config;
}

function columnas(nombre: string): string[] {
  return tabla(nombre)
    .columns.map((c) => c.name)
    .sort();
}

function unico(nombreTabla: string, nombreConstraint: string) {
  const constraint = tabla(nombreTabla).uniqueConstraints.find(
    (u) => u.getName() === nombreConstraint,
  );
  if (!constraint) throw new Error(`No existe el único ${nombreConstraint}`);
  return constraint;
}

function accionDeBorrado(nombreTabla: string, columna: string): string | undefined {
  return tabla(nombreTabla).foreignKeys.find((fk) =>
    fk.reference().columns.some((c) => c.name === columna),
  )?.onDelete;
}

describe("las 15 tablas de v1", () => {
  it("son exactamente 15: las 14 del diseño congelado y los anuncios (ADR 0007)", () => {
    expect([...tablas.keys()].sort()).toEqual([...TABLAS_V1].sort());
  });

  it("usan los cinco planos por prefijo, sin editorial_ ni site_ todavía", () => {
    for (const nombre of tablas.keys()) {
      expect(nombre).toMatch(/^(external|derived|ops)_/);
    }
  });

  it("no incluye ninguna entidad que el documento deja fuera de v1", () => {
    const prohibidas = [
      "season",
      "episode",
      "people",
      "person",
      "credit",
      "video",
      "similar",
      "article",
      "editorial",
      "slug",
      "search_quer",
      "outbound_click",
      "landing_page",
      "redirect",
      "title_metrics",
      "external_title_ids",
      "genre_source_map",
    ];
    for (const nombre of tablas.keys()) {
      for (const prohibida of prohibidas) {
        expect(nombre).not.toContain(prohibida);
      }
    }
  });
});

describe("external_availability es SOLO identidad", () => {
  it("tiene exactamente las nueve columnas de la oferta lógica", () => {
    expect(columnas("external_availability")).toEqual([
      "addon",
      "country",
      "created_at",
      "id",
      "last_checked_at",
      "offer_type",
      "platform_id",
      "sync_run_id",
      "title_id",
    ]);
  });

  it("no tiene nada que pertenezca a las opciones ni sea derivable", () => {
    const prohibidas = [
      "status",
      "quality",
      "price_amount",
      "price_currency",
      "audio_languages",
      "subtitle_languages",
      "available_since",
      "expires_at",
      "link",
      "link_count",
      "missing_streak",
      "fingerprint",
      "is_active",
      "expires_soon",
      "leaving_soon",
    ];
    const presentes = columnas("external_availability");
    for (const prohibida of prohibidas) {
      expect(presentes).not.toContain(prohibida);
    }
  });
});

describe("NULLS NOT DISTINCT", () => {
  const esperados: readonly (readonly [string, string, readonly string[]])[] = [
    [
      "external_title_images",
      "external_title_images_key",
      ["title_id", "type", "width", "language"],
    ],
    [
      "external_availability",
      "external_availability_key",
      ["title_id", "platform_id", "country", "offer_type", "addon"],
    ],
    [
      "external_availability_options",
      "external_availability_options_key",
      ["availability_id", "link", "quality"],
    ],
    [
      "external_availability_announcements",
      "external_availability_announcements_key",
      ["title_id", "platform_id", "country", "offer_type", "addon"],
    ],
    [
      "external_list_captures",
      "external_list_captures_key",
      [
        "list_kind",
        "platform_id",
        "country",
        "title_type",
        "window",
        "bucket_start_at",
      ],
    ],
  ];

  it.each(esperados)("%s lo lleva, con sus columnas exactas", (t, nombre, cols) => {
    const constraint = unico(t, nombre);
    expect(constraint.nullsNotDistinct).toBe(true);
    expect(constraint.columns.map((c) => c.name)).toEqual([...cols]);
  });

  it("son exactamente cinco en todo el esquema", () => {
    const total = [...tablas.values()].flatMap((t) =>
      t.uniqueConstraints.filter((u) => u.nullsNotDistinct),
    );
    expect(total).toHaveLength(5);
  });
});

describe("idempotencia de los eventos", () => {
  it("el único es (availability_id, event_type, event_digest, dedupe_bucket_at)", () => {
    const constraint = unico(
      "external_availability_events",
      "external_availability_events_key",
    );
    expect(constraint.columns.map((c) => c.name)).toEqual([
      "availability_id",
      "event_type",
      "event_digest",
      "dedupe_bucket_at",
    ]);
    // Las cuatro son NOT NULL, así que no necesita NULLS NOT DISTINCT.
    expect(constraint.nullsNotDistinct).toBe(false);
  });

  it("conserva el instante exacto además del bucket de deduplicación", () => {
    expect(columnas("external_availability_events")).toContain("detected_at");
  });
});

describe("ops_sync_runs guarda el punto de reanudación (ADR 0006)", () => {
  it("tiene la columna checkpoint, jsonb y nullable", () => {
    const columna = tabla("ops_sync_runs").columns.find((c) => c.name === "checkpoint");
    expect(columna?.getSQLType()).toBe("jsonb");
    expect(columna?.notNull).toBe(false);
    expect(columna?.hasDefault).toBe(false);
  });

  it("lleva el CHECK que exige un objeto", () => {
    const checks = tabla("ops_sync_runs").checks.map((c) => c.name);
    expect(checks).toContain("ops_sync_runs_checkpoint_objeto");
  });

  it("sigue sin clave ajena: el linaje de una reanudación va dentro del checkpoint", () => {
    // Una FK hacia sí misma arrastraría el `SET NULL` y el trigger de
    // inmutabilidad a la tabla de ejecuciones (docs/DATA-MODEL.md, inv. 8).
    expect(tabla("ops_sync_runs").foreignKeys).toHaveLength(0);
  });
});

describe("external_availability_announcements (ADR 0007)", () => {
  const T = "external_availability_announcements";

  it("tiene exactamente las doce columnas decididas, sin estado ni racha", () => {
    expect(columnas(T)).toEqual([
      "addon",
      "announced_for",
      "country",
      "first_announced_for",
      "first_seen_at",
      "id",
      "last_seen_at",
      "last_seen_run_id",
      "link",
      "offer_type",
      "platform_id",
      "title_id",
    ]);
    for (const prohibida of [
      "status",
      "cancelled",
      "cancelled_at",
      "missing_streak",
      "availability_id",
      "source_id",
      "show_id",
    ]) {
      expect(columnas(T)).not.toContain(prohibida);
    }
  });

  it("la fecha anunciada y el link NO son identidad: no están en la clave", () => {
    const clave = unico(T, "external_availability_announcements_key");
    const nombres = clave.columns.map((c) => c.name);
    expect(nombres).not.toContain("announced_for");
    expect(nombres).not.toContain("link");
  });

  it("📏 link es nullable: Prime anuncia sin él", () => {
    const link = tabla(T).columns.find((c) => c.name === "link");
    expect(link?.notNull).toBe(false);
  });

  it("las fechas y los instantes son NOT NULL; last_seen_run_id no", () => {
    const col = (n: string) => tabla(T).columns.find((c) => c.name === n);
    for (const n of [
      "announced_for",
      "first_announced_for",
      "first_seen_at",
      "last_seen_at",
    ]) {
      expect(col(n)?.notNull).toBe(true);
      expect(col(n)?.getSQLType()).toBe("timestamp with time zone");
    }
    expect(col("last_seen_run_id")?.notNull).toBe(false);
  });

  it("lleva el CHECK de orden de las observaciones", () => {
    expect(tabla(T).checks.map((c) => c.name)).toEqual([
      "external_availability_announcements_vistas_ordenadas",
    ]);
  });

  it("indexa «Próximamente» por país y fecha anunciada", () => {
    const indices = tabla(T).indexes.map((i) => ({
      nombre: i.config.name,
      columnas: i.config.columns.map((c) => ("name" in c ? c.name : "?")),
    }));
    expect(indices).toEqual([
      {
        nombre: "external_availability_announcements_country_announced_for_idx",
        columnas: ["country", "announced_for"],
      },
    ]);
  });
});

describe("la valoración no puede entrar como 0", () => {
  it("external_titles lleva el CHECK de rango", () => {
    const checks = tabla("external_titles").checks;
    expect(checks.map((c) => c.name)).toContain("external_titles_rating_rango");
  });
});

describe("un título no puede entrar sin identidad", () => {
  it("external_titles lleva el CHECK de imdb_id no vacío, y solo esos dos CHECK", () => {
    const checks = tabla("external_titles").checks.map((c) => c.name);
    expect(checks).toEqual([
      "external_titles_rating_rango",
      "external_titles_imdb_id_no_vacio",
    ]);
  });
});

describe("una posición es un ordinal, nunca una puntuación", () => {
  it.each(["external_list_positions", "derived_ranking_entries"])(
    "%s no tiene ninguna columna de puntuación",
    (nombre) => {
      for (const columna of columnas(nombre)) {
        expect(columna).not.toMatch(/(^|_)(score|points|puntuacion|rating)$/);
      }
    },
  );

  it("external_list_positions solo guarda captura, posición y título", () => {
    expect(columnas("external_list_positions")).toEqual([
      "capture_id",
      "position",
      "title_id",
    ]);
  });
});

describe("el Ranking C no vive en el plano derivado", () => {
  it("ninguna definición tiene columna discriminadora de tipo de lista", () => {
    expect(columnas("derived_ranking_definitions")).not.toContain("kind");
    expect(columnas("derived_ranking_definitions")).not.toContain("type");
  });

  it("ningún enum del esquema contiene el valor editorial", () => {
    for (const valor of Object.values(esquema)) {
      if (
        typeof valor === "function" &&
        "enumValues" in valor &&
        Array.isArray(valor.enumValues)
      ) {
        expect(valor.enumValues).not.toContain("editorial");
      }
    }
  });
});

describe("multi-país desde el diseño", () => {
  it.each([
    "external_availability",
    "external_platform_capabilities",
    "external_list_captures",
    "derived_ranking_definitions",
    "external_availability_announcements",
  ])("%s lleva country", (nombre) => {
    expect(columnas(nombre)).toContain("country");
  });
});

describe("la compuerta de publicación del Ranking B", () => {
  it("existe la capacidad popularity_order", () => {
    expect(esquema.capability.enumValues).toContain("popularity_order");
  });

  it("los cuatro estados siguen siendo cuatro: un cero no es una ausencia", () => {
    expect(esquema.capabilityStatus.enumValues).toEqual([
      "supported_with_data",
      "supported_no_data_in_sample",
      "not_supported",
      "unknown",
    ]);
  });
});

describe("política de borrado: el histórico no se pierde en una reingesta", () => {
  it("las tablas de estado se borran en cascada con su padre", () => {
    expect(accionDeBorrado("external_title_genres", "title_id")).toBe("cascade");
    expect(accionDeBorrado("external_title_images", "title_id")).toBe("cascade");
    expect(accionDeBorrado("external_availability_options", "availability_id")).toBe(
      "cascade",
    );
  });

  it("de lo que cuelga histórico se protege con RESTRICT", () => {
    expect(accionDeBorrado("external_availability", "title_id")).toBe("restrict");
    // Los anuncios guardan primeras observaciones que la fuente no devuelve.
    expect(accionDeBorrado("external_availability_announcements", "title_id")).toBe(
      "restrict",
    );
    expect(accionDeBorrado("external_availability_announcements", "platform_id")).toBe(
      "restrict",
    );
    expect(accionDeBorrado("external_availability_events", "availability_id")).toBe(
      "restrict",
    );
  });

  it("las posiciones NO caen en cascada: la retención borra en dos pasos", () => {
    expect(accionDeBorrado("external_list_positions", "capture_id")).toBe("restrict");
  });

  it("sync_run_id es RESTRICT donde hay trigger de inmutabilidad", () => {
    // SET NULL ejecutaría un UPDATE sobre la fila hija, y el trigger de la
    // migración 0001 abortaría el borrado de la ejecución de sync.
    expect(accionDeBorrado("external_availability_events", "sync_run_id")).toBe(
      "restrict",
    );
    expect(accionDeBorrado("external_list_captures", "sync_run_id")).toBe("restrict");
    // external_availability no tiene trigger: ahí SET NULL es legal.
    expect(accionDeBorrado("external_availability", "sync_run_id")).toBe("set null");
    // Tampoco los anuncios: son estado mutable, no histórico.
    expect(
      accionDeBorrado("external_availability_announcements", "last_seen_run_id"),
    ).toBe("set null");
  });
});
