/**
 * Locks por fase del seed (ADR 0009 §6) y **regresión** de los escritores de
 * catálogo existentes. Mismo simulador de advisory locks que
 * `ops-lock-catalogo.test.ts`: sesiones distintas sobre un servidor común.
 *
 *   sonda / captura:  A pipeline (try) ──▶ B ciclo en cada reserva. **Sin C.**
 *   carga:            A pipeline (try) ──▶ C catálogo (try) ──▶ transacción.
 */
import { describe, expect, it } from "vitest";

import { CLAVE_CATALOGO, NS_CATALOGO, NS_PIPELINE } from "../../jobs/ops/bloqueo.ts";
import type {
  EjecutorSql,
  FaseDelSeed,
  NombreDePipeline,
} from "../../jobs/ops/contratos.ts";
import {
  ESCRIBE_CATALOGO,
  ESCRIBE_CATALOGO_POR_FASE_DEL_SEED,
  FASES_DEL_SEED,
  escribeCatalogo,
} from "../../jobs/ops/contratos.ts";
import { ejecutarJob } from "../../jobs/ops/ejecucion.ts";
import type { ResultadoDeJob } from "../../jobs/ops/ejecucion.ts";
import { crearLibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import { leerPresupuesto } from "../../jobs/ops/presupuesto.ts";
import { POLITICA_DE_FASES } from "../../jobs/pipelines/seed/fases.ts";

const AHORA = new Date("2026-09-24T10:00:00.000Z");
const PRESUPUESTO = leerPresupuesto({});
const CATALOGO = `${String(NS_CATALOGO)}:${String(CLAVE_CATALOGO)}`;

function crearServidor() {
  const libro = crearLibroEnMemoria();
  const locks = new Map<string, number>();
  let siguiente = 1;
  function sesion() {
    const id = siguiente++;
    const pedidos: string[] = [];
    const ejecutor: EjecutorSql = {
      ejecutar<T>(texto: string, valores: readonly unknown[] = []) {
        const clave = `${String(valores[0])}:${String(valores[1])}`;
        if (texto.includes("pg_try_advisory_lock")) {
          pedidos.push(clave);
          const duenio = locks.get(clave);
          const tomado = duenio === undefined || duenio === id;
          if (tomado) locks.set(clave, id);
          return Promise.resolve([{ tomado }] as unknown as readonly T[]);
        }
        if (texto.includes("pg_advisory_unlock")) {
          if (locks.get(clave) === id) locks.delete(clave);
          return Promise.resolve([] as readonly T[]);
        }
        return libro.ejecutor.ejecutar<T>(texto, valores);
      },
    };
    return { ejecutor, pedidos, id };
  }
  return { libro, locks, sesion };
}

const correr = (
  ejecutor: EjecutorSql,
  pipeline: NombreDePipeline,
  fase?: FaseDelSeed,
  cuerpo: () => Promise<void> = () => Promise.resolve(),
): Promise<ResultadoDeJob> =>
  ejecutarJob(
    ejecutor,
    {
      pipeline,
      presupuesto: PRESUPUESTO,
      ahora: AHORA,
      ...(fase === undefined ? {} : { fase }),
    },
    cuerpo,
  );

function compuerta() {
  let abrir = (): void => undefined;
  const abierta = new Promise<void>((r) => (abrir = r));
  return { abierta, abrir: () => abrir() };
}

describe("la política, fijada", () => {
  it("mapa cerrado por fase: sonda y captura no escriben catálogo; carga sí", () => {
    expect(ESCRIBE_CATALOGO_POR_FASE_DEL_SEED).toEqual({
      sonda: false,
      captura: false,
      carga: true,
    });
    expect([...FASES_DEL_SEED]).toEqual(["sonda", "captura", "carga"]);
    for (const f of FASES_DEL_SEED) {
      expect(POLITICA_DE_FASES[f].escribeCatalogo).toBe(
        ESCRIBE_CATALOGO_POR_FASE_DEL_SEED[f],
      );
    }
    expect(POLITICA_DE_FASES.carga).toMatchObject({
      reservaCuota: false,
      estados: ["succeeded", "failed"],
    });
  });

  it("ninguna otra entrada de ESCRIBE_CATALOGO cambia (regresión)", () => {
    expect(ESCRIBE_CATALOGO).toEqual({
      seed: "por_fase",
      deltas: true,
      expiring: true,
      upcoming: true,
      updated: true,
      reconcile: true,
      enrich: true,
      popularity: false,
      scoring: false,
      changes_validation: false,
    });
  });

  it("un seed sin fase declarada toma el lock, como antes: el lado seguro", () => {
    expect(escribeCatalogo("seed")).toBe(true);
  });

  it("una fase en un pipeline sin fases es un error, antes de tomar ningún lock", async () => {
    expect(() => escribeCatalogo("deltas", "carga")).toThrow(/no tiene fases/);
    const s = crearServidor().sesion();
    await expect(correr(s.ejecutor, "deltas", "sonda")).rejects.toThrow(
      /no tiene fases/,
    );
    expect(s.pedidos).toEqual([]);
  });
});

describe("qué locks toma cada fase", () => {
  it.each([
    ["sonda", false],
    ["captura", false],
    ["carga", true],
  ] as const)("seed/%s toma C: %s", async (fase, tomaC) => {
    const s = crearServidor().sesion();
    const r = await correr(s.ejecutor, "seed", fase);
    expect(r.ejecutado).toBe(true);
    expect(s.pedidos[0]).toBe(`${String(NS_PIPELINE)}:1`);
    expect(s.pedidos.includes(CATALOGO)).toBe(tomaC);
  });

  it.each(["deltas", "expiring", "upcoming", "updated"] as const)(
    "regresión: %s sigue tomando A y después C",
    async (pipeline) => {
      const s = crearServidor().sesion();
      await correr(s.ejecutor, pipeline);
      expect(s.pedidos).toHaveLength(2);
      expect(s.pedidos[1]).toBe(CATALOGO);
    },
  );
});

describe("convivencia con los escritores de catálogo", () => {
  it("con una captura viva, deltas escribe: la captura no bloquea el catálogo", async () => {
    const servidor = crearServidor();
    const puerta = compuerta();
    const captura = correr(
      servidor.sesion().ejecutor,
      "seed",
      "captura",
      () => puerta.abierta,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(servidor.locks.has(CATALOGO)).toBe(false);
    const deltas = await correr(servidor.sesion().ejecutor, "deltas");
    expect(deltas).toMatchObject({ ejecutado: true, estado: "succeeded" });
    puerta.abrir();
    await captura;
  });

  it("con una carga viva, deltas se va con catalogo_ocupado", async () => {
    const servidor = crearServidor();
    const puerta = compuerta();
    const carga = correr(
      servidor.sesion().ejecutor,
      "seed",
      "carga",
      () => puerta.abierta,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(await correr(servidor.sesion().ejecutor, "deltas")).toEqual({
      ejecutado: false,
      motivo: "catalogo_ocupado",
    });
    puerta.abrir();
    await carga;
    expect(servidor.locks.size).toBe(0);
  });

  it("con una sonda viva, otra ejecución del seed no entra (lock A)", async () => {
    const servidor = crearServidor();
    const puerta = compuerta();
    const sonda = correr(
      servidor.sesion().ejecutor,
      "seed",
      "sonda",
      () => puerta.abierta,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(await correr(servidor.sesion().ejecutor, "seed", "carga")).toEqual({
      ejecutado: false,
      motivo: "ya_hay_una_viva",
    });
    puerta.abrir();
    await sonda;
  });
});
