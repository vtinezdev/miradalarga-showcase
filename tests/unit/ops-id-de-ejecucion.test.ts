/**
 * El `runId` se normaliza **una vez**, en la frontera de `jobs/ops`.
 *
 * 📏 `ops_sync_runs.id` es `bigint` y el driver de Neon lo devuelve como texto
 * (`"33"`). Declararlo `number` sin convertirlo hizo fallar una comprobación
 * de `db:validate:checkpoint` con la fila correcta (`33 === "33"`).
 */
import { describe, expect, it } from "vitest";

import { leerUltimoCheckpoint } from "../../jobs/ops/checkpoint.ts";
import type { EjecutorSql } from "../../jobs/ops/contratos.ts";
import { idDeEjecucion } from "../../jobs/ops/contratos.ts";
import { abrirEjecucion, ejecutarJob } from "../../jobs/ops/ejecucion.ts";
import { leerPresupuesto } from "../../jobs/ops/presupuesto.ts";

describe("idDeEjecucion", () => {
  it('"33" → 33: el texto con el que el driver devuelve un bigint', () => {
    expect(idDeEjecucion("33")).toBe(33);
  });

  it("33n → 33", () => {
    expect(idDeEjecucion(33n)).toBe(33);
  });

  it("33 → 33", () => {
    expect(idDeEjecucion(33)).toBe(33);
  });

  it.each([
    ["abc"],
    [""],
    [" 33"],
    ["33.0"],
    ["-5"],
    ["1e3"],
    [null],
    [undefined],
    [{}],
  ])("%j no es un id → error", (valor) => {
    expect(() => idDeEjecucion(valor)).toThrow(/Id de ejecución/);
  });

  it("más allá de Number.MAX_SAFE_INTEGER → error, nunca un id redondeado", () => {
    const pasado = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
    // Como texto: `Number("9007199254740993")` daría 9007199254740992.
    expect(() => idDeEjecucion(pasado.toString())).toThrow(/entero positivo seguro/);
    // Como bigint: se rechaza antes de convertir.
    expect(() => idDeEjecucion(pasado)).toThrow(/fuera del rango seguro/);
    // Y el propio máximo sigue siendo válido.
    expect(idDeEjecucion(String(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("0, negativos y no enteros → error", () => {
    expect(() => idDeEjecucion(0)).toThrow();
    expect(() => idDeEjecucion("0")).toThrow();
    expect(() => idDeEjecucion(-1)).toThrow();
    expect(() => idDeEjecucion(-1n)).toThrow();
    expect(() => idDeEjecucion(1.5)).toThrow();
    expect(() => idDeEjecucion(Number.NaN)).toThrow();
  });
});

/** Un ejecutor que contesta al INSERT y a la lectura del checkpoint como Neon: id en texto. */
function comoNeon(id: unknown): EjecutorSql {
  const responder = (texto: string): unknown[] => {
    if (texto.includes("pg_try_advisory_lock")) return [{ tomado: true }];
    if (texto.includes("INSERT INTO ops_sync_runs")) return [{ id }];
    if (texto.includes("checkpoint IS NOT NULL")) {
      return [{ id, status: "failed", checkpoint: { v: 1 } }];
    }
    return [];
  };
  return {
    ejecutar<T>(texto: string): Promise<readonly T[]> {
      return Promise.resolve(responder(texto) as readonly T[]);
    },
  };
}

describe("la frontera entrega number al resto del sistema", () => {
  const presupuesto = leerPresupuesto({});

  it("abrirEjecucion convierte el id del driver", async () => {
    const id = await abrirEjecucion(comoNeon("33"), {
      pipeline: "seed",
      presupuesto,
      ahora: new Date("2026-09-23T10:00:00.000Z"),
      commitSha: null,
    });
    expect(id).toBe(33);
    expect(typeof id).toBe("number");
  });

  it("el cuerpo de un job recibe ctx.runId como number", async () => {
    let visto: unknown = null;
    const r = await ejecutarJob(
      comoNeon("33"),
      { pipeline: "seed", presupuesto },
      (ctx) => {
        visto = ctx.runId;
        return Promise.resolve();
      },
    );
    expect(visto).toBe(33);
    expect(r.ejecutado && r.runId).toBe(33);
  });

  it("un id ilegible en el INSERT hace fallar el job, no viaja corrupto", async () => {
    await expect(
      ejecutarJob(comoNeon("no-es-un-id"), { pipeline: "seed", presupuesto }, () =>
        Promise.resolve(),
      ),
    ).rejects.toThrow(/Id de ejecución no numérico/);
  });

  it("leerUltimoCheckpoint también entrega number", async () => {
    const ultimo = await leerUltimoCheckpoint(comoNeon("33"), "deltas");
    expect(ultimo?.runId).toBe(33);
  });
});
