/**
 * El comparador de `db:validate:checkpoint`.
 *
 * 📏 **Falso negativo del 2026-09-23:** 21/22, y la única comprobación fallida
 * era la de la huérfana… con la fila y el checkpoint correctos. El `id` de
 * `ops_sync_runs` es `bigint`; el driver lo devuelve como texto en un
 * `RETURNING` (`"33"`) y `leerUltimoCheckpoint` lo convierte a número (`33`).
 * `33 === "33"` es `false`. El mecanismo estaba bien; el matcher, no.
 */
import { types } from "@neondatabase/serverless";
import { describe, expect, it } from "vitest";

import type { CheckpointDeDeltas } from "../../jobs/pipelines/deltas/checkpoint.ts";
import { checkpointInicial } from "../../jobs/pipelines/deltas/checkpoint.ts";
import {
  compararCheckpoints,
  describirId,
  idNormalizado,
  mismoRunId,
} from "../../scripts/comparar-checkpoint.ts";

/** El `c2` del validador: una lista `new` a medias, con cursor. */
const C2: CheckpointDeDeltas = {
  ...checkpointInicial({
    ventana: { from: 1_790_000_000, to: 1_790_086_400 },
    tipos: ["removed", "new"],
  }),
  pendiente: { changeType: "new", cursorDeEntrada: "1790000000:42" },
  ultimoTimestampConfirmado: "2026-09-23T09:00:00.000Z",
  paginasConfirmadas: 2,
};

/**
 * Lo mismo, como lo devuelve un `jsonb`: PostgreSQL guarda las claves
 * ordenadas a su manera (primero por longitud), no en el orden de inserción.
 */
function comoJsonb(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(comoJsonb);
  if (valor === null || typeof valor !== "object") return valor;
  const entradas = Object.entries(valor as Record<string, unknown>).sort(
    ([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0),
  );
  return Object.fromEntries(entradas.map(([k, v]) => [k, comoJsonb(v)]));
}

describe("el falso negativo de la huérfana, reproducido", () => {
  it("el driver de Neon devuelve un int8 como TEXTO", () => {
    // Sin red: el mismo parser que usa el cliente al leer un `RETURNING id`.
    // El driver no tipa `types`: se declara la forma que se usa.
    const parsers = types as unknown as {
      getTypeParser(oid: number, formato: "text"): (valor: string) => unknown;
    };
    const INT8 = 20;
    expect(parsers.getTypeParser(INT8, "text")("33")).toBe("33");
  });

  it("con `===` la misma fila parecía otra; como id, es la misma", () => {
    const idHuerfana: unknown = "33"; // RETURNING id, tal cual
    const runIdLeido: unknown = 33; // leerUltimoCheckpoint → Number(fila.id)
    expect(runIdLeido === idHuerfana).toBe(false); // lo que fallaba
    expect(mismoRunId(runIdLeido, idHuerfana)).toBe(true);
  });

  it("el checkpoint leído de jsonb, con otras claves en otro orden, es c2", () => {
    const leido = comoJsonb(JSON.parse(JSON.stringify(C2)));
    // La forma cambió: una comparación por texto también habría fallado.
    expect(JSON.stringify(leido)).not.toBe(JSON.stringify(C2));
    const c = compararCheckpoints(C2, leido);
    expect(c.diferencias).toEqual([]);
    expect(c.iguales).toBe(true);
  });
});

describe("mismoRunId no confunde filas distintas", () => {
  it.each([
    [33, 34],
    ["33", "34"],
    [33, "033x"],
    [33, null],
    [undefined, undefined],
    [1.5, "1"],
  ])("%j frente a %j → distintas", (a, b) => {
    expect(mismoRunId(a, b)).toBe(false);
  });

  it("acepta bigint y texto con espacios, y rechaza lo que no es un entero", () => {
    expect(idNormalizado(33n)).toBe(33n);
    expect(idNormalizado(" 33 ")).toBe(33n);
    expect(idNormalizado("-1")).toBeNull();
    expect(idNormalizado({})).toBeNull();
    expect(describirId("33")).toBe('"33" (string)');
  });
});

describe("compararCheckpoints detecta cada campo semántico", () => {
  const con = (cambio: Partial<CheckpointDeDeltas>) => ({ ...C2, ...cambio });

  it.each<[string, Partial<CheckpointDeDeltas>]>([
    ["ventana.from", { ventana: { from: 1_789_999_999, to: C2.ventana.to } }],
    ["ventana.to", { ventana: { from: C2.ventana.from, to: 1_790_086_401 } }],
    ["tipos", { tipos: ["new", "removed"] }],
    [
      "pendiente.changeType",
      { pendiente: { changeType: "removed", cursorDeEntrada: "1790000000:42" } },
    ],
    [
      "pendiente.cursorDeEntrada",
      { pendiente: { changeType: "new", cursorDeEntrada: "1790000000:43" } },
    ],
    ["pendiente", { pendiente: null }],
    ["paginasConfirmadas", { paginasConfirmadas: 3 }],
    [
      "ultimoTimestampConfirmado",
      { ultimoTimestampConfirmado: "2026-09-23T09:00:01.000Z" },
    ],
    ["reanudaDe", { reanudaDe: 21 }],
  ])("%s", (campo, cambio) => {
    const c = compararCheckpoints(C2, con(cambio));
    expect(c.iguales).toBe(false);
    expect(c.diferencias).toHaveLength(1);
    expect(c.diferencias[0]).toMatch(new RegExp(`^${campo.replace(".", "\\.")}:`));
  });

  it("el mismo instante con otra precisión de ms no es una diferencia", () => {
    const c = compararCheckpoints(
      C2,
      con({ ultimoTimestampConfirmado: "2026-09-23T09:00:00Z" }),
    );
    expect(c.iguales).toBe(true);
  });

  it("valida con el schema v1: una versión o una clave ajena no pasan", () => {
    const v2 = compararCheckpoints(C2, { ...C2, v: 2 });
    expect(v2.iguales).toBe(false);
    expect(v2.diferencias[0]).toMatch(/^observado no es un checkpoint v1 válido — v:/);

    const extra = compararCheckpoints(C2, { ...C2, sobra: true });
    expect(extra.iguales).toBe(false);
    expect(extra.observado).toBeNull();

    expect(compararCheckpoints(C2, undefined).iguales).toBe(false);
  });
});
