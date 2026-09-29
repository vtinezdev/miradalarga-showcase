/**
 * Conservación del crudo (ADR 0009 §4): copia verificada por huella, recibo al
 * lado del crudo, y la comprobación que exige la carga real —dos copias, una
 * fuera del equipo—. Con directorios temporales de verdad. Y qué crudo va a
 * qué rama.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  archivarCrudo,
  comprobarCopias,
  leerRecibo,
} from "../../jobs/pipelines/seed/crudo/copias.ts";
import { escribirCrudo } from "../../jobs/pipelines/seed/crudo/disco.ts";
import { exigirCrudoParaRama } from "../../scripts/seed-comun.ts";
import { capturar, fijarReloj } from "./ayudas-seed.ts";
import { PAGINAS_BASE } from "./ayudas-seed-fixtures.ts";

let raiz: string;
beforeEach(() => {
  raiz = mkdtempSync(join(tmpdir(), "seed-copias-"));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(raiz, { recursive: true, force: true });
});

async function crudoEnDisco(): Promise<string> {
  fijarReloj();
  const c = await capturar({ paginas: PAGINAS_BASE });
  vi.useRealTimers();
  const d = join(raiz, "seed-es-prueba");
  escribirCrudo(d, c.contenido);
  return d;
}

describe("copias del crudo", () => {
  it("sin copias no se carga; con una verificada pero dentro del equipo, tampoco", async () => {
    const d = await crudoEnDisco();
    expect(comprobarCopias(d).ok).toBe(false);
    archivarCrudo(d, join(raiz, "copia-local"), { fueraDelEquipo: false });
    const e = comprobarCopias(d);
    expect(e).toMatchObject({ ok: false, copiasValidas: 1, fueraDelEquipo: 0 });
    expect(e.problemas.join()).toMatch(/fuera del equipo/);
  });

  it("original + una copia fuera del equipo, con la misma huella: se carga", async () => {
    const d = await crudoEnDisco();
    const c = archivarCrudo(d, join(raiz, "externo", "seed"), { fueraDelEquipo: true });
    expect(comprobarCopias(d)).toMatchObject({
      ok: true,
      copiasValidas: 1,
      fueraDelEquipo: 1,
    });
    expect(leerRecibo(d)?.copias).toEqual([c]);
    expect(leerRecibo(d)?.huella).toBe(c.huella);
  });

  it("una copia accesible que ya no verifica deja de contar", async () => {
    const d = await crudoEnDisco();
    const destino = join(raiz, "externo");
    archivarCrudo(d, destino, { fueraDelEquipo: true });
    writeFileSync(join(destino, "plan.json"), "{}");
    expect(comprobarCopias(d).ok).toBe(false);
  });

  it("nunca sobre el original, dentro de él, ni sobre un destino con ficheros", async () => {
    const d = await crudoEnDisco();
    expect(() => archivarCrudo(d, d, { fueraDelEquipo: true })).toThrow(/original/);
    expect(() => archivarCrudo(d, join(d, "sub"), { fueraDelEquipo: true })).toThrow(
      /original/,
    );
    const lleno = join(raiz, "lleno");
    escribirCrudo(lleno, new Map([["x", new Uint8Array([1])]]));
    expect(() => archivarCrudo(d, lleno, { fueraDelEquipo: true })).toThrow(
      /no está vacío/,
    );
  });

  it("un crudo que no verifica no se archiva", async () => {
    const d = await crudoEnDisco();
    writeFileSync(join(d, "sobra.txt"), "x");
    expect(() => archivarCrudo(d, join(raiz, "c"), { fueraDelEquipo: true })).toThrow(
      /no verifica/,
    );
  });
});

describe("copias con otro verificador (el directorio de M1)", () => {
  // Un verificador mínimo: la huella es el contenido de «id», y sin él no verifica.
  const porId = (d: string): { huella: string; capturaId: string } => {
    const id = readFileSync(join(d, "id"), "utf8");
    return { huella: id.padEnd(64, "0"), capturaId: "m1-prueba" };
  };

  it("copia, relee con ese verificador y exige la misma huella; el recibo va al lado", () => {
    const d = join(raiz, "m1-prueba");
    escribirCrudo(d, new Map([["id", new TextEncoder().encode("abc")]]));
    archivarCrudo(d, join(raiz, "local"), { fueraDelEquipo: false, verificar: porId });
    archivarCrudo(d, join(raiz, "fuera"), { fueraDelEquipo: true, verificar: porId });
    expect(comprobarCopias(d, porId)).toMatchObject({
      ok: true,
      copiasValidas: 2,
      fueraDelEquipo: 1,
    });
    expect(leerRecibo(d)?.capturaId).toBe("m1-prueba");
    // Sin su verificador, el directorio de M1 no es un crudo de captura.
    expect(() => comprobarCopias(d)).toThrow(/no verifica/);
    // Una copia alterada deja de contar.
    writeFileSync(join(raiz, "fuera", "id"), "abd");
    expect(comprobarCopias(d, porId)).toMatchObject({ ok: false, fueraDelEquipo: 0 });
  });
});

describe("qué crudo va a qué rama", () => {
  it("ensayo solo a seed-bootstrap-v1-test; real solo a seed-real-v1-test", () => {
    expect(() => exigirCrudoParaRama(true, "seed-bootstrap-v1-test")).not.toThrow();
    expect(() => exigirCrudoParaRama(false, "seed-real-v1-test")).not.toThrow();
    expect(() => exigirCrudoParaRama(true, "seed-real-v1-test")).toThrow();
    expect(() => exigirCrudoParaRama(false, "seed-bootstrap-v1-test")).toThrow();
    expect(() => exigirCrudoParaRama(false, "drizzle-schema-v1-test")).toThrow();
  });
});
