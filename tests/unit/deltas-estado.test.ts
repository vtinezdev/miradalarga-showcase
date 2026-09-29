/**
 * El agregado de una oferta lógica. Función pura, sin base de datos.
 */
import { describe, expect, it } from "vitest";

import type {
  OpcionExistente,
  OpcionObservada,
} from "../../jobs/pipelines/deltas/contratos.ts";
import { activas, agregar, esFutura } from "../../jobs/pipelines/deltas/estado.ts";

const AHORA = new Date("2026-09-22T10:00:00.000Z");
const AYER = new Date("2026-09-21T10:00:00.000Z");
const MANANA = new Date("2026-09-23T10:00:00.000Z");

function opcion(parcial: Partial<OpcionObservada> = {}): OpcionObservada {
  return {
    link: "https://netflix.test/a",
    calidad: null,
    precio: null,
    idiomasAudio: [],
    idiomasSubtitulos: [],
    disponibleDesde: AYER,
    expiraEl: null,
    ...parcial,
  };
}

describe("estado derivado", () => {
  it("sin opciones activas la oferta está `gone`", () => {
    const estado = agregar([], AHORA);
    expect(estado.estado).toBe("gone");
    expect(estado.opcionesActivas).toBe(0);
    expect(estado.disponibleDesde).toBeNull();
  });

  it("todas futuras es `upcoming`", () => {
    expect(agregar([opcion({ disponibleDesde: MANANA })], AHORA).estado).toBe(
      "upcoming",
    );
  });

  it("basta una ya disponible para que sea `available`", () => {
    const estado = agregar(
      [opcion({ disponibleDesde: MANANA }), opcion({ disponibleDesde: AYER })],
      AHORA,
    );
    expect(estado.estado).toBe("available");
  });

  it("una fecha de alta que no consta NO es futuro", () => {
    // `null` significa «no lo sabemos» (invariante 4). Una opción listada sin
    // fecha está disponible, no anunciada.
    expect(esFutura(opcion({ disponibleDesde: null }), AHORA)).toBe(false);
    expect(agregar([opcion({ disponibleDesde: null })], AHORA).estado).toBe(
      "available",
    );
  });
});

describe("los agregados de docs/DATA-MODEL.md", () => {
  it("available_since es el MÍNIMO y expires_at el mínimo de los NO nulos", () => {
    const estado = agregar(
      [
        opcion({ disponibleDesde: MANANA, expiraEl: null }),
        opcion({ disponibleDesde: AYER, expiraEl: MANANA }),
      ],
      AHORA,
    );
    expect(estado.disponibleDesde).toBe(AYER.toISOString());
    expect(estado.expiraEl).toBe(MANANA.toISOString());
  });

  it("el precio es el más barato y conserva su importe original", () => {
    const estado = agregar(
      [
        opcion({ precio: { importe: "9.99", moneda: "EUR" } }),
        opcion({ precio: { importe: "5.99", moneda: "EUR" } }),
      ],
      AHORA,
    );
    expect(estado.precio).toEqual({ importe: "5.99", moneda: "EUR" });
  });

  it("los idiomas son la UNIÓN, ordenada y sin repetir", () => {
    const estado = agregar(
      [
        opcion({ idiomasAudio: ["spa", "eng"] }),
        opcion({ idiomasAudio: ["eng", "fra"] }),
      ],
      AHORA,
    );
    expect(estado.idiomasAudio).toEqual(["eng", "fra", "spa"]);
  });

  it("las calidades son un conjunto ordenado y `null` no entra", () => {
    const estado = agregar(
      [opcion({ calidad: "hd" }), opcion({ calidad: null }), opcion({ calidad: "sd" })],
      AHORA,
    );
    expect(estado.calidades).toEqual(["hd", "sd"]);
  });
});

describe("qué opción cuenta", () => {
  function existente(ausencias: number): OpcionExistente {
    return {
      id: String(ausencias),
      link: "https://netflix.test/a",
      calidad: null,
      precio: null,
      idiomasAudio: [],
      idiomasSubtitulos: [],
      disponibleDesde: AYER,
      expiraEl: null,
      vistaPrimeroEn: AYER,
      ausenciasSeguidas: ausencias,
    };
  }

  it("activa es missing_streak < 2; 2 ya no cuenta", () => {
    const filtradas = activas([existente(0), existente(1), existente(2), existente(5)]);
    expect(filtradas.map((o) => o.ausenciasSeguidas)).toEqual([0, 1]);
  });
});
