/**
 * Separación de secretos web / jobs (docs/SECURITY.md): el Worker no carga
 * `.env`, y el verificador que corre tras `pnpm build` detecta lo que no debe
 * viajar en el artefacto. Todo sobre directorios temporales con un secreto
 * **ficticio**: ningún valor real se lee aquí.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  esVariableDeLaWeb,
  nombresDeVariables,
  verificarArtefacto,
} from "../../scripts/verificar-artefacto-web.ts";

const RAIZ = resolve(import.meta.dirname, "../..");
const FICTICIO = "clave-ficticia-de-prueba-0123456789";

let raiz = "";
afterEach(() => {
  if (raiz) rmSync(raiz, { recursive: true, force: true });
  raiz = "";
});

function proyecto(ficheros: Record<string, string>): string {
  raiz = mkdtempSync(join(tmpdir(), "artefacto-web-"));
  for (const [ruta, contenido] of Object.entries(ficheros)) {
    const destino = join(raiz, ruta);
    mkdirSync(join(destino, ".."), { recursive: true });
    writeFileSync(destino, contenido);
  }
  return raiz;
}

describe("el Worker no carga .env", () => {
  it("vite.config.ts apaga la carga de .env como variables del Worker", () => {
    const config = readFileSync(join(RAIZ, "vite.config.ts"), "utf8");
    expect(config).toMatch(
      /^process\.env\.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";$/m,
    );
    // Antes de `defineConfig`: el plugin lo lee al construir.
    expect(config.indexOf("CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV")).toBeLessThan(
      config.indexOf("export default defineConfig"),
    );
  });

  it("pnpm build ejecuta el verificador del artefacto", () => {
    const pkg = JSON.parse(readFileSync(join(RAIZ, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.build).toBe(
      "vinext build && tsx scripts/verificar-artefacto-web.ts",
    );
  });

  it(".env y .dev.vars están ignorados por git", () => {
    const ignorado = readFileSync(join(RAIZ, ".gitignore"), "utf8");
    expect(ignorado).toMatch(/^\.env$/m);
    expect(ignorado).toMatch(/^\.dev\.vars$/m);
  });
});

describe("verificador del artefacto", () => {
  it("solo nombres, y solo los de la web", () => {
    expect(nombresDeVariables("# c\nA=1\nexport B='2'\n\nC_3=x=y\n")).toEqual([
      "A",
      "B",
      "C_3",
    ]);
    expect(esVariableDeLaWeb("DATABASE_URL")).toBe(true);
    expect(esVariableDeLaWeb("NEXT_PUBLIC_SITE_URL")).toBe(true);
    expect(esVariableDeLaWeb("STREAMING_AVAILABILITY_API_KEY")).toBe(false);
    expect(esVariableDeLaWeb("DATABASE_URL_DIRECT")).toBe(false);
  });

  it("un artefacto limpio pasa", () => {
    const r = verificarArtefacto(
      proyecto({
        "dist/server/.dev.vars": "CATALOGO_FUENTE='neon'\n",
        "dist/server/index.js": "const n = 'STREAMING_AVAILABILITY_API_KEY';",
        "dist/client/app.js": "console.log('hola')",
      }),
    );
    expect(r).toEqual({ violaciones: [], avisos: [] });
  });

  it("falla si .dev.vars del servidor lleva una credencial de los jobs, sin imprimir su valor", () => {
    const r = verificarArtefacto(
      proyecto({
        "dist/server/.dev.vars": `STREAMING_AVAILABILITY_API_KEY='${FICTICIO}'\n`,
      }),
    );
    expect(r.violaciones.join("\n")).toContain("STREAMING_AVAILABILITY_API_KEY");
    expect(r.violaciones.join("\n")).not.toContain(FICTICIO);
  });

  it("falla si el cliente lleva el driver, la URL o una cadena de conexión", () => {
    const r = verificarArtefacto(
      proyecto({
        "dist/client/a.js": 'import "@neondatabase/serverless"',
        "dist/client/b.js": "process.env.DATABASE_URL",
        "dist/client/c.js": "postgresql://u:p@h/d",
      }),
    );
    expect(r.violaciones).toHaveLength(3);
  });

  it("falla si el valor de una credencial de .env o del entorno aparece en dist/, y avisa del .env", () => {
    const r = verificarArtefacto(
      proyecto({
        ".env": `STREAMING_AVAILABILITY_API_KEY=${FICTICIO}\n`,
        "dist/server/chunk.js": `const k = "${FICTICIO}";`,
      }),
    );
    expect(r.violaciones).toEqual([
      "dist/server/chunk.js contiene el valor de STREAMING_AVAILABILITY_API_KEY (.env).",
    ]);
    expect(r.avisos[0]).toContain(".env declara STREAMING_AVAILABILITY_API_KEY");
    expect(JSON.stringify(r)).not.toContain(FICTICIO);

    const desdeEntorno = verificarArtefacto(
      proyecto({ "dist/client/x.js": `"${FICTICIO}"` }),
      { DATABASE_URL_DIRECT: FICTICIO },
    );
    expect(desdeEntorno.violaciones).toEqual([
      "dist/client/x.js contiene el valor de DATABASE_URL_DIRECT (entorno).",
    ]);
  });

  it("sin dist/ no hay nada que verificar: es un error", () => {
    expect(verificarArtefacto(proyecto({})).violaciones).toHaveLength(1);
  });
});
