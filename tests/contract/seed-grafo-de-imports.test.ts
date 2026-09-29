/**
 * **0 requests, estructural** (ADR 0009 §5): la carga y `seed:verificar` no
 * pueden llegar ni al transporte —el único sitio que llama a la red— ni a un
 * driver de base de datos. Se recorre su grafo de importaciones **de valor**
 * (`import type` se borra al compilar) desde el fichero de entrada.
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const RAIZ = resolve(import.meta.dirname, "../..");

/** Importaciones de valor de un fichero: relativas y de paquetes. */
function importaciones(fichero: string): { relativas: string[]; paquetes: string[] } {
  const texto = readFileSync(fichero, "utf8");
  const relativas: string[] = [];
  const paquetes: string[] = [];
  for (const m of texto.matchAll(
    /^\s*(import|export)\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gms,
  )) {
    if (m[2] !== undefined) continue; // `import type` / `export type`
    const origen = m[3] ?? "";
    if (origen.startsWith(".")) relativas.push(resolve(dirname(fichero), origen));
    else paquetes.push(origen);
  }
  return { relativas, paquetes };
}

function grafo(entrada: string): { ficheros: Set<string>; paquetes: Set<string> } {
  const ficheros = new Set<string>();
  const paquetes = new Set<string>();
  const pendientes = [resolve(RAIZ, entrada)];
  while (pendientes.length > 0) {
    const f = pendientes.pop();
    if (f === undefined || ficheros.has(f)) continue;
    ficheros.add(f);
    const { relativas, paquetes: p } = importaciones(f);
    for (const x of p) paquetes.add(x);
    pendientes.push(...relativas);
  }
  return { ficheros, paquetes };
}

const PROHIBIDOS = [
  "jobs/ops/transporte.ts",
  "jobs/ops/index.ts",
  "jobs/ops/conexion.ts",
];
const PAQUETES_PROHIBIDOS = [
  "@neondatabase/serverless",
  "undici",
  "node:http",
  "node:https",
];

const rel = (f: string) => relative(RAIZ, f).split("\\").join("/");

describe.each([
  "jobs/pipelines/seed/carga.ts",
  "jobs/pipelines/seed/crudo/verificar.ts",
  "scripts/seed-verificar.ts",
  "jobs/pipelines/seed/captura.ts",
  "jobs/pipelines/seed/ensayo.ts",
  "jobs/pipelines/seed/huella-base.ts",
  "scripts/seed-crudo-de-ensayo.ts",
  "jobs/pipelines/seed/sonda.ts",
  "jobs/pipelines/seed/m1.ts",
  "jobs/pipelines/seed/m4.ts",
  "jobs/pipelines/seed/plan.ts",
  "jobs/pipelines/seed/crudo/copias.ts",
  "scripts/seed-plan.ts",
  "scripts/seed-m4.ts",
  "scripts/seed-archivar.ts",
  "scripts/seed-post-captura.ts",
])("%s", (entrada) => {
  const { ficheros, paquetes } = grafo(entrada);

  it("no importa el transporte, ni jobs/ops/index.ts, ni la conexión a la base", () => {
    const alcanzados = [...ficheros].map(rel);
    for (const p of PROHIBIDOS) expect(alcanzados).not.toContain(p);
  });

  it("no importa ningún cliente HTTP ni driver de PostgreSQL", () => {
    for (const p of PAQUETES_PROHIBIDOS) expect([...paquetes]).not.toContain(p);
  });

  it("el recorrido encuentra de verdad sus dependencias", () => {
    expect(ficheros.size).toBeGreaterThan(3);
  });
});

/**
 * Los scripts del seed que **sí** abren una base (`seed:cargar`,
 * `seed:validar`) necesitan el driver, pero tampoco pueden alcanzar el
 * transporte ni ningún cliente HTTP: 0 requests, estructural.
 */
describe.each(["scripts/seed-cargar.ts", "scripts/seed-validar.ts"])(
  "%s",
  (entrada) => {
    const { ficheros, paquetes } = grafo(entrada);

    it("no importa el transporte ni jobs/ops/index.ts", () => {
      const alcanzados = [...ficheros].map(rel);
      expect(alcanzados).not.toContain("jobs/ops/transporte.ts");
      expect(alcanzados).not.toContain("jobs/ops/index.ts");
    });

    it("no importa ningún cliente HTTP", () => {
      for (const p of ["undici", "node:http", "node:https"]) {
        expect([...paquetes]).not.toContain(p);
      }
    });

    it("el recorrido encuentra de verdad sus dependencias", () => {
      expect([...ficheros].map(rel)).toContain("jobs/ops/conexion.ts");
    });
  },
);

/**
 * Lo que alcanza `production` sin ser su primer `deltas` (ADR 0010): migrar,
 * preflight y huella. Tampoco pueden llegar al transporte: 0 requests,
 * estructural. (`seed:cargar` y `seed:validar`, arriba, cubren su `--production`.)
 */
describe.each([
  "scripts/production-migrar.ts",
  "scripts/production-preflight.ts",
  "scripts/seed-huella.ts",
  "scripts/production-compuerta.ts",
])("%s", (entrada) => {
  const { ficheros, paquetes } = grafo(entrada);

  it("no importa el transporte ni jobs/ops/index.ts", () => {
    const alcanzados = [...ficheros].map(rel);
    expect(alcanzados).not.toContain("jobs/ops/transporte.ts");
    expect(alcanzados).not.toContain("jobs/ops/index.ts");
  });

  it("no importa ningún cliente HTTP", () => {
    for (const p of ["undici", "node:http", "node:https"]) {
      expect([...paquetes]).not.toContain(p);
    }
  });

  it("pasa por las guardas de production", () => {
    const alcanzados = [...ficheros].map(rel);
    expect(alcanzados).toContain("scripts/production-comun.ts");
    expect(alcanzados).toContain("destino-production.ts");
  });
});

describe("el detector funciona", () => {
  it("los scripts que gastan cuota alcanzan el transporte solo por la fuente real", () => {
    for (const s of ["scripts/seed-sondear.ts", "scripts/seed-capturar.ts"]) {
      const alcanzados = [...grafo(s).ficheros].map(rel);
      expect(alcanzados).toContain("jobs/ops/transporte.ts");
      expect(alcanzados).toContain("jobs/pipelines/seed/fuente-real.ts");
    }
  });

  it("un job de /changes sí alcanza el transporte", () => {
    const alcanzados = [...grafo("jobs/pipelines/programado.ts").ficheros].map(rel);
    expect(alcanzados).toContain("jobs/ops/transporte.ts");
  });

  it("la carga no llama a pedirCuota en ningún sitio", () => {
    const texto = readFileSync(join(RAIZ, "jobs/pipelines/seed/carga.ts"), "utf8");
    expect(texto).not.toMatch(/pedirCuota\s*\(/);
  });
});
