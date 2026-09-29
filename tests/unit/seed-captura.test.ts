/**
 * La captura por rondas (ADR 0009 §1) con fixtures, **sin red**: el motor de
 * rondas, el criterio de parada, los cortes y los fallos. El crudo que deja
 * cada caso se pasa por `seed:verificar`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NS_CATALOGO, NS_CICLO, NS_PIPELINE } from "../../jobs/ops/bloqueo.ts";
import type { EjecutorSql } from "../../jobs/ops/contratos.ts";
import { crearLibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import {
  TECHO_MENSUAL_POR_DEFECTO,
  TOPE_POR_EJECUCION_POR_DEFECTO,
} from "../../jobs/ops/presupuesto.ts";
import { verificarCrudo } from "../../jobs/pipelines/seed/crudo/verificar.ts";
import type { CheckpointDeCaptura } from "../../jobs/pipelines/seed/fases.ts";
import {
  cerrarRonda,
  iniciarRondas,
  registrarPagina,
  siguientePeticion,
} from "../../jobs/pipelines/seed/rondas.ts";
import { capturar, crearPlan, fijarReloj, show } from "./ayudas-seed.ts";
import { A, B, C, E, F, PAGINAS_BASE } from "./ayudas-seed-fixtures.ts";
import { vi } from "vitest";

beforeEach(() => fijarReloj());
afterEach(() => vi.useRealTimers());

const orden = (llamadas: readonly { estrato: { estrato: string }; ronda: number }[]) =>
  llamadas.map((l) => `${l.estrato.estrato}#${String(l.ronda)}`);

// ── 1 · El motor de rondas, puro ─────────────────────────────────────────────

describe("rondas", () => {
  it("una ronda pide una página de cada estrato no agotado, en el orden del plan", () => {
    let e = iniciarRondas(["a", "b", "c"]);
    const pedidas: string[] = [];
    for (let p = siguientePeticion(e); p !== null; p = siguientePeticion(e)) {
      pedidas.push(p.estrato);
      e = registrarPagina(e, {
        estrato: p.estrato,
        hasMore: p.estrato !== "b",
        nextCursor: `${p.estrato}1`,
      }).estado;
    }
    expect(pedidas).toEqual(["a", "b", "c"]);
    const d = cerrarRonda(e, 0, 10);
    expect(d.tipo).toBe("seguir");
    if (d.tipo !== "seguir") return;
    // b se agotó: la ronda 2 solo tiene a y c, con sus cursores.
    expect(d.estado.pendientesDeLaRonda).toEqual(["a", "c"]);
    expect(siguientePeticion(d.estado)).toEqual({
      estrato: "a",
      ronda: 2,
      cursorDeEntrada: "a1",
    });
  });

  it("no evalúa el objetivo a mitad de ronda: lanza", () => {
    const e = registrarPagina(iniciarRondas(["a", "b"]), {
      estrato: "a",
      hasMore: true,
      nextCursor: "x",
    }).estado;
    expect(() => cerrarRonda(e, 999, 1)).toThrow(/no está completa/);
  });

  it("registrar una página que no tocaba es un error de programación", () => {
    expect(() =>
      registrarPagina(iniciarRondas(["a", "b"]), {
        estrato: "b",
        hasMore: false,
        nextCursor: null,
      }),
    ).toThrow();
  });

  it("parada: objetivo antes que agotamiento; agotamiento sin objetivo", () => {
    const e = registrarPagina(iniciarRondas(["a"]), {
      estrato: "a",
      hasMore: false,
      nextCursor: null,
    }).estado;
    expect(cerrarRonda(e, 5, 5)).toMatchObject({
      tipo: "parar",
      motivo: "objetivo_alcanzado",
    });
    expect(cerrarRonda(e, 4, 5)).toMatchObject({
      tipo: "parar",
      motivo: "catalogo_agotado",
    });
  });

  it("cursor sin progreso: nulo, vacío o ya usado en el estrato", () => {
    const e0 = iniciarRondas(["a"]);
    expect(
      registrarPagina(e0, { estrato: "a", hasMore: true, nextCursor: null }).tipo,
    ).toBe("cursor_sin_progreso");
    expect(
      registrarPagina(e0, { estrato: "a", hasMore: true, nextCursor: "" }).tipo,
    ).toBe("cursor_sin_progreso");
    let e = registrarPagina(e0, {
      estrato: "a",
      hasMore: true,
      nextCursor: "A",
    }).estado;
    const d = cerrarRonda(e, 0, 9);
    if (d.tipo !== "seguir") throw new Error("seguía");
    e = registrarPagina(d.estado, {
      estrato: "a",
      hasMore: true,
      nextCursor: "B",
    }).estado;
    const d2 = cerrarRonda(e, 0, 9);
    if (d2.tipo !== "seguir") throw new Error("seguía");
    // A → B → A: ciclo.
    expect(
      registrarPagina(d2.estado, { estrato: "a", hasMore: true, nextCursor: "A" }).tipo,
    ).toBe("cursor_sin_progreso");
  });
});

// ── 2 · La captura con fixtures ──────────────────────────────────────────────

describe("captura por rondas", () => {
  it("ronda completa y sin cortar a mitad: el objetivo se cruza en la ronda 2 y aun así la cierra", async () => {
    const c = await capturar({ paginas: PAGINAS_BASE });
    expect(c.resultado).toMatchObject({ ejecutado: true, estado: "succeeded" });
    expect(c.manifiesto?.cierre).toMatchObject({
      estado: "succeeded",
      motivo: "objetivo_alcanzado",
    });
    const pedidas = orden(c.proveedor.llamadas);
    expect(pedidas).toHaveLength(14);
    expect(pedidas.slice(0, 12).every((p) => p.endsWith("#1"))).toBe(true);
    // Tras netflix-movie#2 ya hay 5 elegibles; disney-movie#2 se pide igual.
    expect(pedidas.slice(12)).toEqual(["netflix-movie#2", "disney-movie#2"]);

    const v = verificarCrudo(c.contenido);
    expect(v.problemas).toEqual([]);
    expect(v.crudo?.seleccion.titulos.map((t) => t.titulo.ids.imdbId)).toEqual([
      A,
      B,
      "tt0000003",
      "tt0000004",
      E,
      F,
    ]);
  });

  it("grupos agotados: la ronda 2 solo pide los estratos que siguen vivos", async () => {
    const c = await capturar({ paginas: PAGINAS_BASE });
    const ronda2 = c.proveedor.llamadas
      .filter((l) => l.ronda === 2)
      .map((l) => l.estrato.estrato);
    expect(ronda2).toEqual(["netflix-movie", "disney-movie"]);
  });

  it("catálogo agotado antes del objetivo: succeeded con catalogo_agotado, sin relajar nada", async () => {
    const c = await capturar({
      paginas: PAGINAS_BASE,
      plan: crearPlan({ objetivoUnicos: 5000 }),
    });
    expect(c.manifiesto?.cierre).toMatchObject({
      estado: "succeeded",
      motivo: "catalogo_agotado",
    });
    expect(c.proveedor.llamadas).toHaveLength(14);
    expect(verificarCrudo(c.contenido).ok).toBe(true);
  });

  it("corte por tope a mitad de ronda: íntegro y reanudable, pero NO cargable", async () => {
    const c = await capturar({ paginas: PAGINAS_BASE, tope: 5 });
    expect(c.resultado).toMatchObject({ ejecutado: true, estado: "budget_stopped" });
    expect(c.proveedor.llamadas).toHaveLength(5);
    expect(c.manifiesto?.paginas).toHaveLength(5);
    expect(c.manifiesto?.cierre).toMatchObject({
      motivo: "tope_por_ejecucion",
      cortadoPorTope: true,
      rondasCompletas: 0,
      rondaCompleta: false,
      requestsReservadas: 5,
      respuestas: 5,
    });
    const v = verificarCrudo(c.contenido);
    expect(v.problemas).toEqual([]);
    expect(v.crudo).toMatchObject({
      cargable: false,
      motivoNoCargable: "ronda_incompleta",
    });
    // El checkpoint quedó en la última página confirmada: se puede reanudar.
    const cp = c.libro.filas[0]?.checkpoint as CheckpointDeCaptura;
    expect(cp.paginasConfirmadas).toBe(5);
    expect(c.libro.filas[0]?.requestsMade).toBe(5);
  });

  it("corte por tope justo al cerrar la ronda 1: cargable aunque no llegue al objetivo", async () => {
    const c = await capturar({ paginas: PAGINAS_BASE, tope: 12 });
    expect(c.resultado).toMatchObject({ ejecutado: true, estado: "budget_stopped" });
    expect(c.proveedor.llamadas).toHaveLength(12);
    expect(c.manifiesto?.cierre).toMatchObject({
      cortadoPorTope: true,
      rondasCompletas: 1,
      rondaCompleta: true,
    });
    const v = verificarCrudo(c.contenido);
    expect(v.problemas).toEqual([]);
    expect(v.crudo).toMatchObject({ cargable: true, motivoNoCargable: null });
    // 4 < 5: por debajo del objetivo, pero todos los estratos a la misma profundidad.
    expect(v.crudo?.seleccion.titulos).toHaveLength(4);
  });

  it("corte por tope a mitad de la ronda 2: una ronda completa no basta, NO cargable", async () => {
    const c = await capturar({ paginas: PAGINAS_BASE, tope: 13 });
    expect(c.manifiesto?.cierre).toMatchObject({
      rondasCompletas: 1,
      rondaCompleta: false,
    });
    expect(verificarCrudo(c.contenido).crudo?.motivoNoCargable).toBe(
      "ronda_incompleta",
    );
  });

  it("un show fuera del contrato: la página queda inválida y la captura falla, no se omite", async () => {
    const malo = show(B);
    delete malo.title;
    const c = await capturar({
      paginas: { ...PAGINAS_BASE, "netflix-series": [{ shows: [show(C), malo] }] },
    });
    expect(c.resultado).toMatchObject({ ejecutado: true, estado: "failed" });
    if (!c.resultado.ejecutado) return;
    expect(c.resultado.metricas.errorSamples[0]).toMatchObject({
      motivo: "respuesta_invalida",
      show: 1,
    });
    expect(c.manifiesto?.paginas.at(-1)).toMatchObject({ estado: "invalida", n: 2 });
    expect(c.proveedor.llamadas).toHaveLength(2);
    const v = verificarCrudo(c.contenido);
    expect(v.problemas).toEqual([]);
    expect(v.crudo?.motivoNoCargable).toBe("captura_fallida");
  });

  it("imdbId ausente, null, vacío o espacios no invalida la página: se cuenta", async () => {
    const sinClave = show(A);
    delete sinClave.imdbId;
    const c = await capturar({
      paginas: {
        ...PAGINAS_BASE,
        "netflix-series": [
          { shows: [show(C, { tipo: "series" }), sinClave, show(""), show("  ")] },
        ],
      },
    });
    expect(c.resultado).toMatchObject({ ejecutado: true, estado: "succeeded" });
    const v = verificarCrudo(c.contenido);
    expect(v.crudo?.seleccion.porEstrato["netflix-series"]?.sinIdentidad).toBe(3);
  });

  it("con el presupuesto del repositorio (seed 0/0) no sale ni una request", async () => {
    expect(TOPE_POR_EJECUCION_POR_DEFECTO.seed).toBe(0);
    expect(TECHO_MENSUAL_POR_DEFECTO.seed).toBe(0);
    const c = await capturar({ paginas: PAGINAS_BASE, tope: 0 });
    expect(c.resultado).toMatchObject({ ejecutado: true, estado: "budget_stopped" });
    expect(c.proveedor.llamadas).toHaveLength(0);
    expect(c.libro.filas[0]?.requestsMade).toBe(0);
  });

  it("cursor sin progreso: failed, la página que lo delató queda en el crudo, no se pide otra", async () => {
    const c = await capturar({
      paginas: {
        ...PAGINAS_BASE,
        "netflix-movie": [{ shows: [show(A)], hasMore: true, nextCursor: null }],
      },
    });
    expect(c.resultado).toMatchObject({ ejecutado: true, estado: "failed" });
    expect(c.manifiesto?.cierre?.motivo).toBe("cursor_sin_progreso");
    expect(c.proveedor.llamadas).toHaveLength(1);
    const v = verificarCrudo(c.contenido);
    expect(v.problemas).toEqual([]);
    expect(v.crudo?.cargable).toBe(false);
  });

  it("página corrupta del proveedor: se guarda marcada inválida y la captura falla sin reintento", async () => {
    const c = await capturar({
      paginas: {
        ...PAGINAS_BASE,
        "netflix-series": [{ cuerpoCrudo: "<html>error</html>" }],
      },
    });
    expect(c.resultado).toMatchObject({ ejecutado: true, estado: "failed" });
    expect(c.manifiesto?.cierre?.motivo).toBe("respuesta_invalida");
    expect(c.manifiesto?.paginas.at(-1)).toMatchObject({
      estado: "invalida",
      shows: null,
    });
    expect(c.contenido.get("paginas/0002-netflix-series-r01.json")).toBeDefined();
    expect(c.proveedor.llamadas).toHaveLength(2);
    const v = verificarCrudo(c.contenido);
    expect(v.problemas).toEqual([]);
    expect(v.crudo?.cargable).toBe(false);
  });

  it("un HTTP no 2xx también es respuesta inválida", async () => {
    const c = await capturar({
      paginas: {
        ...PAGINAS_BASE,
        "netflix-movie": [{ status: 500, cuerpoCrudo: "{}" }],
      },
    });
    expect(c.manifiesto?.cierre?.motivo).toBe("respuesta_invalida");
    expect(c.manifiesto?.paginas[0]?.http).toBe(500);
  });

  it("m1_caducada: la M1 no es del ciclo anterior → failed, 0 requests, sin crudo", async () => {
    const c = await capturar({
      paginas: PAGINAS_BASE,
      plan: crearPlan({ m1: { runId: "3", cicloClave: 202609, diaDeCiclo: 1 } }),
    });
    expect(c.resultado).toMatchObject({ ejecutado: true, estado: "failed" });
    if (!c.resultado.ejecutado) return;
    expect(c.resultado.metricas.errorSamples[0]?.motivo).toBe("m1_caducada");
    expect(c.proveedor.llamadas).toHaveLength(0);
    expect(c.manifiesto).toBeNull();
    expect(c.contenido.size).toBe(0);
  });

  it("T0 y S nacen en el INSERT, antes de la primera reserva; S = T0 truncado − 1 h", async () => {
    const libro = crearLibroEnMemoria();
    const c = await capturar({ paginas: PAGINAS_BASE, libro });
    const cp = libro.filas[0]?.checkpoint as CheckpointDeCaptura;
    expect(cp.fase).toBe("captura");
    expect(new Date(cp.ancla).getTime()).toBe(new Date(cp.T0).getTime() - 3_600_000);
    expect(c.manifiesto?.cierre?.T0).toBe(cp.T0);
    expect(Date.parse(cp.T0)).toBeLessThanOrEqual(
      Date.parse(c.manifiesto?.paginas[0]?.reservadaEn ?? ""),
    );
  });
});

// ── 3 · Locks de la captura ──────────────────────────────────────────────────

describe("la captura no toma el lock de catálogo", () => {
  it("A (pipeline seed) → B (ciclo, en cada reserva) → fuente; nunca C", async () => {
    const libro = crearLibroEnMemoria();
    const registro: string[] = [];
    const espia: EjecutorSql = {
      ejecutar(texto, valores = []) {
        if (texto.includes("advisory"))
          registro.push(`${String(valores[0])}:${String(valores[1])}`);
        return libro.ejecutor.ejecutar(texto, valores);
      },
    };
    await capturar({ paginas: PAGINAS_BASE, libro: { ...libro, ejecutor: espia } });
    expect(registro[0]).toBe(`${String(NS_PIPELINE)}:1`);
    expect(registro.some((r) => r.startsWith(`${String(NS_CATALOGO)}:`))).toBe(false);
    expect(registro.filter((r) => r.startsWith(`${String(NS_CICLO)}:`))).toHaveLength(
      14,
    );
  });
});
