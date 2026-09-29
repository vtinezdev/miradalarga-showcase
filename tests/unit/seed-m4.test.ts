/**
 * M4 (ADR 0009 §7): refutado, compatible, sin muestras, ambiguo y sin
 * información, sobre páginas y avisos sintéticos y sobre un crudo generado por
 * la captura de verdad. M4 nunca afirma una cota del retraso.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TituloCanonico } from "../../jobs/adapters/contracts.ts";
import { normalizarShow } from "../../jobs/adapters/streaming-availability/normalizar.ts";
import { showProveedor } from "../../jobs/adapters/streaming-availability/schema.ts";
import { verificarCrudo } from "../../jobs/pipelines/seed/crudo/verificar.ts";
import type { AvisoParaM4, PaginaParaM4 } from "../../jobs/pipelines/seed/m4.ts";
import {
  analizarM4,
  avisosDesdeRespuestas,
  m4PermiteProduction,
  paginasDelCrudo,
} from "../../jobs/pipelines/seed/m4.ts";
import type { OpcionDeShow } from "./ayudas-seed.ts";
import { capturar, fijarReloj, show } from "./ayudas-seed.ts";
import { A, PAGINAS_BASE } from "./ayudas-seed-fixtures.ts";

beforeEach(() => fijarReloj());
afterEach(() => vi.useRealTimers());

const S = new Date("2026-11-03T08:00:00Z");
const T1 = new Date("2026-11-03T09:15:00Z");
const h = (hhmmss: string) => new Date(`2026-11-03T${hhmmss}Z`);

function titulo(imdb: string, opciones: readonly OpcionDeShow[]): TituloCanonico {
  const t = normalizarShow(showProveedor.parse(show(imdb, { opciones })), "es");
  if (t === null) throw new Error("sin título");
  return t;
}

function pagina(
  n: number,
  r: string,
  q: string,
  titulos: TituloCanonico[],
): PaginaParaM4 {
  return {
    n,
    fichero: `p${String(n)}`,
    reservadaEn: h(r),
    respondidaEn: h(q),
    titulos: new Map(titulos.map((t) => [t.ids.imdbId, t])),
  };
}

const aviso = (
  tipo: "new" | "removed",
  c: string,
  extra: Partial<AvisoParaM4> = {},
): AvisoParaM4 => ({
  tipo,
  instante: h(c),
  imdbId: "tt0000001",
  plataformaId: "netflix",
  tipoOferta: "subscription",
  addon: null,
  ...extra,
});

const conNetflix = titulo("tt0000001", [{ service: "netflix" }]);
const sinNetflix = titulo("tt0000001", [{ service: "prime" }]);

describe("analizarM4", () => {
  it("refutado: un removed de ≥ 1 h antes de la reserva, y la oferta seguía en la página", () => {
    const r = analizarM4({
      ancla: S,
      T1,
      paginas: [pagina(1, "09:05:00", "09:05:02", [conNetflix])],
      avisos: [aviso("removed", "08:04:59")],
    });
    expect(r.resultado).toBe("refutado");
    expect(r.retrasoMaximoObservadoSegundos).toBe(3601);
    expect(r.refutan).toHaveLength(1);
    expect(m4PermiteProduction(r)).toBe(false);
  });

  it("un retraso < 1 h no refuta: compatible, y se anota", () => {
    const r = analizarM4({
      ancla: S,
      T1,
      paginas: [pagina(1, "09:05:00", "09:05:02", [conNetflix])],
      avisos: [aviso("removed", "08:30:00")],
    });
    expect(r.resultado).toBe("compatible");
    expect(r.casos.retraso).toBe(1);
    expect(r.retrasoMaximoObservadoSegundos).toBe(2100);
    expect(m4PermiteProduction(r)).toBe(true);
    expect(r.nota).toMatch(/No demuestran/);
  });

  it("compatible: new reflejado (la oferta ya está) y removed reflejado (ya no está)", () => {
    const r = analizarM4({
      ancla: S,
      T1,
      paginas: [
        pagina(1, "09:00:00", "09:00:01", [conNetflix]),
        pagina(2, "09:10:00", "09:10:01", [sinNetflix]),
      ],
      avisos: [aviso("new", "08:10:00"), aviso("removed", "09:01:00")],
    });
    expect(r.casos.muestra_reflejada).toBe(2);
    // El new frente a la página 2, sin la oferta, sería un retraso de ~1 h: aquí sí refuta.
    expect(r.casos.retraso).toBe(1);
    expect(r.resultado).toBe("refutado");
  });

  it("posterior a la página: sin información; durante la página: ambiguo; nada cuenta como muestra", () => {
    const r = analizarM4({
      ancla: S,
      T1,
      paginas: [pagina(1, "09:00:00", "09:00:05", [conNetflix])],
      avisos: [aviso("removed", "09:00:03"), aviso("removed", "09:00:07")],
    });
    expect(r.casos).toMatchObject({ ambiguo: 1, sin_informacion: 1 });
    expect(r.muestras).toBe(0);
    expect(r.resultado).toBe("sin_muestras");
    expect(m4PermiteProduction(r)).toBe(true);
    expect(r.nota).toMatch(/hipótesis operacional no refutada/);
  });

  it("fuera de [S, T1], sin identidad, sin página del título, o de otro tipo: no entran", () => {
    const r = analizarM4({
      ancla: S,
      T1,
      paginas: [pagina(1, "09:00:00", "09:00:01", [conNetflix])],
      avisos: [
        aviso("new", "07:59:59"),
        aviso("new", "09:15:01"),
        aviso("new", "08:10:00", { imdbId: null }),
        aviso("new", "08:10:00", { imdbId: "tt9999999" }),
        aviso("updated" as never, "08:10:00"),
      ],
    });
    expect(r.avisosEnVentana).toBe(2);
    expect(r.avisosSinIdentidad).toBe(1);
    expect(r.avisosSinPagina).toBe(1);
    expect(r.resultado).toBe("sin_muestras");
  });

  it("la clave de oferta incluye tipo y addon, como deltas", () => {
    const r = analizarM4({
      ancla: S,
      T1,
      paginas: [pagina(1, "09:00:00", "09:00:01", [conNetflix])],
      avisos: [aviso("new", "08:59:00", { tipoOferta: "addon", addon: "x" })],
    });
    expect(r.casos.retraso).toBe(1);
  });
});

describe("M4 sobre crudos de verdad", () => {
  it("lee las páginas del crudo verificado y los avisos de un crudo de /changes", async () => {
    const c = await capturar({ paginas: PAGINAS_BASE });
    const v = verificarCrudo(c.contenido);
    if (v.crudo === null) throw new Error("no verifica");
    const paginas = paginasDelCrudo(v.crudo, c.contenido);
    expect(paginas).toHaveLength(14);
    expect(paginas[0]?.titulos.has(A)).toBe(true);

    const fixture = readFileSync(
      join(import.meta.dirname, "../fixtures/changes/deltas-fila21-new-solapados.json"),
    );
    const cuerpo = JSON.parse(fixture.toString("utf8")) as { body?: unknown };
    const avisos = avisosDesdeRespuestas([
      {
        status: 200,
        cuerpo: new TextEncoder().encode(JSON.stringify(cuerpo.body ?? cuerpo)),
      },
      { status: 500, cuerpo: new TextEncoder().encode("{}") },
    ]);
    expect(avisos.length).toBeGreaterThan(0);
    expect(avisos.every((a) => a.imdbId === null || a.imdbId.startsWith("tt"))).toBe(
      true,
    );
    const r = analizarM4({ ancla: v.crudo.ancla, T1: v.crudo.T1, paginas, avisos });
    expect(["compatible", "sin_muestras", "refutado"]).toContain(r.resultado);
  });
});
