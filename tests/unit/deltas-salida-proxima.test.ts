/**
 * `leaving_soon`, derivado: `salidaProxima`. Función pura, sin base de datos.
 *
 * La regla (decidida el 2026-09-24): la oferta está `available` y la menor
 * `expires_at` **futura** de sus opciones activas cae en los próximos 30 días.
 * Una `expires_at` ya pasada no cuenta.
 */
import { describe, expect, it } from "vitest";

import type { OpcionObservada } from "../../jobs/pipelines/deltas/contratos.ts";
import {
  DIAS_DE_SALIDA_PROXIMA,
  agregar,
  salidaProxima,
} from "../../jobs/pipelines/deltas/estado.ts";

const AHORA = new Date("2026-09-24T10:00:00.000Z");
const DIA = 86_400_000;
const en = (dias: number) => new Date(AHORA.getTime() + dias * DIA);

function opcion(parcial: Partial<OpcionObservada> = {}): OpcionObservada {
  return {
    link: "https://netflix.test/a",
    calidad: null,
    precio: null,
    idiomasAudio: [],
    idiomasSubtitulos: [],
    disponibleDesde: en(-100),
    expiraEl: null,
    ...parcial,
  };
}

describe("salidaProxima: leaving_soon derivado", () => {
  it("el umbral es el medido: 30 días", () => {
    expect(DIAS_DE_SALIDA_PROXIMA).toBe(30);
  });

  it("disponible y sale dentro de 30 días → esa fecha", () => {
    expect(salidaProxima([opcion({ expiraEl: en(5) })], AHORA)).toEqual(en(5));
  });

  it("justo a 30 días entra; a 30 días y un segundo, no", () => {
    expect(salidaProxima([opcion({ expiraEl: en(30) })], AHORA)).toEqual(en(30));
    const fuera = new Date(en(30).getTime() + 1000);
    expect(salidaProxima([opcion({ expiraEl: fuera })], AHORA)).toBeNull();
  });

  it("⚖️ una expires_at YA PASADA no cuenta como salida próxima", () => {
    expect(salidaProxima([opcion({ expiraEl: en(-1) })], AHORA)).toBeNull();
  });

  it("expires_at == ahora ya es pasado", () => {
    expect(salidaProxima([opcion({ expiraEl: AHORA })], AHORA)).toBeNull();
  });

  it("una fecha pasada en una opción no tapa la futura de otra", () => {
    const opciones = [
      opcion({ link: "https://netflix.test/viejo", expiraEl: en(-3) }),
      opcion({ link: "https://netflix.test/vivo", expiraEl: en(12) }),
    ];
    // El MIN a secas de `agregar` elegiría la pasada: por eso no se reutiliza.
    expect(agregar(opciones, AHORA).expiraEl).toBe(en(-3).toISOString());
    expect(salidaProxima(opciones, AHORA)).toEqual(en(12));
  });

  it("con varias futuras, la más cercana", () => {
    const opciones = [
      opcion({ link: "https://netflix.test/a", expiraEl: en(20) }),
      opcion({ link: "https://netflix.test/b", expiraEl: en(4) }),
    ];
    expect(salidaProxima(opciones, AHORA)).toEqual(en(4));
  });

  it("sin fecha de salida → null, no se inventa", () => {
    expect(salidaProxima([opcion()], AHORA)).toBeNull();
  });

  it("un anuncio sin estrenar no «se va»: todas futuras → null", () => {
    expect(
      salidaProxima([opcion({ disponibleDesde: en(2), expiraEl: en(10) })], AHORA),
    ).toBeNull();
  });

  it("sin opciones activas → null", () => {
    expect(salidaProxima([], AHORA)).toBeNull();
  });
});
