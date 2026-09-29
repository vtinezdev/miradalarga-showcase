/**
 * La selección del seed (ADR 0009 §1): deduplicación por IMDb con el **snapshot
 * completo más reciente**, sin combinar ofertas de snapshots distintos.
 */
import { describe, expect, it } from "vitest";

import { construirFilas } from "../../jobs/pipelines/seed/filas.ts";
import type { PaginaParaSeleccion } from "../../jobs/pipelines/seed/seleccion.ts";
import {
  crearAcumulador,
  seleccionar,
  validarShows,
} from "../../jobs/pipelines/seed/seleccion.ts";
import { show } from "./ayudas-seed.ts";
import {
  A,
  B,
  C,
  D,
  E,
  F,
  L1,
  L2,
  PAGINAS_BASE,
  SOLO_MUBI,
} from "./ayudas-seed-fixtures.ts";

const T = Date.parse("2026-11-03T09:00:00.000Z");

/** Las páginas del fixture base, en el orden en que las pediría la captura. */
function paginasBase(): PaginaParaSeleccion[] {
  const orden: [string, number][] = [
    ["netflix-movie", 0],
    ["netflix-series", 0],
    ["prime-movie", 0],
    ["disney-movie", 0],
    ["netflix-movie", 1],
    ["disney-movie", 1],
  ];
  return orden.map(([estrato, i], k) => ({
    n: k + 1,
    estrato,
    respondidaEn: new Date(T + k * 1000),
    shows: PAGINAS_BASE[estrato]?.[i]?.shows ?? [],
  }));
}

const tituloDe = (sel: ReturnType<typeof seleccionar>, imdb: string) =>
  sel.titulos.find((t) => t.titulo.ids.imdbId === imdb);

describe("deduplicación por IMDb", () => {
  it("cada IMDb entra una vez; los elegibles salen ordenados", () => {
    const sel = seleccionar(paginasBase());
    expect(sel.titulos.map((t) => t.titulo.ids.imdbId)).toEqual([A, B, C, D, E, F]);
    expect(sel.titulosIdentificados).toBe(7); // + el de solo mubi
    expect(sel.sustituciones).toBe(2); // A y B, una vez cada uno
  });

  it("mismo IMDb en dos plataformas: gana el snapshot posterior, con todas sus ofertas MVP", () => {
    const a = tituloDe(seleccionar(paginasBase()), A);
    expect(a?.titulo.disponibilidad.map((d) => d.plataformaId).sort()).toEqual([
      "netflix",
      "prime",
    ]);
    // Observado en el instante de la página que ganó (prime-movie, la 3.ª).
    expect(a?.observadoEn.getTime()).toBe(T + 2000);
  });

  it("observación más reciente gana, aunque llegue antes al acumulador", () => {
    const paginas = paginasBase();
    const al = seleccionar([...paginas].reverse());
    const bien = seleccionar(paginas);
    expect(al.titulos).toEqual(bien.titulos);
    expect(al.sustituciones).toBe(bien.sustituciones);
  });

  it("NO mezcla ofertas: B se queda solo con netflix L2; la apple y L1 desaparecen", () => {
    const b = tituloDe(seleccionar(paginasBase()), B);
    expect(b?.titulo.disponibilidad.map((d) => [d.plataformaId, d.enlace])).toEqual([
      ["netflix", L2],
    ]);
    const filas = construirFilas(seleccionar(paginasBase()).titulos);
    const deB = filas.opciones.filter((o) => o.claveOferta.startsWith(`${B}|`));
    expect(deB.map((o) => o.link)).toEqual([L2]);
    expect(filas.ofertas.some((o) => o.imdbId === B && o.platformId === "apple")).toBe(
      false,
    );
    expect(filas.opciones.some((o) => o.link === L1)).toBe(false);
  });

  it("a igual instante, la página de mayor n y después la posición posterior", () => {
    const mismo = new Date(T);
    const sel = seleccionar([
      {
        n: 2,
        estrato: "b",
        respondidaEn: mismo,
        shows: [show(A, { opciones: [{ service: "prime" }] })],
      },
      {
        n: 1,
        estrato: "a",
        respondidaEn: mismo,
        shows: [show(A, { opciones: [{ service: "apple" }] })],
      },
    ]);
    expect(tituloDe(sel, A)?.titulo.disponibilidad[0]?.plataformaId).toBe("prime");
    const dentro = seleccionar([
      {
        n: 1,
        estrato: "a",
        respondidaEn: mismo,
        shows: [
          show(A, { opciones: [{ service: "apple" }] }),
          show(A, { opciones: [{ service: "disney" }] }),
        ],
      },
    ]);
    expect(tituloDe(dentro, A)?.titulo.disponibilidad[0]?.plataformaId).toBe("disney");
    expect(dentro.porEstrato.a?.duplicadosEnEstrato).toBe(1);
  });

  it("la elegibilidad se decide sobre el ganador: una oferta MVP vieja no resucita el título", () => {
    const sel = seleccionar([
      {
        n: 1,
        estrato: "a",
        respondidaEn: new Date(T),
        shows: [show(A, { opciones: [{ service: "netflix" }] })],
      },
      {
        n: 2,
        estrato: "b",
        respondidaEn: new Date(T + 1),
        shows: [show(A, { opciones: [{ service: "mubi" }] })],
      },
    ]);
    expect(sel.titulos).toHaveLength(0);
    expect(sel.porEstrato.b?.sinOfertaMvp).toBe(1);
  });
});

describe("un show fuera del contrato invalida la página", () => {
  it.each([
    ["sin title", (s: Record<string, unknown>) => delete s.title],
    ["showType desconocido", (s: Record<string, unknown>) => (s.showType = "episode")],
    ["imdbId que no es texto", (s: Record<string, unknown>) => (s.imdbId = 1234567)],
    ["rating fuera de rango", (s: Record<string, unknown>) => (s.rating = 101)],
    ["itemType distinto", (s: Record<string, unknown>) => (s.itemType = "movie")],
  ])(
    "%s → validarShows lo señala, con su posición y sin reimprimir valores",
    (_, romper) => {
      const malo = show(B);
      romper(malo);
      const r = validarShows([show(A), malo]);
      expect(r?.posicion).toBe(1);
      expect(r?.problemas.length).toBeGreaterThan(0);
      expect(JSON.stringify(r)).not.toContain("tt0000002");
    },
  );

  it("el acumulador se niega a seleccionar una página sin validar: no omite en silencio", () => {
    const malo = show(B);
    delete malo.title;
    expect(() =>
      seleccionar([
        { n: 1, estrato: "a", respondidaEn: new Date(T), shows: [show(A), malo] },
      ]),
    ).toThrow(/no cumple el schema/);
  });
});

describe("contadores y anomalías", () => {
  it("sin identidad y sin oferta MVP, por estrato; no entran", () => {
    const sel = seleccionar(paginasBase());
    expect(sel.porEstrato["netflix-series"]).toEqual({
      shows: 3,
      sinIdentidad: 1,
      duplicadosEnEstrato: 0,
      sinOfertaMvp: 1,
      elegibles: 1,
    });
    expect(tituloDe(sel, SOLO_MUBI)).toBeUndefined();
  });

  it("imdbId ausente, null, vacío o solo espacios: sin identidad, contado y omitido", () => {
    const sinClave = show(A);
    delete sinClave.imdbId;
    const variantes = [sinClave, show(null), show(""), show("   "), show("\t\n")];
    expect(validarShows(variantes)).toBeNull();
    const sel = seleccionar([
      { n: 1, estrato: "a", respondidaEn: new Date(T), shows: variantes },
    ]);
    expect(sel.titulos).toHaveLength(0);
    expect(sel.porEstrato.a?.sinIdentidad).toBe(5);
  });

  it("el solapamiento real por par de estratos", () => {
    const sel = seleccionar(paginasBase());
    expect(sel.pares).toEqual({ "netflix-movie|prime-movie": 1 });
    expect(sel.titulosEnVariosEstratos).toBe(1);
  });

  it("mismo IMDb con distinto showType: contado, no corregido", () => {
    const sel = seleccionar([
      {
        n: 1,
        estrato: "a",
        respondidaEn: new Date(T),
        shows: [show(A, { tipo: "movie" })],
      },
      {
        n: 2,
        estrato: "b",
        respondidaEn: new Date(T + 1),
        shows: [show(A, { tipo: "series" })],
      },
    ]);
    expect(sel.tiposDistintos).toBe(1);
    expect(tituloDe(sel, A)?.titulo.tipo).toBe("serie");
  });

  it("el recuento incremental de únicos es el mismo que el de la selección final", () => {
    const acc = crearAcumulador();
    const cuentas: number[] = [];
    for (const p of paginasBase()) {
      acc.anadir(p);
      cuentas.push(acc.unicosElegibles());
    }
    expect(cuentas).toEqual([2, 3, 3, 4, 5, 6]);
    expect(acc.resultado().titulos).toHaveLength(6);
  });
});
