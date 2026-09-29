/**
 * El ciclo de facturación, **en UTC**, y la hora editorial de Madrid.
 *
 * Son dos conceptos y se prueban por separado:
 *
 *   · **Madrid** fija el *bucket* diario del histórico. Es aritmética de
 *     calendario con cambio de hora dentro —UTC+1 en invierno, UTC+2 en
 *     verano; en 2026 el salto ocurre el 29 de marzo y el 25 de octubre—, y
 *     sus fronteras **están comprobadas contra `Intl`**. Este bloque no cambia
 *     con el ciclo: el bucket es parte de la clave única de los eventos.
 *   · **El ciclo** corta a las 00:00 UTC, como el proveedor. 📏 La única
 *     frontera observada es `x-quota-reset: 2026-10-01T00:00:00Z`.
 *
 * Que el día de ciclo esté limitado a 1–28 no es una comodidad: con 29, 30 o 31
 * habría meses sin esa fecha, y la frontera del ciclo dejaría de existir.
 */
import { describe, expect, it } from "vitest";

import {
  DIA_DE_CICLO_MAXIMO,
  calcularCiclo,
  leerPresupuesto,
} from "../../jobs/ops/presupuesto.ts";
import { horaEnMadrid, medianocheEnMadrid } from "../../jobs/ops/tiempo.ts";
import { bucketDelDia } from "../../jobs/pipelines/deltas/digest.ts";

const iso = (fecha: Date): string => fecha.toISOString();

/** 📏 `spike-1/raw/018` y `ops_sync_runs` fila 21, tal y como llegó. */
const RESET_OBSERVADO = "2026-10-01T00:00:00Z";

describe("medianoche en Madrid", () => {
  it("resuelve las 00:00 de verano a UTC+2", () => {
    expect(iso(medianocheEnMadrid(2026, 9, 1))).toBe("2026-08-31T22:00:00.000Z");
  });

  it("resuelve las 00:00 de invierno a UTC+1", () => {
    expect(iso(medianocheEnMadrid(2026, 11, 1))).toBe("2026-10-31T23:00:00.000Z");
    expect(iso(medianocheEnMadrid(2026, 1, 1))).toBe("2025-12-31T23:00:00.000Z");
  });

  it("no se deja engañar por el cambio de hora de marzo", () => {
    // El 28 de marzo todavía es CET; el 28 de abril ya es CEST.
    expect(iso(medianocheEnMadrid(2026, 3, 28))).toBe("2026-03-27T23:00:00.000Z");
    expect(iso(medianocheEnMadrid(2026, 4, 28))).toBe("2026-04-27T22:00:00.000Z");
  });

  it("no se deja engañar por el cambio de hora de octubre", () => {
    expect(iso(medianocheEnMadrid(2026, 9, 28))).toBe("2026-09-27T22:00:00.000Z");
    expect(iso(medianocheEnMadrid(2026, 10, 28))).toBe("2026-10-27T23:00:00.000Z");
  });

  it("devuelve siempre las 00:00 de pared, no las 23:00 ni la 01:00", () => {
    for (const mes of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      const local = horaEnMadrid(medianocheEnMadrid(2026, mes, DIA_DE_CICLO_MAXIMO));
      expect(local.hora).toBe(0);
      expect(local.minuto).toBe(0);
      expect(local.dia).toBe(DIA_DE_CICLO_MAXIMO);
      expect(local.mes).toBe(mes);
    }
  });
});

describe("el ciclo con día 1, en UTC", () => {
  it("cubre el mes natural UTC", () => {
    const ciclo = calcularCiclo(new Date("2026-09-22T10:00:00.000Z"), 1);
    expect(iso(ciclo.inicio)).toBe("2026-09-01T00:00:00.000Z");
    expect(iso(ciclo.fin)).toBe("2026-10-01T00:00:00.000Z");
    expect(ciclo.clave).toBe(202609);
  });

  it("su fin es exactamente el reinicio que anunció el proveedor", () => {
    const ciclo = calcularCiclo(new Date("2026-09-23T12:00:00.000Z"), 1);
    expect(ciclo.fin.getTime()).toBe(Date.parse(RESET_OBSERVADO));
  });

  it("es medio abierto: el instante del corte pertenece al ciclo NUEVO", () => {
    const justoAntes = calcularCiclo(new Date("2026-08-31T23:59:59.999Z"), 1);
    const justoEn = calcularCiclo(new Date("2026-09-01T00:00:00.000Z"), 1);
    expect(justoAntes.clave).toBe(202608);
    expect(justoEn.clave).toBe(202609);
    // Sin solape y sin hueco: el fin de uno es el inicio del siguiente.
    expect(iso(justoAntes.fin)).toBe(iso(justoEn.inicio));
  });

  it("la franja 22:00–24:00 UTC del último día sigue en el ciclo viejo", () => {
    // Es la franja que el ciclo de Madrid atribuía al mes siguiente: el
    // proveedor todavía no ha reiniciado, y el libro tampoco.
    for (const instante of [
      "2026-09-30T22:00:00.000Z",
      "2026-09-30T23:00:00.000Z",
      "2026-09-30T23:59:59.999Z",
    ]) {
      expect(calcularCiclo(new Date(instante), 1).clave).toBe(202609);
    }
  });

  it("cruza bien el cambio de año", () => {
    const ciclo = calcularCiclo(new Date("2026-01-05T00:00:00.000Z"), 1);
    expect(iso(ciclo.inicio)).toBe("2026-01-01T00:00:00.000Z");
    expect(ciclo.clave).toBe(202601);
    const nochevieja = calcularCiclo(new Date("2025-12-31T23:30:00.000Z"), 1);
    expect(nochevieja.clave).toBe(202512);
    expect(iso(nochevieja.fin)).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("el ciclo con otro día de corte", () => {
  it("con día 15 va del 15 al 15", () => {
    const ciclo = calcularCiclo(new Date("2026-09-22T10:00:00.000Z"), 15);
    expect(iso(ciclo.inicio)).toBe("2026-09-15T00:00:00.000Z");
    expect(iso(ciclo.fin)).toBe("2026-10-15T00:00:00.000Z");
  });

  it("el cambio de hora ya no le quita ni le da una hora", () => {
    // Con el ciclo en Madrid esto valía 31 × 24 − 1 (CET → CEST). En UTC no hay
    // cambio de hora: un ciclo de 31 días dura exactamente 31 × 24 horas.
    const marzo = calcularCiclo(new Date("2026-04-10T00:00:00.000Z"), 28);
    expect(iso(marzo.inicio)).toBe("2026-03-28T00:00:00.000Z");
    expect(iso(marzo.fin)).toBe("2026-04-28T00:00:00.000Z");
    expect((marzo.fin.getTime() - marzo.inicio.getTime()) / 3_600_000).toBe(31 * 24);

    const octubre = calcularCiclo(new Date("2026-10-26T12:00:00.000Z"), 1);
    expect((octubre.fin.getTime() - octubre.inicio.getTime()) / 3_600_000).toBe(
      31 * 24,
    );
  });

  it("toda frontera cae a las 00:00:00.000 UTC, para todo día y mes", () => {
    for (let dia = 1; dia <= DIA_DE_CICLO_MAXIMO; dia++) {
      for (let mes = 1; mes <= 12; mes++) {
        const ciclo = calcularCiclo(new Date(Date.UTC(2026, mes - 1, dia, 12)), dia);
        for (const borde of [ciclo.inicio, ciclo.fin]) {
          expect(borde.getUTCHours()).toBe(0);
          expect(borde.getUTCMinutes()).toBe(0);
          expect(borde.getUTCSeconds()).toBe(0);
          expect(borde.getUTCMilliseconds()).toBe(0);
          expect(borde.getUTCDate()).toBe(dia);
        }
      }
    }
  });

  it("cualquier instante cae dentro de su propio ciclo, para todo día válido", () => {
    const instante = new Date("2026-10-28T00:30:00.000Z");
    for (let dia = 1; dia <= DIA_DE_CICLO_MAXIMO; dia++) {
      const ciclo = calcularCiclo(instante, dia);
      expect(ciclo.inicio.getTime()).toBeLessThanOrEqual(instante.getTime());
      expect(ciclo.fin.getTime()).toBeGreaterThan(instante.getTime());
    }
  });

  it("no depende de la zona horaria del proceso", () => {
    // `calcularCiclo` solo usa getters `getUTC*`. Si alguien metiera un
    // `getMonth()`, en un runner con TZ distinta de UTC la frontera se movería.
    const fuente = calcularCiclo.toString();
    expect(fuente).not.toMatch(/\.get(FullYear|Month|Date|Hours)\(/);
  });
});

describe("el ciclo y el bucket del día discrepan a propósito", () => {
  it("el 30 de septiembre a las 23:00 UTC: ciclo de septiembre, bucket del 1 de octubre", () => {
    const instante = new Date("2026-09-30T23:00:00.000Z");
    expect(calcularCiclo(instante, 1).clave).toBe(202609);
    // 01:00 del 1 de octubre en Madrid (CEST): el bucket editorial ya cambió.
    expect(iso(bucketDelDia(instante))).toBe("2026-09-30T22:00:00.000Z");
    const local = horaEnMadrid(bucketDelDia(instante));
    expect([local.mes, local.dia, local.hora]).toEqual([10, 1, 0]);
  });
});

describe("el día de ciclo se valida", () => {
  it("acepta 1 y 28", () => {
    expect(leerPresupuesto({ STREAMING_API_BUDGET_CYCLE_DAY: "1" }).diaDeCiclo).toBe(1);
    expect(leerPresupuesto({ STREAMING_API_BUDGET_CYCLE_DAY: "28" }).diaDeCiclo).toBe(
      28,
    );
  });

  it("rechaza 0 y 29, que es justo donde empiezan los meses sin esa fecha", () => {
    expect(() => leerPresupuesto({ STREAMING_API_BUDGET_CYCLE_DAY: "0" })).toThrow(
      /entre 1 y 28/,
    );
    expect(() => leerPresupuesto({ STREAMING_API_BUDGET_CYCLE_DAY: "29" })).toThrow(
      /entre 1 y 28/,
    );
  });
});
