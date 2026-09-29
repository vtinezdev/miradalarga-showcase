/**
 * **Identidades de plataforma: cuatro cosas distintas, cada una en su sitio**
 * (`src/features/catalogo/plataformas.ts`).
 *
 * - El **id canónico** de la web es exactamente el `id` que los jobs escriben en
 *   `external_platforms` (`PLATAFORMAS_MVP`): si divergen, Mis plataformas,
 *   capacidades y filtros dejan de cruzar con Neon sin que nada falle.
 * - El **id del proveedor** (`hbo`) no llega nunca a la web.
 * - **Slug y nombre públicos** son decisión de la web, no de Neon ni del
 *   proveedor.
 */
import { describe, expect, it } from "vitest";

import { PLATAFORMAS_MVP } from "../../jobs/pipelines/seed/plataformas.ts";
import { PLATAFORMAS } from "../../src/features/catalogo/desarrollo/datos.ts";
import { PLATAFORMAS_PUBLICAS } from "../../src/features/catalogo/plataformas.ts";

describe("plataformas canónicas", () => {
  it("el id canónico de la web es el `external_platforms.id` de los jobs", () => {
    expect(PLATAFORMAS_PUBLICAS.map((p) => p.id).sort()).toEqual(
      PLATAFORMAS_MVP.map((p) => p.id).sort(),
    );
  });

  it("ningún id del proveedor distinto del canónico se usa como id o slug", () => {
    const deProveedor = PLATAFORMAS_MVP.filter((p) => p.sourceId !== p.id).map(
      (p) => p.sourceId,
    );
    expect(deProveedor).toContain("hbo");
    for (const p of PLATAFORMAS_PUBLICAS) {
      expect(deProveedor).not.toContain(p.id);
      expect(deProveedor).not.toContain(p.slug);
    }
  });

  it("presentación pública vigente: HBO Max y Apple TV", () => {
    expect(PLATAFORMAS_PUBLICAS.find((p) => p.id === "max")).toEqual({
      id: "max",
      nombre: "HBO Max",
      slug: "hbo-max",
    });
    expect(PLATAFORMAS_PUBLICAS.find((p) => p.id === "apple")).toEqual({
      id: "apple",
      nombre: "Apple TV",
      slug: "apple-tv",
    });
  });

  it("slugs únicos, en minúsculas y sin caracteres de URL que escapar", () => {
    const slugs = PLATAFORMAS_PUBLICAS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(s).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it("los fixtures usan la misma presentación que Neon", () => {
    expect(PLATAFORMAS).toEqual(PLATAFORMAS_PUBLICAS.map((p) => ({ ...p })));
  });
});
