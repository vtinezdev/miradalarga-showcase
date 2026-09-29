/**
 * **La huella canónica leída de la base** (`huella-base.ts`) tiene que dar lo
 * mismo que la calculada offline desde el crudo, con los tipos que entrega el
 * driver (`Date` para `timestamptz`), en cualquier orden, y separarse ante la
 * menor diferencia. **0 API, 0 Neon.**
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { EjecutorSql } from "../../jobs/ops/contratos.ts";
import { CAPACIDADES_MVP } from "../../jobs/pipelines/seed/capacidades.ts";
import type { CrudoVerificado } from "../../jobs/pipelines/seed/crudo/verificar.ts";
import { verificarCrudo } from "../../jobs/pipelines/seed/crudo/verificar.ts";
import {
  SQL_FILAS_CANONICAS,
  canonizarFilas,
  huellaCanonicaDelDestino,
} from "../../jobs/pipelines/seed/huella-base.ts";
import type { FilasCanonicas } from "../../jobs/pipelines/seed/huella-catalogo.ts";
import {
  COLUMNAS_CANONICAS,
  filasCanonicasDesdeSeed,
} from "../../jobs/pipelines/seed/huella-catalogo.ts";
import { PLATAFORMAS_MVP } from "../../jobs/pipelines/seed/plataformas.ts";
import { capturar, fijarReloj } from "./ayudas-seed.ts";
import { PAGINAS_BASE } from "./ayudas-seed-fixtures.ts";

type Tabla = keyof FilasCanonicas;
type Fila = Record<string, unknown>;

let CRUDO: CrudoVerificado;
let OFFLINE: FilasCanonicas;

const INSTANTES = new Set([
  "url_expires_at",
  "captured_at",
  "last_checked_at",
  "available_since",
  "expires_at",
  "first_seen_at",
  "last_seen_at",
]);

/** Como las devolvería el driver: `Date` en los `timestamptz`, orden invertido. */
function comoDelDriver(filas: readonly Readonly<Fila>[]): Fila[] {
  return [...filas]
    .reverse()
    .map((f) =>
      Object.fromEntries(
        Object.entries(f).map(([c, v]) => [
          c,
          INSTANTES.has(c) && typeof v === "string" ? new Date(v) : v,
        ]),
      ),
    );
}

/** Un ejecutor que responde a cada SELECT canónico con sus filas. */
function baseFalsa(tablas: FilasCanonicas, mutar?: (t: Tabla, f: Fila[]) => Fila[]) {
  const porSql = new Map<string, Tabla>(
    (Object.keys(SQL_FILAS_CANONICAS) as Tabla[]).map((t) => [
      SQL_FILAS_CANONICAS[t],
      t,
    ]),
  );
  const ejecutor: EjecutorSql = {
    ejecutar<T>(texto: string) {
      const tabla = porSql.get(texto);
      if (tabla === undefined)
        return Promise.reject(new Error(`SQL inesperado: ${texto}`));
      const filas = comoDelDriver(tablas[tabla]);
      return Promise.resolve((mutar?.(tabla, filas) ?? filas) as readonly T[]);
    },
  };
  return ejecutor;
}

beforeAll(async () => {
  fijarReloj();
  const c = await capturar({ paginas: PAGINAS_BASE });
  const v = verificarCrudo(c.contenido);
  if (v.crudo === null) throw new Error(JSON.stringify(v.problemas));
  CRUDO = v.crudo;
  OFFLINE = filasCanonicasDesdeSeed(CRUDO.filas, {
    plataformas: PLATAFORMAS_MVP,
    capacidades: CAPACIDADES_MVP,
  });
});

afterAll(() => {
  vi.useRealTimers();
});

describe("el contrato de columnas", () => {
  it("el cálculo offline produce exactamente COLUMNAS_CANONICAS en cada tabla", () => {
    for (const tabla of Object.keys(COLUMNAS_CANONICAS) as Tabla[]) {
      for (const fila of OFFLINE[tabla]) {
        expect(Object.keys(fila).sort()).toEqual([...COLUMNAS_CANONICAS[tabla]].sort());
      }
    }
  });

  it("cada SELECT nombra todas sus columnas canónicas y ningún id interno", () => {
    for (const tabla of Object.keys(COLUMNAS_CANONICAS) as Tabla[]) {
      const sql = SQL_FILAS_CANONICAS[tabla];
      for (const c of COLUMNAS_CANONICAS[tabla]) expect(sql).toContain(c);
      expect(sql).not.toMatch(/created_at|updated_at|sync_run_id|missing_streak/);
      expect(sql.trim()).toMatch(/^SELECT/);
    }
  });

  it("una columna ausente es un error, no un null", () => {
    expect(() => canonizarFilas("external_genres", [{ id: "drama" }])).toThrow(
      /columna name/,
    );
  });
});

describe("huella desde la base", () => {
  it("coincide con la del crudo, con tipos del driver y en otro orden", async () => {
    const leida = await huellaCanonicaDelDestino(baseFalsa(OFFLINE));
    expect(leida.huella).toBe(CRUDO.huellaCanonica);
    expect(leida.filas.external_titles).toBe(CRUDO.filas.titulos.length);
    expect(leida.filas.external_platform_capabilities).toBe(30);
  });

  it("una fila de más la separa", async () => {
    const leida = await huellaCanonicaDelDestino(
      baseFalsa(OFFLINE, (t, f) =>
        t === "external_genres" ? [...f, { id: "extra", name: "Extra" }] : f,
      ),
    );
    expect(leida.huella).not.toBe(CRUDO.huellaCanonica);
  });

  it("una fila de menos la separa", async () => {
    const leida = await huellaCanonicaDelDestino(
      baseFalsa(OFFLINE, (t, f) =>
        t === "external_availability_options" ? f.slice(1) : f,
      ),
    );
    expect(leida.huella).not.toBe(CRUDO.huellaCanonica);
  });

  it("un instante de observación distinto en un milisegundo la separa", async () => {
    const leida = await huellaCanonicaDelDestino(
      baseFalsa(OFFLINE, (t, f) =>
        t === "external_availability"
          ? f.map((x, i) =>
              i === 0
                ? {
                    ...x,
                    last_checked_at: new Date(
                      (x.last_checked_at as Date).getTime() + 1,
                    ),
                  }
                : x,
            )
          : f,
      ),
    );
    expect(leida.huella).not.toBe(CRUDO.huellaCanonica);
  });

  it("un link distinto en una opción la separa", async () => {
    const leida = await huellaCanonicaDelDestino(
      baseFalsa(OFFLINE, (t, f) =>
        t === "external_availability_options"
          ? f.map((x, i) => (i === 0 ? { ...x, link: `${String(x.link)}/otro` } : x))
          : f,
      ),
    );
    expect(leida.huella).not.toBe(CRUDO.huellaCanonica);
  });
});
