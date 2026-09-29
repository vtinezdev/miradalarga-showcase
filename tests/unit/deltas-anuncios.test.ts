/**
 * **Qué hace una observación `upcoming` con la fila de su anuncio** (ADR 0007),
 * sobre las funciones puras de `deltas/anuncios.ts`: sin SQL y sin red.
 *
 * La regla entera sale de comparar el `ahora` de la observación con el
 * `last_seen_at` de la fila, y la fecha anunciada con `ahora`.
 */
import { describe, expect, it } from "vitest";

import type {
  AnuncioGuardado,
  AnuncioObservado,
} from "../../jobs/pipelines/deltas/anuncios.ts";
import {
  decidirAnuncio,
  informeDeAnunciosVacio,
  planificarAnuncios,
  sumarInformesDeAnuncios,
} from "../../jobs/pipelines/deltas/anuncios.ts";

const DIA = 86_400_000;
const T = new Date("2026-09-24T10:00:00.000Z");
const en = (dias: number, desde = T) => new Date(desde.getTime() + dias * DIA);

const CLAVE = "tt0000001|netflix|es|subscription|";

function observado(entrada: {
  readonly para: Date;
  readonly enlace?: string | null;
  readonly clave?: string;
}): AnuncioObservado {
  return {
    clave: entrada.clave ?? CLAVE,
    imdbId: "tt0000001",
    plataforma: "netflix",
    tipoOferta: "subscription",
    addon: null,
    anunciadoPara: entrada.para,
    enlace: entrada.enlace === undefined ? "https://netflix.test/1" : entrada.enlace,
  };
}

function guardado(entrada: {
  readonly para: Date;
  readonly primeraPara?: Date;
  readonly enlace?: string | null;
  readonly vistoPrimero?: Date;
  readonly vistoUltimo: Date;
  readonly run?: number | null;
}): AnuncioGuardado {
  return {
    id: "7",
    anunciadoPara: entrada.para,
    primeraFechaAnunciada: entrada.primeraPara ?? entrada.para,
    enlace: entrada.enlace === undefined ? "https://netflix.test/1" : entrada.enlace,
    vistoPrimeroEn: entrada.vistoPrimero ?? entrada.vistoUltimo,
    vistoUltimoEn: entrada.vistoUltimo,
    ultimaEjecucion: entrada.run ?? 40,
  };
}

describe("decidirAnuncio", () => {
  it("sin fila: nuevo, con first_* = esta observación y el run que la vio", () => {
    const d = decidirAnuncio(undefined, observado({ para: en(10) }), T, 50);
    expect(d).toEqual({
      tipo: "nuevo",
      fila: {
        id: null,
        anunciadoPara: en(10),
        primeraFechaAnunciada: en(10),
        enlace: "https://netflix.test/1",
        vistoPrimeroEn: T,
        vistoUltimoEn: T,
        ultimaEjecucion: 50,
      },
    });
  });

  it("📏 sin link: nuevo con enlace null, sin inventar nada", () => {
    const d = decidirAnuncio(
      undefined,
      observado({ para: en(3), enlace: null }),
      T,
      50,
    );
    expect(d.tipo).toBe("nuevo");
    expect(d.tipo === "nuevo" && d.fila.enlace).toBeNull();
  });

  it("misma identidad, observación nueva, mismos datos: mismo ciclo sin cambios", () => {
    const d = decidirAnuncio(
      guardado({ para: en(10), vistoUltimo: en(-1) }),
      observado({ para: en(10) }),
      T,
      50,
    );
    expect(d).toMatchObject({
      tipo: "mismo_ciclo",
      fechaCambiada: false,
      enlaceCambiado: false,
      fila: { vistoUltimoEn: T, ultimaEjecucion: 50, vistoPrimeroEn: en(-1) },
    });
  });

  it("aplazamiento: la fecha se mueve, first_announced_for y first_seen_at se conservan", () => {
    const d = decidirAnuncio(
      guardado({ para: en(10), vistoPrimero: en(-5), vistoUltimo: en(-1) }),
      observado({ para: en(20) }),
      T,
      50,
    );
    expect(d).toMatchObject({
      tipo: "mismo_ciclo",
      fechaCambiada: true,
      enlaceCambiado: false,
      fila: {
        id: "7",
        anunciadoPara: en(20),
        primeraFechaAnunciada: en(10),
        vistoPrimeroEn: en(-5),
        vistoUltimoEn: T,
      },
    });
  });

  describe("⚖️ el link", () => {
    it("1 · mismo ciclo: un NULL posterior NO borra el link conocido", () => {
      const d = decidirAnuncio(
        guardado({ para: en(10), vistoUltimo: en(-1) }),
        observado({ para: en(12), enlace: null }),
        T,
        50,
      );
      expect(d).toMatchObject({
        tipo: "mismo_ciclo",
        fechaCambiada: true,
        enlaceCambiado: false,
        enlaceConservado: true,
        fila: {
          enlace: "https://netflix.test/1",
          anunciadoPara: en(12),
          vistoUltimoEn: T,
        },
      });
    });

    it("2 · mismo ciclo: un link no nulo posterior SÍ lo actualiza", () => {
      const d = decidirAnuncio(
        guardado({ para: en(10), vistoUltimo: en(-1) }),
        observado({ para: en(10), enlace: "https://netflix.test/otro" }),
        T,
        50,
      );
      expect(d).toMatchObject({
        tipo: "mismo_ciclo",
        enlaceCambiado: true,
        enlaceConservado: false,
        fila: { enlace: "https://netflix.test/otro" },
      });
      // Y también donde antes solo había NULL.
      const desdeNulo = decidirAnuncio(
        guardado({ para: en(10), vistoUltimo: en(-1), enlace: null }),
        observado({ para: en(10), enlace: "https://netflix.test/1" }),
        T,
        50,
      );
      expect(desdeNulo).toMatchObject({
        tipo: "mismo_ciclo",
        enlaceCambiado: true,
        fila: { enlace: "https://netflix.test/1" },
      });
    });

    it("3 · ciclo nuevo: NO hereda el link anterior, aunque llegue NULL", () => {
      const d = decidirAnuncio(
        guardado({
          para: en(-3),
          vistoUltimo: en(-4),
          enlace: "https://netflix.test/temporada-1",
        }),
        observado({ para: en(25), enlace: null }),
        T,
        50,
      );
      expect(d).toMatchObject({
        tipo: "nuevo_ciclo",
        fila: { enlace: null, primeraFechaAnunciada: en(25), vistoPrimeroEn: T },
      });
    });

    it("misma observación: un NULL frente a un link conocido no es conflicto", () => {
      const d = decidirAnuncio(
        guardado({ para: en(10), vistoUltimo: T, run: 50 }),
        observado({ para: en(10), enlace: null }),
        T,
        50,
      );
      expect(d).toEqual({ tipo: "misma_observacion" });
    });

    it("misma observación: un link donde solo había NULL se completa", () => {
      const d = decidirAnuncio(
        guardado({ para: en(10), vistoUltimo: T, run: 50, enlace: null }),
        observado({ para: en(10), enlace: "https://netflix.test/1" }),
        T,
        50,
      );
      expect(d).toMatchObject({
        tipo: "enlace_completado",
        fila: {
          enlace: "https://netflix.test/1",
          vistoUltimoEn: T,
          anunciadoPara: en(10),
        },
      });
    });

    it("misma observación: dos links NO nulos distintos sí son conflicto", () => {
      const d = decidirAnuncio(
        guardado({ para: en(10), vistoUltimo: T, run: 50 }),
        observado({ para: en(10), enlace: "https://netflix.test/otro" }),
        T,
        50,
      );
      expect(d).toMatchObject({
        tipo: "conflicto",
        conflicto: {
          vigente: { enlace: "https://netflix.test/1" },
          descartado: { enlace: "https://netflix.test/otro" },
        },
      });
    });

    it("el orden de link y NULL en la misma ejecución no cambia el resultado", () => {
      const conLink = observado({ para: en(10) });
      const sinLink = observado({ para: en(10), enlace: null });
      const a = planificarAnuncios(new Map(), [conLink, sinLink], T, 50);
      const b = planificarAnuncios(new Map(), [sinLink, conLink], T, 50);
      const final = (p: typeof a) =>
        [...p.escrituras.values()].map((e) => e.fila.enlace);
      expect(final(a)).toEqual(["https://netflix.test/1"]);
      expect(final(b)).toEqual(["https://netflix.test/1"]);
      expect(a.informe.conflictos).toEqual([]);
      expect(b.informe.conflictos).toEqual([]);
      expect(b.informe.enlacesCompletados).toBe(1);
    });
  });

  it("la fecha anterior ya venció: ciclo nuevo, first_* reiniciados", () => {
    const d = decidirAnuncio(
      guardado({
        para: en(-3),
        primeraPara: en(-10),
        vistoPrimero: en(-40),
        vistoUltimo: en(-4),
        enlace: "https://netflix.test/temporada-1",
      }),
      observado({ para: en(25), enlace: "https://netflix.test/temporada-2" }),
      T,
      50,
    );
    expect(d).toEqual({
      tipo: "nuevo_ciclo",
      fila: {
        id: "7",
        anunciadoPara: en(25),
        primeraFechaAnunciada: en(25),
        enlace: "https://netflix.test/temporada-2",
        vistoPrimeroEn: T,
        vistoUltimoEn: T,
        ultimaEjecucion: 50,
      },
    });
  });

  it("⚖️ announced_for == ahora ya es pasado: el límite es estricto", () => {
    const d = decidirAnuncio(
      guardado({ para: T, vistoUltimo: en(-1) }),
      observado({ para: en(30) }),
      T,
      50,
    );
    expect(d.tipo).toBe("nuevo_ciclo");
  });

  it("observación más vieja que la aplicada: fuera de orden, no escribe", () => {
    const d = decidirAnuncio(
      guardado({ para: en(10), vistoUltimo: en(1) }),
      observado({ para: en(99), enlace: null }),
      T,
      50,
    );
    expect(d).toEqual({ tipo: "fuera_de_orden" });
  });

  it("el mismo instante con los mismos datos: la misma observación, no escribe", () => {
    const d = decidirAnuncio(
      guardado({ para: en(10), vistoUltimo: T, run: 50 }),
      observado({ para: en(10) }),
      T,
      50,
    );
    expect(d).toEqual({ tipo: "misma_observacion" });
  });

  it("el mismo instante con OTRA fecha: conflicto, con los dos valores", () => {
    const d = decidirAnuncio(
      guardado({ para: en(10), vistoUltimo: T, run: 50 }),
      observado({ para: en(12) }),
      T,
      50,
    );
    expect(d).toEqual({
      tipo: "conflicto",
      conflicto: {
        clave: CLAVE,
        vigente: {
          anunciadoPara: en(10).toISOString(),
          enlace: "https://netflix.test/1",
        },
        descartado: {
          anunciadoPara: en(12).toISOString(),
          enlace: "https://netflix.test/1",
        },
      },
    });
  });
});

describe("planificarAnuncios: una página en el orden del proveedor", () => {
  it("📏 el mismo anuncio dos veces en la página: una escritura y una repetición", () => {
    const plan = planificarAnuncios(
      new Map(),
      [observado({ para: en(10) }), observado({ para: en(10) })],
      T,
      50,
    );
    expect(plan.escrituras.size).toBe(1);
    expect(plan.informe).toMatchObject({
      observados: 2,
      nuevos: 1,
      mismaObservacion: 1,
      conflictos: [],
    });
  });

  it("dos fechas futuras para la misma oferta en la página: la primera se queda, la segunda se reporta", () => {
    const plan = planificarAnuncios(
      new Map(),
      [observado({ para: en(10) }), observado({ para: en(12) })],
      T,
      50,
    );
    expect([...plan.escrituras.values()].map((e) => e.fila.anunciadoPara)).toEqual([
      en(10),
    ]);
    expect(plan.informe.conflictos).toEqual([
      {
        clave: CLAVE,
        vigente: {
          anunciadoPara: en(10).toISOString(),
          enlace: "https://netflix.test/1",
        },
        descartado: {
          anunciadoPara: en(12).toISOString(),
          enlace: "https://netflix.test/1",
        },
      },
    ]);
    expect(plan.informe.nuevos).toBe(1);
  });

  it("cada observación cae en una sola clase: la suma es `observados`", () => {
    const otra = "tt0000002|netflix|es|subscription|";
    const tercera = "tt0000003|netflix|es|subscription|";
    const plan = planificarAnuncios(
      new Map([
        [CLAVE, guardado({ para: en(10), vistoUltimo: en(-1) })],
        [otra, guardado({ para: en(-2), vistoUltimo: en(-3) })],
        [tercera, guardado({ para: en(5), vistoUltimo: en(2) })],
      ]),
      [
        observado({ para: en(11) }),
        observado({ para: en(11) }),
        observado({ para: en(9) }),
        observado({ clave: otra, para: en(8), enlace: null }),
        observado({ clave: tercera, para: en(6) }),
        observado({ clave: "tt0000004|netflix|es|subscription|", para: en(4) }),
      ],
      T,
      50,
    );
    const i = plan.informe;
    expect(i).toEqual({
      observados: 6,
      nuevos: 1,
      sinCambios: 0,
      actualizados: 1,
      fechasCambiadas: 1,
      enlacesCambiados: 0,
      nuevosCiclos: 1,
      mismaObservacion: 1,
      enlacesCompletados: 0,
      enlacesConservados: 0,
      fueraDeOrden: 1,
      sinEnlace: 1,
      conflictos: [expect.objectContaining({ clave: CLAVE })],
    });
    expect(
      i.nuevos +
        i.sinCambios +
        i.actualizados +
        i.nuevosCiclos +
        i.mismaObservacion +
        i.enlacesCompletados +
        i.fueraDeOrden +
        i.conflictos.length,
    ).toBe(i.observados);
    // La fuera de orden no escribe; las otras tres claves, una vez cada una.
    expect([...plan.escrituras.keys()].sort()).toEqual(
      [CLAVE, otra, "tt0000004|netflix|es|subscription|"].sort(),
    );
  });

  it("sumar informes acumula contadores y concatena conflictos", () => {
    const uno = planificarAnuncios(
      new Map(),
      [observado({ para: en(10) }), observado({ para: en(12) })],
      T,
      50,
    ).informe;
    const total = sumarInformesDeAnuncios(
      sumarInformesDeAnuncios(informeDeAnunciosVacio(), uno),
      uno,
    );
    expect(total.observados).toBe(4);
    expect(total.conflictos).toHaveLength(2);
  });
});
