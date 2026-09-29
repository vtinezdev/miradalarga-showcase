import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  ATRIBUTO,
  CLAVE,
  guardarSeleccion,
  leerSeleccion,
  normalizar,
  scriptInicial,
} from "../../src/features/mis-plataformas/almacen.ts";
import {
  cssDeMisPlataformas,
  idsSeguros,
} from "../../src/features/mis-plataformas/arranque.ts";

const VALIDOS = new Set(["netflix", "prime", "disney", "max", "apple", "skyshowtime"]);

function almacenFalso(inicial: Record<string, string> = {}) {
  const datos = new Map(Object.entries(inicial));
  return {
    datos,
    getItem: (k: string) => datos.get(k) ?? null,
    setItem: (k: string, v: string) => void datos.set(k, v),
    removeItem: (k: string) => void datos.delete(k),
  };
}

describe("persistencia local de Mis plataformas (`ml.plataformas`)", () => {
  it("guarda JSON versionado con ids y fecha, y lo vuelve a leer", () => {
    const almacen = almacenFalso();
    expect(
      guardarSeleccion(
        almacen,
        ["max", "netflix"],
        VALIDOS,
        new Date("2026-09-28T20:00:00Z"),
      ),
    ).toBe(true);
    expect(JSON.parse(almacen.datos.get(CLAVE) ?? "")).toEqual({
      v: 1,
      ids: ["netflix", "max"],
      actualizado: "2026-09-28T20:00:00.000Z",
    });
    expect(leerSeleccion(almacen, VALIDOS)).toEqual(["netflix", "max"]);
  });

  it("borra la clave cuando no queda ninguna marcada", () => {
    const almacen = almacenFalso({
      [CLAVE]: JSON.stringify({ v: 1, ids: ["netflix"] }),
    });
    guardarSeleccion(almacen, [], VALIDOS);
    expect(almacen.datos.has(CLAVE)).toBe(false);
  });

  it("descarta en silencio basura, versiones desconocidas e ids que no existen", () => {
    expect(leerSeleccion(almacenFalso({ [CLAVE]: "{roto" }), VALIDOS)).toEqual([]);
    expect(
      leerSeleccion(
        almacenFalso({ [CLAVE]: JSON.stringify({ v: 2, ids: ["netflix"] }) }),
        VALIDOS,
      ),
    ).toEqual([]);
    expect(
      leerSeleccion(
        almacenFalso({
          [CLAVE]: JSON.stringify({ v: 1, ids: ["netflix", "Max", 7, "filmin"] }),
        }),
        VALIDOS,
      ),
    ).toEqual(["netflix"]);
  });

  it("un navegador que no deja guardar no rompe nada", () => {
    const hostil = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => undefined,
    };
    expect(leerSeleccion(hostil, VALIDOS)).toEqual([]);
    expect(guardarSeleccion(hostil, ["netflix"], VALIDOS)).toBe(false);
    expect(leerSeleccion(null, VALIDOS)).toEqual([]);
    expect(guardarSeleccion(null, ["netflix"], VALIDOS)).toBe(false);
  });

  it("normaliza sin duplicados y en el orden de las plataformas", () => {
    expect(normalizar(["max", "netflix", "max"], VALIDOS)).toEqual(["netflix", "max"]);
  });
});

describe("arranque antes del primer pintado", () => {
  function ejecutarScript(guardado: string | null) {
    const atributos = new Map<string, string>();
    runInNewContext(scriptInicial([...VALIDOS]), {
      localStorage: { getItem: () => guardado },
      document: {
        documentElement: {
          setAttribute: (k: string, v: string) => atributos.set(k, v),
        },
      },
      JSON,
    });
    return atributos.get(ATRIBUTO);
  }

  it("copia la selección válida al atributo de <html>", () => {
    expect(
      ejecutarScript(JSON.stringify({ v: 1, ids: ["max", "inventada", "netflix"] })),
    ).toBe("netflix max");
  });

  it("sin selección, o con basura, no toca el atributo", () => {
    expect(ejecutarScript(null)).toBeUndefined();
    expect(ejecutarScript("{roto")).toBeUndefined();
    expect(ejecutarScript(JSON.stringify({ v: 9, ids: ["netflix"] }))).toBeUndefined();
  });

  it("genera una regla CSS por plataforma y no deja pasar ids peligrosos", () => {
    expect(idsSeguros(["netflix", 'x"]{}*{color:red', "max"])).toEqual([
      "netflix",
      "max",
    ]);
    const css = cssDeMisPlataformas(["netflix", "max"]);
    expect(css).toContain(
      'html[data-mis-plataformas~="netflix"] [data-plataforma="netflix"]',
    );
    expect(css).toContain('html[data-mis-plataformas~="max"] [data-plataforma="max"]');
    expect(css).toContain(".ml-sin-seleccion{display:none}");
  });
});
