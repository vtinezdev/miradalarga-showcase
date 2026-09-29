/**
 * Ranking A — Mejor valoradas: reglas de ordenación.
 *
 * Lo que se protege aquí es la **reproducibilidad**. El Spike 3 midió que, sin
 * desempate explícito, el Top 20 depende del orden de lectura de los ficheros
 * de ingesta. Con desempate, no.
 */
import { describe, expect, it } from "vitest";

import {
  desempateNeutral,
  ordenarMejorValoradas,
  tieneValoracion,
  type TituloOrdenable,
} from "../../jobs/scoring/orden.ts";

function t(titulo: string, valoracion: number | null, imdbId: string): TituloOrdenable {
  return { titulo, valoracion, ids: { imdbId } };
}

/** Barajado determinista con semilla, igual que en `spike-3/ranking-a.mjs`. */
function barajar<T>(lista: readonly T[], semilla: number): T[] {
  let s = semilla;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const c = [...lista];
  for (let i = c.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [c[i], c[j]] = [c[j]!, c[i]!];
  }
  return c;
}

describe("valoración ausente", () => {
  it("null se excluye, no se ordena al fondo", () => {
    const lista = [t("Con nota", 70, "tt1"), t("Sin nota", null, "tt2")];
    const orden = ordenarMejorValoradas(lista);
    expect(orden.map((x) => x.titulo)).toEqual(["Con nota"]);
  });

  it("tieneValoracion estrecha el tipo", () => {
    expect(tieneValoracion(t("a", 1, "tt1"))).toBe(true);
    expect(tieneValoracion(t("a", null, "tt1"))).toBe(false);
  });
});

describe("orden por valoración descendente", () => {
  it("la nota más alta va primero", () => {
    const lista = [t("Media", 60, "tt2"), t("Alta", 90, "tt1"), t("Baja", 30, "tt3")];
    expect(ordenarMejorValoradas(lista).map((x) => x.titulo)).toEqual([
      "Alta",
      "Media",
      "Baja",
    ]);
  });
});

describe("desempate neutral y determinista", () => {
  it("a igual nota, ordena por título en es-ES", () => {
    const lista = [
      t("Zarzuela", 80, "tt3"),
      t("Alba", 80, "tt1"),
      t("Melodía", 80, "tt2"),
    ];
    expect(ordenarMejorValoradas(lista).map((x) => x.titulo)).toEqual([
      "Alba",
      "Melodía",
      "Zarzuela",
    ]);
  });

  it("a igual nota y mismo título, ordena por imdbId", () => {
    const lista = [t("Homónima", 80, "tt999"), t("Homónima", 80, "tt111")];
    expect(ordenarMejorValoradas(lista).map((x) => x.ids.imdbId)).toEqual([
      "tt111",
      "tt999",
    ]);
  });

  it("respeta el alfabeto español: la Ñ va después de la N", () => {
    const lista = [t("Ñandú", 80, "tt2"), t("Nube", 80, "tt1"), t("Ola", 80, "tt3")];
    expect(ordenarMejorValoradas(lista).map((x) => x.titulo)).toEqual([
      "Nube",
      "Ñandú",
      "Ola",
    ]);
  });

  it("es una relación antisimétrica", () => {
    const a = t("Alba", 80, "tt1");
    const b = t("Beta", 80, "tt2");
    expect(Math.sign(desempateNeutral(a, b))).toBe(-Math.sign(desempateNeutral(b, a)));
    expect(desempateNeutral(a, a)).toBe(0);
  });
});

describe("reproducibilidad — el resultado decisivo del Spike 3", () => {
  const catalogo: TituloOrdenable[] = [
    // Cinco títulos empatados a 80: sin desempate, su orden relativo lo
    // decidiría el orden de lectura de los ficheros de ingesta.
    t("Eclipse", 80, "tt5"),
    t("Abismo", 80, "tt1"),
    t("Duna", 80, "tt4"),
    t("Bruma", 80, "tt2"),
    t("Cenit", 80, "tt3"),
    t("Cumbre", 95, "tt6"),
    t("Valle", 40, "tt7"),
  ];

  it("el orden no cambia aunque cambie el orden de entrada", () => {
    const referencia = ordenarMejorValoradas(catalogo).map((x) => x.ids.imdbId);
    for (const semilla of [1, 7, 42, 1234, 99999]) {
      const alterado = ordenarMejorValoradas(barajar(catalogo, semilla));
      expect(alterado.map((x) => x.ids.imdbId)).toEqual(referencia);
    }
  });

  it("no muta la lista de entrada", () => {
    const antes = catalogo.map((x) => x.ids.imdbId);
    ordenarMejorValoradas(catalogo);
    expect(catalogo.map((x) => x.ids.imdbId)).toEqual(antes);
  });
});
