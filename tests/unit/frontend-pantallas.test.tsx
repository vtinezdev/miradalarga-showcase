import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  construirHubDePlataforma,
  construirHubDeTipo,
  construirIndiceDePlataformas,
} from "../../src/features/catalogo/consultas-hubs.ts";
import {
  construirIndiceDeListas,
  construirLista,
} from "../../src/features/catalogo/consultas-listas.ts";
import { construirRadar } from "../../src/features/catalogo/consultas-radar.ts";
import { construirBusqueda } from "../../src/features/catalogo/consultas-busqueda.ts";
import {
  CAPACIDADES,
  FICHAS,
  LISTAS,
  MOVIMIENTOS,
  PLATAFORMAS,
} from "../../src/features/catalogo/desarrollo/datos.ts";
import { crearRepositorioDeDesarrollo } from "../../src/features/catalogo/desarrollo/repositorio-de-desarrollo.ts";
import { mensajeDeCapacidad } from "../../src/features/catalogo/formato.ts";
import { pasaChecklistDeLanding } from "../../src/features/catalogo/reglas.ts";
import { Busqueda } from "../../src/features/busqueda/Busqueda.tsx";
import { HubDeTipo } from "../../src/features/hubs/HubDeTipo.tsx";
import { IndiceDeListas } from "../../src/features/listas/IndiceDeListas.tsx";
import { PaginaDeLista } from "../../src/features/listas/PaginaDeLista.tsx";
import { metadatosDeLista } from "../../src/features/listas/seo.ts";
import { HubDePlataforma } from "../../src/features/plataformas/HubDePlataforma.tsx";
import { IndiceDePlataformas } from "../../src/features/plataformas/IndiceDePlataformas.tsx";
import { Radar } from "../../src/features/radar/Radar.tsx";
import { rutasDelSitemap } from "../../src/lib/sitemap.ts";

const repo = crearRepositorioDeDesarrollo();
const validos = PLATAFORMAS.map((p) => p.id);

function encabezados(html: string): string[] {
  return [...html.matchAll(/<h([1-6])\b/g)].map((m) => `h${m[1]}`);
}

/** Sin saltos de nivel: tras un hN solo puede venir, como mucho, un hN+1. */
function sinSaltos(html: string): boolean {
  const niveles = encabezados(html).map((h) => Number(h.slice(1)));
  return niveles.every((n, i) => i === 0 || n <= niveles[i - 1]! + 1);
}

function unH1(html: string) {
  expect(encabezados(html).filter((h) => h === "h1")).toHaveLength(1);
  expect(encabezados(html)[0]).toBe("h1");
  expect(sinSaltos(html)).toBe(true);
}

describe("mensajes de capacidad: cuatro estados, cuatro frases", () => {
  it("distingue no soportado, no medido, sin datos en la muestra y ausencia real", () => {
    const frases = (
      [
        "supported_with_data",
        "supported_no_data_in_sample",
        "not_supported",
        "unknown",
      ] as const
    ).map((e) => mensajeDeCapacidad("upcoming", e, "SkyShowtime"));
    expect(new Set(frases).size).toBe(4);
    expect(frases[2]).toBe("SkyShowtime no anuncia sus próximas llegadas.");
    expect(frases[3]).toMatch(/Todavía no medimos/);
  });
});

describe("radar", () => {
  it("reúne la ventana alrededor de hoy, solo con lo que la matriz permite", async () => {
    const vista = await construirRadar(repo);
    const desde = Date.parse(vista.desde);
    const hasta = Date.parse(vista.hasta);
    const hoy = Date.parse(vista.comprobadoEn);
    for (const { movimiento: m } of vista.filas) {
      const t = Date.parse(m.fecha);
      expect(t).toBeGreaterThanOrEqual(desde);
      expect(t).toBeLessThanOrEqual(hasta);
      if (m.tipo === "se-va" || m.tipo === "proximamente")
        expect(t).toBeGreaterThanOrEqual(hoy);
      else expect(t).toBeLessThanOrEqual(hoy);
    }
    // Nunca antes de que empezáramos a registrar.
    expect(desde).toBeGreaterThanOrEqual(Date.parse(vista.inicioDelRegistro));
    // Los cinco tipos, y ninguna llegada anunciada de SkyShowtime (❌).
    expect(new Set(vista.filas.map((f) => f.movimiento.tipo)).size).toBe(5);
    expect(
      vista.filas.some(
        (f) =>
          f.movimiento.tipo === "proximamente" &&
          f.movimiento.plataforma.id === "skyshowtime",
      ),
    ).toBe(false);
    // Lo de hace meses no es noticia.
    expect(vista.filas.some((f) => f.titulo.id === "t-plomo")).toBe(false);
    expect(vista.capacidades.skyshowtime?.upcoming).toBe("not_supported");
  });

  it("el HTML servido trae todo el radar, sin filtrar, con un h1", async () => {
    const vista = await construirRadar(repo);
    const html = renderToStaticMarkup(<Radar vista={vista} />);
    unH1(html);
    for (const f of vista.filas) expect(html).toContain(f.titulo.titulo);
    expect(html).toMatch(/registramos cambios desde el/);
    // Filtros con estado accesible y la regla con hoy marcado.
    expect(html).toMatch(/<fieldset/);
    expect(html).toContain('aria-pressed="true"');
    expect(html.match(/data-hoy=""/g)).toHaveLength(1);
    expect(html).toContain("Lo que ha pasado");
    expect(html).toContain("Lo que viene");
    expect(html).toContain("De nuestras listas");
  });
});

describe("búsqueda renderizada", () => {
  it("sin resultados: mensaje honesto y salidas, sin «0 resultados» a secas", async () => {
    const html = renderToStaticMarkup(
      <Busqueda
        vista={await construirBusqueda(repo, "zzzz")}
        filtrosIniciales="?q=zzzz"
      />,
    );
    unH1(html);
    expect(html).toContain("No tenemos «zzzz» en el catálogo");
    expect(html).toContain("Revisa la ortografía");
    expect(html).not.toMatch(/>0 resultados/);
  });

  it("con resultados: agrupados por Películas y Series, con la coincidencia marcada", async () => {
    const html = renderToStaticMarkup(
      <Busqueda
        vista={await construirBusqueda(repo, "noche")}
        filtrosIniciales="?q=noche"
      />,
    );
    unH1(html);
    expect(html).toContain(">Películas");
    expect(html).toContain(">Series");
    expect(html).toMatch(/<mark>[Nn]oche<\/mark>/);
    expect(html).toContain("resultados para «noche»");
  });

  it("los filtros de la URL llegan aplicados en el HTML servido (sin salto al hidratar)", async () => {
    const vista = await construirBusqueda(repo, "noche");
    const html = renderToStaticMarkup(
      <Busqueda vista={vista} filtrosIniciales="?q=noche&obra=series" />,
    );
    expect(html).not.toContain(">Películas <");
    expect(html).toContain("Cinco noches");
  });
});

describe("listas", () => {
  it("el índice va de la revisada más reciente a la más antigua y marca la destacada", async () => {
    const datos = await construirIndiceDeListas(repo);
    const revisadas = datos.listas.map((l) => l.revisada);
    expect(revisadas).toEqual([...revisadas].sort().reverse());
    expect(datos.destacadaId).toBe("l-fin-de-semana");
    const html = renderToStaticMarkup(
      <IndiceDeListas datos={datos} plataformasValidas={validos} />,
    );
    unH1(html);
    expect(html).toContain("Selección de la semana");
    for (const l of datos.listas) expect(html).toContain(l.titulo);
  });

  it("un slug desconocido no tiene lista (la ruta responde 404)", async () => {
    expect(await construirLista(repo, "no-existe")).toBeNull();
  });

  it("entradas en el orden del autor; lo que se fue sigue en su sitio, con fecha", async () => {
    const vista = await construirLista(
      repo,
      "catorce-titulos-para-las-noches-de-otono",
    );
    if (!vista) throw new Error("sin lista");
    expect(vista.entradas.map((e) => e.entrada.orden)).toEqual(
      Array.from({ length: 14 }, (_, i) => i + 1),
    );
    const sombra = vista.entradas.find((e) => e.titulo.id === "t-sombra");
    expect(sombra?.titulo.disponibilidad).toEqual([]);
    expect(sombra?.titulo.fueraDesde).toBe("2026-09-23T00:00:00Z");
    const html = renderToStaticMarkup(
      <PaginaDeLista vista={vista} plataformasValidas={validos} />,
    );
    unH1(html);
    expect(html).toContain("Ya no está en ninguna plataforma que seguimos");
    expect(html).toContain("Cómo la hemos hecho");
    expect(html).toContain('"@type":"ItemList"');
    expect(html).not.toContain("aggregateRating");
    // El conmutador existe, apagado: el HTML servido es la lista entera.
    expect(html).toContain("Solo en mis plataformas");
    expect(html).not.toMatch(/type="checkbox"[^>]*checked/);
    expect(
      html.match(/<h2[^>]*>(?:<span class="sr-only">\d+\. <\/span>)/g),
    ).toHaveLength(14);
  });

  it("solo la lista con ≥ 12 disponibles y ≥ 120 palabras de introducción es indexable", async () => {
    const larga = await construirLista(
      repo,
      "catorce-titulos-para-las-noches-de-otono",
    );
    const corta = await construirLista(repo, "series-cortas-para-un-fin-de-semana");
    expect(larga?.indexable).toBe(true);
    expect(corta?.indexable).toBe(false);
    if (!larga || !corta) throw new Error("sin listas");
    expect(metadatosDeLista(larga).robots).toBeUndefined();
    expect(metadatosDeLista(corta).robots).toEqual({ index: false, follow: true });
    expect(
      pasaChecklistDeLanding({
        introduccion: "palabra ".repeat(119),
        autor: { nombre: "A" },
        revisada: "2026-09-01",
        disponiblesHoy: 20,
      }),
    ).toBe(false);
  });
});

describe("plataformas", () => {
  it("el índice cuenta cada plataforma y dice lo que no podemos saber de ella", async () => {
    const datos = await construirIndiceDePlataformas(repo);
    expect(datos.plataformas.map((p) => p.plataforma.slug)).toEqual([
      "netflix",
      "prime-video",
      "disney-plus",
      "hbo-max",
      "apple-tv",
      "skyshowtime",
    ]);
    const sky = datos.plataformas.find((p) => p.plataforma.id === "skyshowtime");
    expect(sky?.limites).toEqual(["SkyShowtime no anuncia sus próximas llegadas."]);
    const netflix = datos.plataformas.find((p) => p.plataforma.id === "netflix");
    expect(netflix?.limites).toEqual([]);
    for (const t of netflix?.deNuestrasListas ?? [])
      expect(t.disponibilidad.some((o) => o.plataforma.id === "netflix")).toBe(true);
    const html = renderToStaticMarkup(<IndiceDePlataformas datos={datos} />);
    unH1(html);
  });

  it("un slug desconocido no tiene hub; ni el id canónico ni el del proveedor son slugs", async () => {
    expect(await construirHubDePlataforma(repo, "no-existe")).toBeNull();
    expect(await construirHubDePlataforma(repo, "hbo")).toBeNull();
    expect(await construirHubDePlataforma(repo, "max")).toBeNull();
    expect((await construirHubDePlataforma(repo, "hbo-max"))?.plataforma).toEqual({
      id: "max",
      nombre: "HBO Max",
      slug: "hbo-max",
    });
  });

  it("Netflix: lo mejor según nuestras listas, radar completo y rankings publicables", async () => {
    const hub = await construirHubDePlataforma(repo, "netflix");
    if (!hub) throw new Error("sin hub");
    expect(hub.deNuestrasListas.length).toBeGreaterThan(0);
    for (const x of hub.deNuestrasListas)
      expect(x.titulo.disponibilidad.some((o) => o.plataforma.id === "netflix")).toBe(
        true,
      );
    for (const c of hub.radar)
      for (const f of c.filas) expect(f.movimiento.plataforma.id).toBe("netflix");
    expect(hub.mejorValoradas.peliculas.length).toBeGreaterThanOrEqual(3);
    expect(hub.mejorValoradas.peliculas.map((p) => p.posicion)).toEqual(
      hub.mejorValoradas.peliculas.map((_, i) => i + 1),
    );
    const html = renderToStaticMarkup(
      <HubDePlataforma datos={hub} plataformasValidas={validos} />,
    );
    unH1(html);
    expect(html).toContain("Qué ver en Netflix");
    expect(html).toContain('href="/radar?plataforma=netflix"');
    expect(html).toContain('"@type":"BreadcrumbList"');
  });

  it("se adapta a lo que hay: sin bloques vacíos y con la razón de cada hueco", async () => {
    const disney = await construirHubDePlataforma(repo, "disney-plus");
    const sky = await construirHubDePlataforma(repo, "skyshowtime");
    if (!disney || !sky) throw new Error("sin hub");
    // Disney+ no alcanza el mínimo de títulos para publicar un ranking.
    expect(disney.mejorValoradas).toEqual({ peliculas: [], series: [] });
    const htmlDisney = renderToStaticMarkup(
      <HubDePlataforma datos={disney} plataformasValidas={validos} />,
    );
    expect(htmlDisney).not.toContain("Mejor valoradas en Disney+");
    expect(htmlDisney).not.toContain('href="#mejor-valoradas"');
    expect(htmlDisney).toContain("No hemos visto salidas anunciadas en Disney+.");
    const proximamente = sky.radar.find((c) => c.tipo === "proximamente");
    expect(proximamente?.filas).toEqual([]);
    expect(proximamente?.nota).toBe("SkyShowtime no anuncia sus próximas llegadas.");
  });
});

describe("hubs de tipo", () => {
  it("series: temporadas, las de una sola temporada y géneros con muestra alfabética", async () => {
    const hub = await construirHubDeTipo(repo, "serie");
    expect(hub.unaTemporada.length).toBeGreaterThan(0);
    for (const t of hub.unaTemporada) {
      expect(t.tipo).toBe("serie");
      expect(t.temporadas).toBe(1);
      expect(t.disponibilidad.length).toBeGreaterThan(0);
    }
    const recuentos = hub.generos.map((g) => g.recuento);
    expect(recuentos).toEqual([...recuentos].sort((a, b) => b - a));
    for (const g of hub.generos) {
      const nombres = g.titulos.map((t) => t.titulo);
      expect(nombres).toEqual([...nombres].sort((a, b) => a.localeCompare(b, "es-ES")));
    }
    for (const c of hub.radar)
      for (const f of c.filas) expect(f.titulo.tipo).toBe("serie");
    const html = renderToStaticMarkup(
      <HubDeTipo datos={hub} plataformasValidas={validos} />,
    );
    unH1(html);
    expect(html).toContain("De una sola temporada");
    expect(html).toMatch(/1 temporada/);
  });

  it("películas: sin el bloque de temporadas, con ranking y por plataforma", async () => {
    const hub = await construirHubDeTipo(repo, "pelicula");
    expect(hub.unaTemporada).toEqual([]);
    expect(hub.mejorValoradas.every((p) => p.titulo.tipo === "pelicula")).toBe(true);
    expect(hub.porPlataforma).toHaveLength(6);
    expect(hub.total).toBe(
      FICHAS.filter((f) => f.tipo === "pelicula" && f.ofertas.length > 0).length,
    );
    const html = renderToStaticMarkup(
      <HubDeTipo datos={hub} plataformasValidas={validos} />,
    );
    unH1(html);
    expect(html).not.toContain("De una sola temporada");
    expect(html).toContain("Así lo calculamos");
  });

  it("sin llegadas en la ventana, la columna lo dice en vez de quedar vacía", async () => {
    const sinLlegadas = crearRepositorioDeDesarrollo({
      fichas: FICHAS,
      listas: LISTAS,
      capacidades: CAPACIDADES,
      movimientos: MOVIMIENTOS.filter((m) => m.tipo !== "llega"),
    });
    const hub = await construirHubDeTipo(sinLlegadas, "pelicula");
    const llega = hub.radar.find((c) => c.tipo === "llega");
    expect(llega?.filas).toEqual([]);
    expect(llega?.nota).toBe("Ninguna llegada de películas en los últimos 14 días.");
  });
});

describe("sitemap", () => {
  it("incluye las secciones indexables y deja fuera búsqueda y filtros", () => {
    const rutas = rutasDelSitemap({
      peliculas: ["a"],
      series: ["b"],
      plataformas: ["netflix"],
      listas: ["l"],
    });
    expect(rutas).toEqual(
      expect.arrayContaining([
        "/",
        "/peliculas",
        "/series",
        "/listas",
        "/radar",
        "/plataformas",
        "/plataformas/netflix",
        "/listas/l",
        "/peliculas/a",
        "/series/b",
      ]),
    );
    expect(rutas.some((r) => r.includes("buscar") || r.includes("?"))).toBe(false);
  });
});
