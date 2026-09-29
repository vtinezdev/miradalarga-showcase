/**
 * **Destinos de validación** (ADR 0009 §9): una lista cerrada, y cada llamador
 * admite solo lo que declara. Por defecto, solo la rama histórica.
 *
 * `drizzle.migrate.config.ts` corre sus guardas **al importarse**, así que se
 * importa con un entorno falso ya puesto: ninguna conexión, ningún secreto.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type * as ConfigDeMigracion from "../../drizzle.migrate.config.ts";
import { regimenDelDestino } from "../../jobs/pipelines/arranque.ts";
import { exigirDestino } from "../../jobs/pipelines/programado.ts";

const HOST = "ep-falso-123456.eu-central-1.aws.neon.tech";
const URL_FALSA = `postgresql://usuario:clave@${HOST}/basedatos?sslmode=require`;

function entorno(rama: string, extra: Record<string, string> = {}) {
  return {
    DATABASE_URL_DIRECT: URL_FALSA,
    NEON_VALIDATION_HOST: HOST,
    MIGRATION_TARGET: rama,
    ...extra,
  };
}

let config: typeof ConfigDeMigracion;

beforeAll(async () => {
  vi.stubEnv("DATABASE_URL_DIRECT", URL_FALSA);
  vi.stubEnv("NEON_VALIDATION_HOST", HOST);
  vi.stubEnv("MIGRATION_TARGET", "drizzle-schema-v1-test");
  config = await import("../../drizzle.migrate.config.ts");
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("la lista cerrada", () => {
  it("son exactamente la histórica, la del ensayo del seed y la del seed real", () => {
    expect([...config.RAMAS_DE_VALIDACION]).toEqual([
      "drizzle-schema-v1-test",
      "seed-bootstrap-v1-test",
      "seed-real-v1-test",
    ]);
    expect(config.RAMA_HISTORICA).toBe("drizzle-schema-v1-test");
    expect(config.RAMA_DEL_SEED).toBe("seed-bootstrap-v1-test");
    expect(config.RAMA_DEL_SEED_REAL).toBe("seed-real-v1-test");
  });

  it("ningún destino se parece a production", () => {
    for (const rama of config.RAMAS_DE_VALIDACION) {
      expect(rama).not.toMatch(/prod|main|master/i);
    }
  });
});

describe("verificarDestino", () => {
  it("por defecto admite SOLO la rama histórica", () => {
    expect(config.verificarDestino(entorno("drizzle-schema-v1-test")).rama).toBe(
      "drizzle-schema-v1-test",
    );
    expect(() => config.verificarDestino(entorno("seed-bootstrap-v1-test"))).toThrow(
      /MIGRATION_TARGET/,
    );
    expect(() => config.verificarDestino(entorno("seed-real-v1-test"))).toThrow(
      /MIGRATION_TARGET/,
    );
  });

  it("quien pide la rama del seed solo alcanza la del seed", () => {
    const admitidas = [config.RAMA_DEL_SEED] as const;
    expect(
      config.verificarDestino(entorno("seed-bootstrap-v1-test"), admitidas).rama,
    ).toBe("seed-bootstrap-v1-test");
    expect(() =>
      config.verificarDestino(entorno("drizzle-schema-v1-test"), admitidas),
    ).toThrow(/MIGRATION_TARGET/);
  });

  it("migrar admite las tres, y nada más", () => {
    const todas = config.RAMAS_DE_VALIDACION;
    for (const rama of todas) {
      expect(config.verificarDestino(entorno(rama), todas).rama).toBe(rama);
    }
    for (const otra of [
      "production",
      "main",
      "",
      "seed-bootstrap-v1-test ",
      "SEED-BOOTSTRAP-V1-TEST",
      "seed-bootstrap-v2-test",
      "seed-real-v2-test",
      "seed-real-v1-test\n",
    ]) {
      expect(() => config.verificarDestino(entorno(otra), todas)).toThrow();
    }
  });

  it("fail closed: un llamador no puede admitir una rama fuera de la lista, ni ninguna", () => {
    expect(() =>
      config.verificarDestino(entorno("production"), [
        "production" as unknown as "drizzle-schema-v1-test",
      ]),
    ).toThrow(/lista cerrada/);
    expect(() =>
      config.verificarDestino(entorno("drizzle-schema-v1-test"), []),
    ).toThrow(/Ningún destino/);
  });

  it("el hostname tiene que coincidir exactamente y la conexión ser directa", () => {
    const todas = config.RAMAS_DE_VALIDACION;
    expect(() =>
      config.verificarDestino(
        entorno("seed-bootstrap-v1-test", {
          NEON_VALIDATION_HOST: "ep-otro.neon.tech",
        }),
        todas,
      ),
    ).toThrow(/hostname/);
    expect(() =>
      config.verificarDestino(
        entorno("seed-bootstrap-v1-test", {
          DATABASE_URL_DIRECT: URL_FALSA.replace(
            HOST,
            "ep-falso-123456-pooler.neon.tech",
          ),
          NEON_VALIDATION_HOST: "ep-falso-123456-pooler.neon.tech",
        }),
        todas,
      ),
    ).toThrow(/pooler/);
    expect(() =>
      config.verificarDestino(
        entorno("seed-bootstrap-v1-test", { NEON_VALIDATION_HOST: "" }),
        todas,
      ),
    ).toThrow(/NEON_VALIDATION_HOST/);
  });

  it("una sesión con variables de production no alcanza ninguna rama de validación", () => {
    for (const v of [
      "PRODUCTION_DATABASE_URL_DIRECT",
      "NEON_PRODUCTION_HOST",
      "PRODUCTION_TARGET",
    ]) {
      for (const rama of config.RAMAS_DE_VALIDACION) {
        expect(
          () =>
            config.verificarDestino(
              entorno(rama, { [v]: "x" }),
              config.RAMAS_DE_VALIDACION,
            ),
          `${v} en ${rama}`,
        ).toThrow(/variables de production/);
      }
    }
  });

  it("la rama de aceptación de production es la del seed real", async () => {
    const { RAMA_DE_ACEPTACION } = await import("../../scripts/production-comun.ts");
    expect(RAMA_DE_ACEPTACION).toBe(config.RAMA_DEL_SEED_REAL);
  });

  it("nunca imprime la cadena de conexión en un error", () => {
    try {
      config.verificarDestino(entorno("production"), config.RAMAS_DE_VALIDACION);
    } catch (error) {
      expect(String(error)).not.toContain("clave");
      expect(String(error)).not.toContain(URL_FALSA);
    }
  });
});

describe("jobs y régimen", () => {
  it("pnpm job sigue alcanzando solo la histórica, aunque la del seed pase las guardas", () => {
    const destino = config.verificarDestino(
      entorno("seed-bootstrap-v1-test"),
      config.RAMAS_DE_VALIDACION,
    );
    expect(() =>
      exigirDestino(destino, entorno("seed-bootstrap-v1-test"), "deltas"),
    ).toThrow(/drizzle-schema-v1-test/);
  });

  it("pnpm job tampoco alcanza la del seed real", () => {
    const destino = config.verificarDestino(
      entorno("seed-real-v1-test"),
      config.RAMAS_DE_VALIDACION,
    );
    expect(() =>
      exigirDestino(destino, entorno("seed-real-v1-test"), "deltas"),
    ).toThrow(/drizzle-schema-v1-test/);
  });

  it("seed:primer-deltas nombra la del seed real, y con ella no alcanza la histórica", () => {
    const real = config.verificarDestino(
      entorno("seed-real-v1-test"),
      config.RAMAS_DE_VALIDACION,
    );
    expect(() =>
      exigirDestino(real, entorno("seed-real-v1-test"), "deltas", [
        config.RAMA_DEL_SEED_REAL,
      ]),
    ).not.toThrow();
    const historica = config.verificarDestino(entorno("drizzle-schema-v1-test"));
    expect(() =>
      exigirDestino(historica, entorno("drizzle-schema-v1-test"), "deltas", [
        config.RAMA_DEL_SEED_REAL,
      ]),
    ).toThrow(/seed-real-v1-test/);
  });

  it("las ramas del seed están en el régimen estricto; la histórica, no", () => {
    expect(regimenDelDestino(config.RAMA_DEL_SEED)).toBe("bootstrap_del_seed");
    expect(regimenDelDestino(config.RAMA_DEL_SEED_REAL)).toBe("bootstrap_del_seed");
    expect(regimenDelDestino(config.RAMA_HISTORICA)).toBe("historico");
  });
});
