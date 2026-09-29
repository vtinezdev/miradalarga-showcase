/**
 * **`primer deltas.window.from === S`** y continuidad de las ventanas
 * siguientes (ADR 0009 §7, ADR 0006), con el ejemplo temporal del ADR.
 */
import { describe, expect, it } from "vitest";

import type { EjecucionDeDeltas } from "../../jobs/pipelines/seed/continuidad.ts";
import {
  anclaEnSegundos,
  comprobarContinuidad,
} from "../../jobs/pipelines/seed/continuidad.ts";

const S = new Date("2026-11-03T08:00:00Z");
const s = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

function deltas(
  runId: number,
  from: string,
  to: string,
  pendiente = false,
  status = "succeeded",
): EjecucionDeDeltas {
  return { runId, status, ventana: { from: s(from), to: s(to) }, pendiente };
}

describe("comprobarContinuidad", () => {
  it("sin ancla no hay nada que comprobar", () => {
    expect(comprobarContinuidad(null, [])).toEqual({ estado: "sin_ancla" });
  });

  it("sin deltas, la comprobación queda preparada, no superada", () => {
    expect(comprobarContinuidad(S, [])).toEqual({
      estado: "sin_deltas",
      ancla: anclaEnSegundos(S),
    });
  });

  it("el primer deltas de validación del ADR: [08:00:00Z, 11:30:00Z] empieza en S", () => {
    const r = comprobarContinuidad(S, [
      deltas(7, "2026-11-03T08:00:00Z", "2026-11-03T11:30:00Z"),
    ]);
    expect(r).toMatchObject({ estado: "continua", primerRunId: 7, problemas: [] });
  });

  it("un primer deltas que no empieza en S rompe la cadena, por un segundo", () => {
    const r = comprobarContinuidad(S, [
      deltas(7, "2026-11-03T08:00:01Z", "2026-11-03T11:30:00Z"),
    ]);
    expect(r.estado).toBe("rota");
    if (r.estado === "rota") {
      expect(r.problemas[0]).toMatchObject({
        tipo: "primer_deltas_no_empieza_en_el_ancla",
      });
    }
  });

  it("S truncado al segundo: los milisegundos del ancla no cuentan", () => {
    const conMs = new Date("2026-11-03T08:00:00.999Z");
    expect(
      comprobarContinuidad(conMs, [
        deltas(1, "2026-11-03T08:00:00Z", "2026-11-03T09:00:00Z"),
      ]).estado,
    ).toBe("continua");
  });

  it("el orden es por id, no por el orden de llegada", () => {
    const r = comprobarContinuidad(S, [
      deltas(9, "2026-11-04T04:37:00Z", "2026-11-05T04:37:00Z"),
      deltas(8, "2026-11-03T08:00:00Z", "2026-11-04T04:37:00Z"),
    ]);
    expect(r).toMatchObject({ estado: "continua", primerRunId: 8, ejecuciones: 2 });
  });

  it("una reanudación repite exactamente la ventana pendiente, y después sigue contigua", () => {
    const r = comprobarContinuidad(S, [
      deltas(1, "2026-11-03T08:00:00Z", "2026-11-03T11:30:00Z", true, "budget_stopped"),
      deltas(2, "2026-11-03T08:00:00Z", "2026-11-03T11:30:00Z"),
      deltas(3, "2026-11-03T11:30:00Z", "2026-11-04T04:37:00Z"),
    ]);
    expect(r.estado).toBe("continua");
  });

  it("una reanudación con otra ventana se detecta", () => {
    const r = comprobarContinuidad(S, [
      deltas(1, "2026-11-03T08:00:00Z", "2026-11-03T11:30:00Z", true, "failed"),
      deltas(2, "2026-11-03T08:00:00Z", "2026-11-03T12:00:00Z"),
    ]);
    expect(r.estado).toBe("rota");
    if (r.estado === "rota") {
      expect(r.problemas[0]).toMatchObject({
        tipo: "reanudacion_con_otra_ventana",
        runId: 2,
      });
    }
  });

  it("un hueco o un solape entre ventanas se detecta", () => {
    const hueco = comprobarContinuidad(S, [
      deltas(1, "2026-11-03T08:00:00Z", "2026-11-03T11:30:00Z"),
      deltas(2, "2026-11-03T11:30:01Z", "2026-11-04T04:37:00Z"),
    ]);
    const solape = comprobarContinuidad(S, [
      deltas(1, "2026-11-03T08:00:00Z", "2026-11-03T11:30:00Z"),
      deltas(2, "2026-11-03T11:29:59Z", "2026-11-04T04:37:00Z"),
    ]);
    for (const r of [hueco, solape]) {
      expect(r.estado).toBe("rota");
      if (r.estado === "rota")
        expect(r.problemas[0]).toMatchObject({ tipo: "hueco_o_solape" });
    }
  });
});
