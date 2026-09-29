/**
 * Las ejecuciones **reales manuales** de los recorridos del horizonte
 * (`pnpm api:run:expiring --real`, `pnpm api:run:upcoming --real`) no pueden
 * gastar más que el job oficial. **Sin red, sin base de datos y sin ejecutar
 * los scripts**: `run-*-manual.ts` arrancan al importarse, así que su
 * descriptor se comprueba en el fuente y la guarda, que vive en
 * `horizonte-manual.ts`, se prueba de verdad.
 *
 * 📏 Por qué existe: `upcoming` se midió con un tope inyectado de 12 (fila 50:
 * 3 requests). Al pasar a operación con tope 8, ese 12 dejó de ser una
 * medición y habría sido una puerta trasera para gastar más que
 * `pnpm job upcoming`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { NOMBRES_DE_PIPELINE } from "../../jobs/ops/contratos.ts";
import { TOPE_POR_EJECUCION_POR_DEFECTO } from "../../jobs/ops/presupuesto.ts";
import { exigirTopeOficial } from "../../scripts/horizonte-manual.ts";

const RAIZ = join(import.meta.dirname, "..", "..");

/** El fuente sin comentarios: la prosa puede citar el 12 histórico; el código, no. */
function codigo(relativo: string): string {
  const fuente = readFileSync(join(RAIZ, relativo), "utf8");
  return fuente
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
}

describe("exigirTopeOficial", () => {
  it("upcoming: el oficial (8) se admite; 9 y el 12 histórico, no", () => {
    expect(exigirTopeOficial("upcoming", 8)).toBe(8);
    expect(exigirTopeOficial("upcoming", 1)).toBe(1);
    expect(() => exigirTopeOficial("upcoming", 9)).toThrow(/tope oficial \(8,/);
    expect(() => exigirTopeOficial("upcoming", 12)).toThrow(/No se ha pedido nada/);
  });

  it("expiring: su 12 es el oficial y se admite; 13, no", () => {
    expect(exigirTopeOficial("expiring", 12)).toBe(12);
    expect(() => exigirTopeOficial("expiring", 13)).toThrow(/tope oficial \(12,/);
  });

  it("cero, negativos y no enteros no son un tope", () => {
    for (const tope of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => exigirTopeOficial("upcoming", tope)).toThrow();
    }
  });

  it("un pipeline sin tope aprobado (0) no admite ninguno", () => {
    for (const nombre of NOMBRES_DE_PIPELINE) {
      if (TOPE_POR_EJECUCION_POR_DEFECTO[nombre] > 0) continue;
      expect(() => exigirTopeOficial(nombre, 1)).toThrow();
    }
  });
});

describe("la ejecución real comprueba el tope antes de todo", () => {
  const horizonte = codigo("scripts/horizonte-manual.ts");
  const real = horizonte.slice(horizonte.indexOf("export async function real<"));

  it("`real` llama a exigirTopeOficial antes de la credencial, el presupuesto y la conexión", () => {
    const guarda = real.indexOf("exigirTopeOficial(d.pipeline, d.tope)");
    expect(guarda).toBeGreaterThan(-1);
    for (const despues of [
      "STREAMING_AVAILABILITY_API_KEY",
      "presupuestoInyectado(",
      "conectar(",
    ]) {
      expect(real.indexOf(despues), despues).toBeGreaterThan(guarda);
    }
  });

  it("y el presupuesto que inyecta es el tope ya comprobado, no el del descriptor", () => {
    expect(real).toContain("presupuestoInyectado(d.pipeline, tope)");
    expect(real).not.toContain("presupuestoInyectado(d.pipeline, d.tope)");
  });
});

describe("run-upcoming-manual.ts usa el tope oficial, sin literal propio", () => {
  const fuente = codigo("scripts/run-upcoming-manual.ts");

  it("el tope sale de TOPE_POR_EJECUCION_POR_DEFECTO.upcoming", () => {
    expect(fuente).toMatch(/const TOPE = TOPE_POR_EJECUCION_POR_DEFECTO\.upcoming;/);
    expect(fuente).toMatch(/^\s*tope: TOPE,$/m);
    expect(fuente).toMatch(/despachar\(PIPELINE_UPCOMING, TOPE,/);
  });

  it("el override histórico de 12 ya no existe", () => {
    expect(fuente).not.toContain("TOPE_DE_MEDICION");
    expect(fuente).not.toMatch(/\btope:\s*\d/);
    expect(fuente).not.toMatch(/\bTOPE\w*\s*=\s*\d/);
    expect(fuente).not.toMatch(/\b12\b/);
  });

  it("y lo que ese tope vale hoy es exactamente el oficial: 8", () => {
    expect(TOPE_POR_EJECUCION_POR_DEFECTO.upcoming).toBe(8);
  });
});
