/**
 * **Quién puede alcanzar la rama del seed** (ADR 0009 §9). `verificarDestino`
 * admite por defecto solo la rama histórica; ampliar la lista es una decisión
 * de cada llamador, y aquí está cerrada: si un script manual de `/changes` —que
 * corre con el régimen histórico— empezara a admitir la rama del seed, podría
 * saltarse su ancla. Este test lo impide.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const RAIZ = resolve(import.meta.dirname, "../..");

/** Los únicos ficheros que pueden nombrar la rama del seed o la lista entera. */
const AUTORIZADOS = new Set([
  "drizzle.migrate.config.ts",
  "scripts/preflight-migracion.ts",
  "scripts/validate-schema-v1.ts",
  "scripts/validate-behavior-v1.ts",
  "scripts/seed-comun.ts",
  "scripts/seed-capturar.ts",
  "scripts/seed-primer-deltas.ts",
  "scripts/seed-sondear.ts",
  // El camino de production se ensaya, idéntico, contra la rama del seed real.
  "scripts/production-migrar.ts",
  "scripts/production-preflight.ts",
  // La única rama cuya aceptación vale para production (literal a propósito).
  "scripts/production-comun.ts",
  // El cargador de `pnpm ops`: nombra la rama de cada perfil para negarse a
  // un fichero de otra; no conecta, y el hijo vuelve a pasar sus guardas.
  "scripts/entorno-operativo.ts",
]);

function ficheros(directorio: string): string[] {
  const salida: string[] = [];
  for (const entrada of readdirSync(directorio, { withFileTypes: true })) {
    const ruta = join(directorio, entrada.name);
    if (entrada.isDirectory()) salida.push(...ficheros(ruta));
    else if (entrada.name.endsWith(".ts")) salida.push(ruta);
  }
  return salida;
}

const rel = (f: string) => relative(RAIZ, f).split("\\").join("/");

describe("la rama del seed solo la alcanza quien debe", () => {
  const candidatos = [
    ...ficheros(join(RAIZ, "scripts")),
    ...ficheros(join(RAIZ, "jobs")),
    join(RAIZ, "drizzle.migrate.config.ts"),
  ];

  it("RAMA_DEL_SEED, RAMAS_DE_VALIDACION o su nombre, solo en ficheros autorizados", () => {
    const infractores = candidatos
      .filter((f) =>
        /RAMA_DEL_SEED|RAMAS_DE_VALIDACION|seed-bootstrap-v1-test|seed-real-v1-test/.test(
          readFileSync(f, "utf8"),
        ),
      )
      .map(rel)
      .filter((f) => !AUTORIZADOS.has(f));
    expect(infractores).toEqual([]);
  });

  it("los scripts manuales de /changes y pnpm job siguen con la guarda por defecto", () => {
    for (const f of [
      "scripts/manual-comun.ts",
      "scripts/run-deltas-manual.ts",
      "jobs/registro.ts",
      "scripts/validate-spike1-import.ts",
      "scripts/validate-ops-v1.ts",
      "scripts/validate-checkpoint-v1.ts",
    ]) {
      const texto = readFileSync(join(RAIZ, f), "utf8");
      for (const m of texto.matchAll(/verificarDestino\(([^)]*)\)/g)) {
        expect(m[1]?.includes(",") ?? false, `${f}: ${m[0]}`).toBe(false);
      }
    }
  });

  it("carga y validadores del seed: solo las dos ramas del seed, nunca la histórica", () => {
    const texto = readFileSync(join(RAIZ, "scripts/seed-comun.ts"), "utf8");
    expect(texto).toMatch(
      /verificarDestino\(process\.env, \[RAMA_DEL_SEED, RAMA_DEL_SEED_REAL\]\)/,
    );
  });

  it("captura real y primer deltas: solo la rama del seed real", () => {
    for (const f of ["scripts/seed-capturar.ts", "scripts/seed-primer-deltas.ts"]) {
      const texto = readFileSync(join(RAIZ, f), "utf8");
      const llamadas = [...texto.matchAll(/verificarDestino\(([^)]*)\)/g)].map(
        (m) => m[1],
      );
      expect(llamadas, f).toEqual(["process.env, [RAMA_DEL_SEED_REAL]"]);
    }
  });

  it("M1 corre en la rama de validación vigente, la histórica (ADR 0009 §3)", () => {
    const texto = readFileSync(join(RAIZ, "scripts/seed-sondear.ts"), "utf8");
    const llamadas = [...texto.matchAll(/verificarDestino\(([^)]*)\)/g)].map(
      (m) => m[1],
    );
    expect(llamadas).toEqual(["process.env, [RAMA_HISTORICA]"]);
  });

  it("el ensayo del camino de production: solo la rama del seed real", () => {
    for (const f of [
      "scripts/production-migrar.ts",
      "scripts/production-preflight.ts",
    ]) {
      const texto = readFileSync(join(RAIZ, f), "utf8");
      const llamadas = [...texto.matchAll(/verificarDestino\(([^)]*)\)/g)].map(
        (m) => m[1],
      );
      expect(llamadas, f).toEqual(["process.env, [RAMA_DEL_SEED_REAL]"]);
    }
  });
});

/**
 * **Quién puede alcanzar `production`** (ADR 0010). Sus guardas y su
 * autorización solo las importan los scripts que la operan; `pnpm job`, los
 * crons y los scripts manuales de `/changes` no las ven.
 */
describe("production solo la alcanza quien debe", () => {
  const candidatos = [
    ...ficheros(join(RAIZ, "scripts")),
    ...ficheros(join(RAIZ, "jobs")),
  ];

  /** Los únicos que importan las guardas o la autorización de production. */
  const OPERAN_PRODUCTION = new Set([
    "scripts/production-comun.ts",
    "scripts/seed-comun.ts",
    "scripts/seed-cargar.ts",
    "scripts/seed-validar.ts",
    "scripts/seed-primer-deltas.ts",
    "scripts/production-migrar.ts",
    "scripts/production-preflight.ts",
    "scripts/validate-schema-v1.ts",
    "scripts/validate-behavior-v1.ts",
    "scripts/seed-huella.ts",
    "scripts/production-compuerta.ts",
    // `pnpm ops production`: comprueba el fichero con las mismas guardas
    // antes de lanzar nada; no conecta.
    "scripts/entorno-operativo.ts",
  ]);

  it("destino-production, production-comun y la autorización: solo en ficheros autorizados", () => {
    const infractores = candidatos
      .filter((f) =>
        /from "[^"]*(destino-production|production-comun|autorizacion-de-production)\.ts"/.test(
          readFileSync(f, "utf8"),
        ),
      )
      .map(rel)
      .filter((f) => !OPERAN_PRODUCTION.has(f));
    expect(infractores).toEqual([]);
  });

  it("NEON_PRODUCTION_HOST como host de un job: solo el primer deltas de production", () => {
    const infractores = candidatos
      .filter((f) =>
        readFileSync(f, "utf8").includes('variableDelHost: "NEON_PRODUCTION_HOST"'),
      )
      .map(rel);
    expect(infractores).toEqual(["scripts/seed-primer-deltas.ts"]);
  });

  it("pnpm job, los crons y los scripts manuales no importan nada de production", () => {
    for (const f of ["jobs/run.ts", "jobs/registro.ts", "scripts/manual-comun.ts"]) {
      expect(readFileSync(join(RAIZ, f), "utf8"), f).not.toMatch(/production/i);
    }
  });

  it("drizzle.migrate.config.ts solo toma de destino-production los nombres de sus variables", () => {
    const texto = readFileSync(join(RAIZ, "drizzle.migrate.config.ts"), "utf8");
    const imports = [
      ...texto.matchAll(/import \{([^}]*)\} from "\.\/destino-production\.ts"/g),
    ];
    expect(imports.map((m) => m[1]?.trim())).toEqual([
      "VARIABLES_DE_PRODUCTION, variablesDefinidas",
    ]);
  });
});
