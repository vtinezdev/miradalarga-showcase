/**
 * La capa anticorrupción como invariante comprobable.
 *
 * `contracts.ts` define la forma que conoce todo el sistema. Si algún día
 * importa algo de un proveedor concreto, la separación se ha roto y las
 * peculiaridades de esa fuente empiezan a filtrarse al dominio — que es
 * justo lo que prohíbe la regla innegociable 2 de CLAUDE.md.
 *
 * ESLint vigila la frontera entre `src/` y `jobs/`; esta es la frontera de
 * dentro de `jobs/`, que ninguna regla de lint cubre.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RAIZ_ADAPTADORES = join(import.meta.dirname, "..", "..", "jobs", "adapters");

describe("contracts.ts", () => {
  const codigo = readFileSync(join(RAIZ_ADAPTADORES, "contracts.ts"), "utf8");

  it("no importa nada de ningún directorio de proveedor", () => {
    const proveedores = readdirSync(RAIZ_ADAPTADORES, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);

    expect(proveedores.length).toBeGreaterThan(0);
    for (const proveedor of proveedores) {
      expect(codigo).not.toContain(`./${proveedor}/`);
    }
  });

  it("no importa nada en absoluto: es la raíz de la dependencia", () => {
    const imports = codigo.match(/^\s*import\s.+from\s+["'].+["']/gm) ?? [];
    expect(imports).toEqual([]);
  });

  it("no menciona el nombre del proveedor actual", () => {
    expect(codigo.toLowerCase()).not.toContain("movieofthenight");
    expect(codigo.toLowerCase()).not.toContain("streamingoptions");
    expect(codigo.toLowerCase()).not.toContain("imageset");
  });
});
