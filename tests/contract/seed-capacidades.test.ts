/**
 * Contrato de `external_platform_capabilities` (ADR 0009 §8): 30 filas de la
 * matriz de `docs/DATA-SOURCES.md` §1.4, fechada el 2026-09-21. Ninguna
 * capacidad inventada, y `upcoming = not_supported` ⇔ `PLATAFORMAS_SIN_UPCOMING`.
 */
import { describe, expect, it } from "vitest";

import {
  CAPACIDADES,
  CAPACIDADES_MVP,
  FECHA_DE_LA_MATRIZ,
  MATRIZ_DE_CAPACIDADES,
  plataformasCon,
} from "../../jobs/pipelines/seed/capacidades.ts";
import { PLATAFORMAS_MVP } from "../../jobs/pipelines/seed/plataformas.ts";
import { PLATAFORMAS_SIN_UPCOMING } from "../../jobs/pipelines/upcoming/horizonte.ts";
import { capability, capabilityStatus } from "../../src/db/schema/enums.ts";

describe("la matriz de capacidades del MVP", () => {
  it("30 filas: 6 plataformas × 5 capacidades, país es, sin repetidas", () => {
    expect(CAPACIDADES_MVP).toHaveLength(30);
    const claves = CAPACIDADES_MVP.map(
      (f) => `${f.platformId}|${f.country}|${f.capability}`,
    );
    expect(new Set(claves).size).toBe(30);
    expect(new Set(CAPACIDADES_MVP.map((f) => f.country))).toEqual(new Set(["es"]));
    expect(Object.keys(MATRIZ_DE_CAPACIDADES).sort()).toEqual(
      PLATAFORMAS_MVP.map((p) => p.id).sort(),
    );
    expect(FECHA_DE_LA_MATRIZ).toBe("2026-09-21");
  });

  it("usa exactamente los enums del esquema: cinco capacidades, cuatro estados", () => {
    expect([...CAPACIDADES]).toEqual([...capability.enumValues]);
    for (const f of CAPACIDADES_MVP) {
      expect(capabilityStatus.enumValues).toContain(f.status);
    }
  });

  it("upcoming = not_supported ⇔ PLATAFORMAS_SIN_UPCOMING: las dos fuentes no divergen", () => {
    expect(plataformasCon("upcoming", "not_supported")).toEqual(
      PLATAFORMAS_SIN_UPCOMING,
    );
  });

  it("SkyShowtime: upcoming ❌, expiring ✅, Top 10 ⚪ y popularidad ❓ (M1 no la cambia)", () => {
    expect(MATRIZ_DE_CAPACIDADES.skyshowtime).toEqual({
      expiring: "supported_with_data",
      upcoming: "not_supported",
      official_top: "supported_no_data_in_sample",
      prices: "not_supported",
      popularity_order: "unknown",
    });
  });

  it("Disney+ upcoming es ⚪, no ❌: una muestra vacía no niega la capacidad", () => {
    expect(MATRIZ_DE_CAPACIDADES.disney?.upcoming).toBe("supported_no_data_in_sample");
    expect(MATRIZ_DE_CAPACIDADES.disney?.expiring).toBe("supported_no_data_in_sample");
    expect(MATRIZ_DE_CAPACIDADES.apple?.expiring).toBe("supported_no_data_in_sample");
  });

  it("popularity_order ✅ solo en Netflix; el resto ❓, nunca ❌ sin medir", () => {
    expect(plataformasCon("popularity_order", "supported_with_data")).toEqual(
      new Set(["netflix"]),
    );
    expect(plataformasCon("popularity_order", "not_supported").size).toBe(0);
    expect(plataformasCon("popularity_order", "unknown").size).toBe(5);
  });

  it("precios solo en Prime y Apple; ❌ «no aplica» en las de suscripción", () => {
    expect(plataformasCon("prices", "supported_with_data")).toEqual(
      new Set(["prime", "apple"]),
    );
    expect(plataformasCon("prices", "not_supported")).toEqual(
      new Set(["netflix", "disney", "max", "skyshowtime"]),
    );
  });

  it("el Top 10 oficial es ✅ en todas salvo SkyShowtime", () => {
    expect(plataformasCon("official_top", "supported_with_data").size).toBe(5);
  });
});
