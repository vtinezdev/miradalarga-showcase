import { describe, expect, it } from "vitest";
import {
  limpiarConsulta,
  normalizar,
  puntuar,
  resaltar,
} from "../../src/features/catalogo/busqueda.ts";
import { construirBusqueda } from "../../src/features/catalogo/consultas-busqueda.ts";
import { crearRepositorioDeDesarrollo } from "../../src/features/catalogo/desarrollo/repositorio-de-desarrollo.ts";
import { PLATAFORMAS } from "../../src/features/catalogo/desarrollo/datos.ts";
import { conFiltro, leerFiltros, sinFiltros } from "../../src/features/filtros/url.ts";
import {
  cumple,
  describirFiltros,
  facetasDelRadar,
  porDia,
  recuentos,
  type Filtrable,
} from "../../src/features/radar/filtros.ts";

const repo = crearRepositorioDeDesarrollo();

describe("búsqueda: reglas puras", () => {
  it("normaliza sin tildes ni mayúsculas y colapsa espacios", () => {
    expect(normalizar("  Norte   MAGNÉTICO ")).toBe("norte magnetico");
    expect(normalizar("Cañón")).toBe("canon");
  });

  it("recorta la consulta de la URL y acepta el primer valor repetido", () => {
    expect(limpiarConsulta(["  faro ", "otro"])).toBe("faro");
    expect(limpiarConsulta(undefined)).toBe("");
    expect(limpiarConsulta("x".repeat(300))).toHaveLength(100);
  });

  it("exige todas las palabras y puntúa exacto < prefijo < palabra < resto", () => {
    expect(puntuar("La casa del faro", "la casa del faro")).toBe(0);
    expect(puntuar("La casa del faro", "la casa")).toBe(1);
    expect(puntuar("La casa del faro", "faro")).toBe(2);
    expect(puntuar("La casa del faro", "aro")).toBe(3);
    expect(puntuar("La casa del faro", "faro isla")).toBeNull();
  });

  it("resalta sobre el texto original, con sus tildes", () => {
    const tramos = resaltar("Norte magnético", "magnetico");
    expect(tramos.filter((t) => t.resaltado).map((t) => t.texto)).toEqual([
      "magnético",
    ]);
    expect(tramos.map((t) => t.texto).join("")).toBe("Norte magnético");
  });
});

describe("búsqueda: repositorio y consulta", () => {
  it("encuentra sin tildes y por título original, y dice cuál coincidió", async () => {
    const { resultados } = await repo.buscar("magnetico", 50);
    expect(resultados.map((r) => r.titulo.id)).toEqual(["t-norte"]);
    expect(resultados[0]?.tituloOriginal).toBeUndefined();
    const original = await repo.buscar("magnetic north", 50);
    expect(original.resultados[0]?.tituloOriginal).toBe("Magnetic North");
  });

  it("ordena lo que empieza por la consulta antes que lo que la contiene", async () => {
    const { resultados } = await repo.buscar("la", 50);
    const primeros = resultados.slice(0, 3).map((r) => r.titulo.titulo);
    expect(primeros.every((t) => normalizar(t).startsWith("la"))).toBe(true);
  });

  it("cuenta todas las coincidencias aunque el límite corte la lista", async () => {
    const { resultados, total } = await repo.buscar("a", 3);
    expect(resultados).toHaveLength(3);
    expect(total).toBeGreaterThan(3);
  });

  it("cuatro estados: sin consulta, corta, sin resultados y resultados", async () => {
    const vacia = await construirBusqueda(repo, "");
    expect(vacia.estado).toBe("sin-consulta");
    expect(vacia.sugeridas).toHaveLength(3);

    expect((await construirBusqueda(repo, "a")).estado).toBe("corta");

    const nada = await construirBusqueda(repo, "zzzz");
    expect(nada.estado).toBe("sin-resultados");
    expect(nada.resultados).toEqual([]);
    expect(nada.sugeridas.length).toBeGreaterThan(0);

    const faro = await construirBusqueda(repo, "faro");
    expect(faro.estado).toBe("resultados");
    // «La casa del faro» está en dos listas.
    expect(faro.resultados.find((r) => r.titulo.id === "t-faro")?.enListas).toBe(2);
    expect(faro.sugeridas).toEqual([]);
  });

  it("un título que no está en ninguna lista no lleva nota de listas", async () => {
    const { resultados } = await construirBusqueda(repo, "alienigenas");
    expect(resultados[0]?.titulo.id).toBe("t-alien");
    expect(resultados[0]?.enListas).toBe(0);
  });
});

describe("filtros en la URL", () => {
  const facetas = facetasDelRadar(PLATAFORMAS);

  it("lee solo valores válidos: lo desconocido es «todo»", () => {
    expect(leerFiltros("?tipo=se-va&plataforma=apple-tv&obra=x", facetas)).toEqual({
      tipo: "se-va",
      plataforma: "apple-tv",
      obra: "",
    });
    // La plataforma va por slug, nunca por id: HBO Max es `max` de id canónico
    // y `hbo` de id del proveedor; ninguno de los dos es su slug.
    expect(leerFiltros("?plataforma=hbo", facetas).plataforma).toBe("");
    expect(leerFiltros("?plataforma=max", facetas).plataforma).toBe("");
    expect(leerFiltros("?plataforma=hbo-max", facetas).plataforma).toBe("hbo-max");
  });

  it("cambia una faceta conservando el resto de la query (p. ej. `q`)", () => {
    expect(conFiltro("?q=faro", "obra", "series")).toBe("?q=faro&obra=series");
    expect(conFiltro("?q=faro&obra=series", "obra", "")).toBe("?q=faro");
    expect(sinFiltros("?q=faro&tipo=llega&obra=series", facetas)).toBe("?q=faro");
    expect(sinFiltros("?tipo=llega", facetas)).toBe("");
  });
});

describe("filtros del radar", () => {
  const idPorSlug = new Map(PLATAFORMAS.map((p) => [p.slug, p.id]));
  const filas: (Filtrable & { dia: string })[] = [
    { tipo: "llega", plataforma: "netflix", obra: "pelicula", dia: "2026-09-27" },
    { tipo: "llega", plataforma: "max", obra: "serie", dia: "2026-09-27" },
    { tipo: "se-va", plataforma: "netflix", obra: "serie", dia: "2026-10-03" },
    { tipo: "se-fue", plataforma: "prime", obra: "pelicula", dia: "2026-09-20" },
  ];
  const sinMias = { idPorSlug, mias: new Set<string>() };

  it("combina tipo, plataforma (por slug) y obra", () => {
    const f = { tipo: "llega", plataforma: "hbo-max", obra: "" };
    expect(filas.filter((x) => cumple(x, f, sinMias))).toHaveLength(1);
    expect(filas.filter((x) => cumple(x, { obra: "series" }, sinMias))).toHaveLength(2);
  });

  it("«Mis plataformas» filtra por la selección del navegador; sin ella, nada", () => {
    const f = { plataforma: "mias" };
    expect(filas.filter((x) => cumple(x, f, sinMias))).toHaveLength(0);
    const conNetflix = { idPorSlug, mias: new Set(["netflix"]) };
    expect(filas.filter((x) => cumple(x, f, conNetflix))).toHaveLength(2);
  });

  it("cada chip cuenta lo que quedaría con él y los demás filtros puestos", () => {
    const r = recuentos(filas, { plataforma: "netflix" }, sinMias, "tipo", [
      "llega",
      "se-va",
      "se-fue",
    ]);
    expect(r).toEqual({ "": 2, llega: 1, "se-va": 1, "se-fue": 0 });
  });

  it("agrupa por día en el orden pedido", () => {
    expect(porDia(filas, "desc").map((d) => d.dia)).toEqual([
      "2026-10-03",
      "2026-09-27",
      "2026-09-20",
    ]);
    expect(porDia(filas, "asc")[0]?.filas).toHaveLength(1);
  });

  it("describe los filtros en palabras para la región viva", () => {
    expect(
      describirFiltros({ tipo: "se-va", plataforma: "hbo-max" }, PLATAFORMAS),
    ).toBe("filtrados por Se va y HBO Max");
    expect(describirFiltros({}, PLATAFORMAS)).toBe("");
  });
});
