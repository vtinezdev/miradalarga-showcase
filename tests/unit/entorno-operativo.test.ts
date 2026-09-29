/**
 * El cargador de entorno de `pnpm ops`: lectura literal, limpieza de lo
 * heredado, fail closed ante mezclas, y ningún valor en los errores. Con
 * valores falsos: ni red ni base.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  EntornoInvalido,
  PERFILES,
  argumentosDelScript,
  construirEntorno,
  esVariableSensible,
  ficherosNecesarios,
  leerFicheroLiteral,
} from "../../scripts/entorno-operativo.ts";

const SECRETO_BD = "s3cr3t-$(rm -rf)-`x`";
const CLAVE = "clave-api-falsa-123";
const HOST_SEED = "ep-seed-real-000.c-6.eu-central-1.aws.neon.tech";
const HOST_HIST = "ep-historica-000.c-6.eu-central-1.aws.neon.tech";
const HOST_PROD = "ep-production-000.c-6.eu-central-1.aws.neon.tech";

const url = (host: string): string =>
  `postgresql://u:${SECRETO_BD}@${host}/neondb?sslmode=require`;

const seedReal = [
  "# rama limpia del seed real",
  `DATABASE_URL_DIRECT=${url(HOST_SEED)}`,
  `NEON_VALIDATION_HOST=${HOST_SEED}`,
  "MIGRATION_TARGET=seed-real-v1-test",
  "",
].join("\r\n");
const production = [
  `PRODUCTION_DATABASE_URL_DIRECT=${url(HOST_PROD)}`,
  `NEON_PRODUCTION_HOST=${HOST_PROD}`,
  "PRODUCTION_TARGET=production",
].join("\n");
const api = `STREAMING_AVAILABILITY_API_KEY=${CLAVE}\n`;

/** La sesión de hoy: la histórica, la clave y overrides, heredados. */
const heredado = {
  PATH: "/usr/bin",
  DATABASE_URL_DIRECT: url(HOST_HIST),
  NEON_VALIDATION_HOST: HOST_HIST,
  MIGRATION_TARGET: "drizzle-schema-v1-test",
  STREAMING_AVAILABILITY_API_KEY: "otra-clave-heredada",
  STREAMING_API_BASE_URL: "https://ejemplo.invalid",
  STREAMING_API_PER_RUN_CAPS: "seed=900",
  SPIKE_MAX_REQUESTS: "50",
  PGPASSWORD: "x",
  PRODUCTION_TARGET: "production",
};

function fallo(f: () => unknown): string {
  try {
    f();
  } catch (error) {
    expect(error).toBeInstanceOf(EntornoInvalido);
    return (error as Error).message;
  }
  throw new Error("no lanzó");
}

describe("leerFicheroLiteral", () => {
  it("lee literal: `$`, backticks y `#` dentro del valor no se interpretan; BOM y CRLF", () => {
    const m = leerFicheroLiteral(
      `${String.fromCharCode(0xfeff)}# c\r\nA=x$HOME\`y\`#z\r\n\r\nB=1=2\r\n`,
      "f",
    );
    expect([...m]).toEqual([
      ["A", "x$HOME`y`#z"],
      ["B", "1=2"],
    ]);
  });

  it.each([
    ["export A=1", /NOMBRE=valor/],
    ["A = 1", /NOMBRE=valor/],
    ["a=1", /NOMBRE=valor/],
    ["A=", /vacía/],
    ["A= 1", /bordes/],
    ["A=1 ", /bordes/],
    [`A="${SECRETO_BD}"`, /comillas/],
    [`A='${SECRETO_BD}'`, /comillas/],
    [`A=${SECRETO_BD}\nA=${SECRETO_BD}`, /repetida/],
    [`  # sangrado ${SECRETO_BD}`, /NOMBRE=valor/],
  ])("se niega a «%s» sin mostrar el valor", (texto, motivo) => {
    const m = fallo(() => leerFicheroLiteral(texto, "f"));
    expect(m).toMatch(motivo);
    expect(m).not.toContain(SECRETO_BD);
  });
});

describe("construirEntorno", () => {
  const base = { heredado, argumentos: [] as string[] };

  it("seed:capturar: limpia lo heredado y carga seed-real + api, y nada más", () => {
    const e = construirEntorno({
      ...base,
      perfil: "seed-real",
      comando: "seed:capturar",
      argumentos: ["--real", "plan.json", "m1"],
      ficheros: { "seed-real.env": seedReal, "api.env": api },
    });
    expect(e.entorno).toEqual({
      PATH: "/usr/bin",
      DATABASE_URL_DIRECT: url(HOST_SEED),
      NEON_VALIDATION_HOST: HOST_SEED,
      MIGRATION_TARGET: "seed-real-v1-test",
      STREAMING_AVAILABILITY_API_KEY: CLAVE,
    });
    expect(e.eliminadas).toEqual(
      Object.keys(heredado)
        .filter((k) => k !== "PATH")
        .sort(),
    );
    expect(e).toMatchObject({ conApi: true, destino: "seed-real-v1-test" });
    expect(e.hostname).toBe(HOST_SEED);
  });

  it("un comando que no gasta no recibe la credencial, aunque exista api.env", () => {
    const e = construirEntorno({
      ...base,
      perfil: "seed-real",
      comando: "seed:validar",
      ficheros: { "seed-real.env": seedReal, "api.env": api },
    });
    expect(e.conApi).toBe(false);
    expect(e.entorno).not.toHaveProperty("STREAMING_AVAILABILITY_API_KEY");
    expect(ficherosNecesarios("seed-real", "seed:validar", [])).toEqual([
      "seed-real.env",
    ]);
    expect(ficherosNecesarios("seed-real", "seed:post-captura", ["x"])).toEqual([
      "seed-real.env",
    ]);
    expect(
      ficherosNecesarios("seed-real", "seed:post-captura", ["x", "--primer-deltas"]),
    ).toEqual(["seed-real.env", "api.env"]);
  });

  it("production: solo sus tres variables, ninguna de validación ni la API", () => {
    const e = construirEntorno({
      ...base,
      perfil: "production",
      comando: "db:preflight:production",
      argumentos: ["--con-neon"],
      ficheros: { "production.env": production },
    });
    expect(Object.keys(e.entorno).sort()).toEqual([
      "NEON_PRODUCTION_HOST",
      "PATH",
      "PRODUCTION_DATABASE_URL_DIRECT",
      "PRODUCTION_TARGET",
    ]);
    expect(e.destino).toBe("production");
  });

  it("offline: sin destino ni credencial", () => {
    const e = construirEntorno({
      ...base,
      perfil: "offline",
      comando: "seed:archivar",
      ficheros: {},
    });
    expect(e.entorno).toEqual({ PATH: "/usr/bin" });
  });

  it.each([
    [
      "variables de production en el fichero de validación",
      "seed-real",
      "seed:validar",
      { "seed-real.env": `${seedReal}\nPRODUCTION_TARGET=production` },
      /no le corresponden: PRODUCTION_TARGET/,
    ],
    [
      "la credencial en el fichero de destino",
      "seed-real",
      "seed:validar",
      { "seed-real.env": `${seedReal}\nSTREAMING_AVAILABILITY_API_KEY=${CLAVE}` },
      /no le corresponden: STREAMING_AVAILABILITY_API_KEY/,
    ],
    [
      "un override de presupuesto en api.env",
      "seed-real",
      "seed:capturar",
      {
        "seed-real.env": seedReal,
        "api.env": `${api}STREAMING_API_PER_RUN_CAPS=seed=9`,
      },
      /no le corresponden: STREAMING_API_PER_RUN_CAPS/,
    ],
    [
      "variables de validación en production.env",
      "production",
      "production:validar",
      { "production.env": `${production}\nMIGRATION_TARGET=seed-real-v1-test` },
      /no le corresponden: MIGRATION_TARGET/,
    ],
    [
      "el fichero de otra rama en el perfil seed-real",
      "seed-real",
      "seed:validar",
      {
        "seed-real.env": seedReal.replace(
          "seed-real-v1-test",
          "drizzle-schema-v1-test",
        ),
      },
      /MIGRATION_TARGET no es «seed-real-v1-test»/,
    ],
    [
      "el hostname de otra rama",
      "seed-real",
      "seed:validar",
      { "seed-real.env": seedReal.replace(`HOST=${HOST_SEED}`, `HOST=${HOST_PROD}`) },
      /hostname/,
    ],
    [
      "el pooler",
      "seed-real",
      "seed:validar",
      {
        "seed-real.env": seedReal
          .split(HOST_SEED)
          .join("ep-seed-real-000-pooler.c-6.eu-central-1.aws.neon.tech"),
      },
      /pooler/,
    ],
    [
      "falta el fichero",
      "seed-real",
      "seed:capturar",
      { "seed-real.env": seedReal },
      /Falta \.ops-env\/api\.env/,
    ],
    [
      "falta una variable",
      "production",
      "production:validar",
      { "production.env": production.split("\n").slice(0, 2).join("\n") },
      /faltan PRODUCTION_TARGET/,
    ],
  ])("fail closed: %s", (_t, perfil, comando, ficheros, motivo) => {
    const m = fallo(() =>
      construirEntorno({ ...base, perfil, comando, ficheros, argumentos: [] }),
    );
    expect(m).toMatch(motivo);
    expect(m).not.toContain(SECRETO_BD);
    expect(m).not.toContain(CLAVE);
  });

  it("lista cerrada: la captura no corre en production ni en la histórica, ni production en seed-real", () => {
    const ficheros = { "seed-real.env": seedReal, "production.env": production };
    for (const [perfil, comando, argumentos] of [
      ["production", "seed:capturar", []],
      ["historica", "seed:capturar", []],
      ["seed-real", "production:cargar", []],
      ["seed-real", "db:preflight:production", ["--con-neon"]],
      ["production", "db:preflight:production", ["--en-seed-real"]],
      ["production", "db:migrate:production", []],
      ["seed-real", "api:run:deltas", []],
      ["offline", "seed:capturar", []],
      ["inventado", "seed:capturar", []],
      ["seed-real", "toString", []],
    ] as const) {
      fallo(() => construirEntorno({ ...base, perfil, comando, argumentos, ficheros }));
    }
  });

  it("la credencial no puede ir escondida dentro de la URL", () => {
    const m = fallo(() =>
      construirEntorno({
        ...base,
        perfil: "seed-real",
        comando: "seed:capturar",
        ficheros: {
          "seed-real.env": seedReal.replace(SECRETO_BD, CLAVE),
          "api.env": api,
        },
      }),
    );
    expect(m).toMatch(/aparece dentro de DATABASE_URL_DIRECT/);
    expect(m).not.toContain(CLAVE);
  });
});

describe("variables sensibles y scripts", () => {
  it("se limpian destino, credencial, overrides y libpq, sin distinguir mayúsculas", () => {
    for (const v of [
      "DATABASE_URL",
      "database_url_direct",
      "NEON_PRODUCTION_HOST",
      "STREAMING_API_BUDGET_CYCLE_DAY",
      "SPIKE_MAX_REQUESTS",
      "PGHOST",
    ]) {
      expect(esVariableSensible(v), v).toBe(true);
    }
    for (const v of ["PATH", "Path", "SystemRoot", "npm_config_user_agent", "HOME"]) {
      expect(esVariableSensible(v), v).toBe(false);
    }
  });

  it("cada comando permitido existe en package.json y es un script tsx simple", () => {
    const scripts = (
      JSON.parse(
        readFileSync(join(import.meta.dirname, "../../package.json"), "utf8"),
      ) as { scripts: Record<string, string> }
    ).scripts;
    for (const [perfil, p] of Object.entries(PERFILES)) {
      for (const comando of Object.keys(p.comandos)) {
        const linea = scripts[comando];
        expect(linea, `${perfil}/${comando}`).toBeDefined();
        expect(argumentosDelScript(linea ?? "", comando).length).toBeGreaterThan(0);
      }
    }
    expect(() => argumentosDelScript("drizzle-kit migrate", "x")).toThrow();
    expect(() => argumentosDelScript("tsx a.ts && rm -rf /", "x")).toThrow();
  });

  it(".ops-env/ está ignorado por git", () => {
    const gitignore = readFileSync(
      join(import.meta.dirname, "../../.gitignore"),
      "utf8",
    );
    expect(gitignore.split(/\r?\n/)).toContain(".ops-env/");
  });
});
