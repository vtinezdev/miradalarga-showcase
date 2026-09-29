import { describe, expect, it } from "vitest";
import {
  construirFicha,
  construirPortada,
} from "../../src/features/catalogo/consultas.ts";
import { crearRepositorioDeDesarrollo } from "../../src/features/catalogo/desarrollo/repositorio-de-desarrollo.ts";
import {
  agruparOfertas,
  priorizarLoEditorial,
  priorizarMisPlataformas,
} from "../../src/features/catalogo/reglas.ts";
import type {
  Movimiento,
  Oferta,
  Plataforma,
} from "../../src/features/catalogo/modelo.ts";

const repo = crearRepositorioDeDesarrollo();

describe("consulta de la portada", () => {
  it("monta la selección principal con sus tres primeros títulos", async () => {
    const portada = await construirPortada(repo);
    expect(portada.destacada?.lista.titulo).toBe("Series cortas para un fin de semana");
    expect(portada.destacada?.entradas.map((e) => e.titulo.titulo)).toEqual([
      "Cinco noches",
      "Marea baja",
      "La cocina de Irene",
    ]);
  });

  it("no repite la destacada entre las selecciones", async () => {
    const portada = await construirPortada(repo);
    expect(portada.selecciones.map((l) => l.id)).not.toContain("l-fin-de-semana");
    expect(portada.totalDeListas).toBe(5);
  });

  it("«Acaba de llegar» es reciente y sube lo que está en nuestras listas", async () => {
    const portada = await construirPortada(repo);
    const llega = portada.radar.llega;
    // Las llegadas de hace meses no son noticia.
    expect(llega.map((f) => f.titulo.id)).not.toContain("t-plomo");
    expect(llega.map((f) => f.titulo.id)).not.toContain("t-marea");
    const primeraFuera = llega.findIndex((f) => !f.enListas);
    if (primeraFuera !== -1)
      expect(llega.slice(primeraFuera).every((f) => !f.enListas)).toBe(true);
  });

  it("dice qué plataformas cubre cada columna del radar", async () => {
    const { cobertura } = await construirPortada(repo);
    expect(cobertura.salidas.map((p) => p.id)).toEqual([
      "netflix",
      "prime",
      "max",
      "skyshowtime",
    ]);
    expect(cobertura.llegadasAnunciadas.map((p) => p.id)).not.toContain("skyshowtime");
  });

  it("cuenta las llegadas de la semana por plataforma", async () => {
    const { llegadasDeLaSemana } = await construirPortada(repo);
    // Desde el 21 sep 04:10 UTC: HBO Max (Cinco noches), Netflix (La casa del faro,
    // Cumbre, La vida en préstamo), Apple (Frontera norte), Prime (Los
    // alienígenas de Tabernas) y Disney+ (El colegio de las gaviotas).
    expect(llegadasDeLaSemana).toEqual({
      max: 1,
      netflix: 3,
      apple: 1,
      prime: 1,
      disney: 1,
    });
  });
});

describe("consulta de la ficha", () => {
  it("toma el veredicto de la lista revisada más recientemente y cita las demás", async () => {
    const vista = await construirFicha(repo, "serie", "marea-baja");
    expect(vista?.veredicto?.lista.id).toBe("l-fin-de-semana");
    expect(vista?.veredicto?.tambienEn.map((l) => l.id)).toEqual(["l-thrillers"]);
  });

  it("sin contexto editorial no hay veredicto: nunca se genera uno", async () => {
    const vista = await construirFicha(repo, "pelicula", "frontera-norte");
    expect(vista?.veredicto).toBeNull();
    expect(vista?.listas).toEqual([]);
  });

  it("relacionados solo fiables: misma dirección y mismas listas, sin repetir", async () => {
    const vista = await construirFicha(repo, "pelicula", "la-casa-del-faro");
    expect(vista?.relacionados.mismoDirector.map((t) => t.id)).toEqual(["t-frontera"]);
    const listas = vista?.relacionados.mismasListas.map((t) => t.id) ?? [];
    expect(listas).not.toContain("t-faro");
    expect(listas).not.toContain("t-frontera");
  });

  it("devuelve null para un slug desconocido", async () => {
    expect(await construirFicha(repo, "pelicula", "no-existe")).toBeNull();
  });
});

describe("reglas de disponibilidad", () => {
  const p = (id: string): Plataforma => ({ id, nombre: id, slug: id });
  const o = (plataforma: string, tipo: Oferta["tipo"]): Oferta => ({
    plataforma: p(plataforma),
    tipo,
    enlace: "https://example.com",
  });

  it("agrupa por plataforma con lo incluido antes que lo que se paga aparte", () => {
    const grupos = agruparOfertas([
      o("prime", "buy"),
      o("apple", "rent"),
      o("prime", "rent"),
      o("netflix", "subscription"),
    ]);
    expect(grupos.map((g) => g.plataforma.id)).toEqual(["netflix", "prime", "apple"]);
    expect(grupos[1]?.ofertas.map((x) => x.tipo)).toEqual(["rent", "buy"]);
  });

  it("sube tus plataformas sin barajar el resto", () => {
    const grupos = [
      { plataforma: p("a") },
      { plataforma: p("b") },
      { plataforma: p("c") },
      { plataforma: p("d") },
    ];
    expect(
      priorizarMisPlataformas(grupos, new Set(["c"])).map((g) => g.plataforma.id),
    ).toEqual(["c", "a", "b", "d"]);
    expect(
      priorizarMisPlataformas(grupos, new Set()).map((g) => g.plataforma.id),
    ).toEqual(["a", "b", "c", "d"]);
  });

  it("prioriza lo editorial conservando el orden de fecha", () => {
    const m = (tituloId: string): Movimiento => ({
      tipo: "llega",
      tituloId,
      plataforma: p("x"),
      fecha: "2026-09-01T00:00:00Z",
    });
    const resultado = priorizarLoEditorial(
      [m("1"), m("2"), m("3"), m("4")],
      new Set(["3", "1"]),
      3,
    );
    expect(resultado.map((x) => x.tituloId)).toEqual(["1", "3", "2"]);
  });
});
