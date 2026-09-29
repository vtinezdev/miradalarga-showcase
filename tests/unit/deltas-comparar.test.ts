/**
 * De dos estados a un evento.
 *
 * El test que más importa es el de la rotación de deeplinks: es el que impide
 * que el diferencial de producto —«en Netflix desde…»— se llene de altas y
 * bajas que nunca ocurrieron.
 */
import { describe, expect, it } from "vitest";

import type { OpcionObservada } from "../../jobs/pipelines/deltas/contratos.ts";
import { compararEstados, diferencias } from "../../jobs/pipelines/deltas/comparar.ts";
import { agregar } from "../../jobs/pipelines/deltas/estado.ts";

const AHORA = new Date("2026-09-22T10:00:00.000Z");
const AYER = new Date("2026-09-21T10:00:00.000Z");
const MANANA = new Date("2026-09-23T10:00:00.000Z");

function opcion(parcial: Partial<OpcionObservada> = {}): OpcionObservada {
  return {
    link: "https://sky.test/a-loud-house-christmas",
    calidad: "hd",
    precio: null,
    idiomasAudio: ["spa"],
    idiomasSubtitulos: ["spa"],
    disponibleDesde: AYER,
    expiraEl: null,
    ...parcial,
  };
}

const VACIO = agregar([], AHORA);

describe("las cuatro transiciones de docs/DATA-MODEL.md", () => {
  it("0 → ≥1 todas futuras es `announced`", () => {
    const evento = compararEstados(
      VACIO,
      agregar([opcion({ disponibleDesde: MANANA })], AHORA),
    );
    expect(evento?.tipo).toBe("announced");
    expect(evento?.camposCambiados).toBeNull();
  });

  it("0 → ≥1 ya disponible es `added`", () => {
    const evento = compararEstados(VACIO, agregar([opcion()], AHORA));
    expect(evento?.tipo).toBe("added");
  });

  it("≥1 → 0 es `removed`", () => {
    const evento = compararEstados(agregar([opcion()], AHORA), VACIO);
    expect(evento?.tipo).toBe("removed");
  });

  it("sin opciones a ningún lado no hay evento", () => {
    expect(compararEstados(VACIO, VACIO)).toBeNull();
  });

  it("dos estados idénticos no producen evento", () => {
    const estado = agregar([opcion()], AHORA);
    expect(compararEstados(estado, estado)).toBeNull();
  });
});

describe("la rotación de deeplinks NO es un alta ni una baja", () => {
  it("cambiar de slug con los mismos valores no produce evento", () => {
    // 📏 SkyShowtime devolvió el mismo contenido bajo cuatro slugs distintos.
    // El agregado no distingue el enlace a propósito: las altas y bajas se
    // emiten en el padre, y el enlace vive en la opción.
    const antes = agregar([opcion({ link: "https://sky.test/a-loud-house" })], AHORA);
    const despues = agregar(
      [opcion({ link: "https://sky.test/una-navidad-de-locos" })],
      AHORA,
    );
    expect(compararEstados(antes, despues)).toBeNull();
  });

  it("si entra una variante de verdad, es `changed` con `options`", () => {
    const antes = agregar([opcion({ calidad: "hd" })], AHORA);
    const despues = agregar(
      [opcion({ calidad: "hd" }), opcion({ calidad: "uhd", link: "https://x.test/b" })],
      AHORA,
    );
    const evento = compararEstados(antes, despues);
    expect(evento?.tipo).toBe("changed");
    expect(evento?.camposCambiados).toContain("options");
    expect(evento?.camposCambiados).toContain("quality");
  });
});

describe("changed_fields habla el vocabulario del esquema", () => {
  it("nombra price, expires_at y audio_languages", () => {
    const antes = agregar([opcion()], AHORA);
    const despues = agregar(
      [
        opcion({
          precio: { importe: "5.99", moneda: "EUR" },
          expiraEl: MANANA,
          idiomasAudio: ["spa", "eng"],
        }),
      ],
      AHORA,
    );
    expect(diferencias(antes, despues)).toEqual([
      "audio_languages",
      "expires_at",
      "price",
    ]);
  });

  it("el cambio de estado derivado se nombra `state`", () => {
    const antes = agregar([opcion({ disponibleDesde: MANANA })], AHORA);
    const despues = agregar([opcion({ disponibleDesde: MANANA })], MANANA);
    expect(diferencias(antes, despues)).toContain("state");
  });

  it("los campos vienen ordenados: el digest depende de ello", () => {
    const antes = agregar([opcion()], AHORA);
    const despues = agregar(
      [opcion({ calidad: "uhd", precio: { importe: "1.00", moneda: "EUR" } })],
      AHORA,
    );
    const campos = diferencias(antes, despues);
    expect([...campos].sort()).toEqual(campos);
  });
});
