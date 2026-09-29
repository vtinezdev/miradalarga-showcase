import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlatformSelector } from "../../src/components/ui/PlatformSelector.tsx";
import { ReglaTemporal } from "../../src/components/ui/ReglaTemporal.tsx";
import { TitleImage } from "../../src/components/ui/TitleImage.tsx";
import {
  construirFicha,
  construirPortada,
} from "../../src/features/catalogo/consultas.ts";
import { PLATAFORMAS } from "../../src/features/catalogo/desarrollo/datos.ts";
import { crearRepositorioDeDesarrollo } from "../../src/features/catalogo/desarrollo/repositorio-de-desarrollo.ts";
import type { TipoDeObra } from "../../src/features/catalogo/modelo.ts";
import { FichaDeTitulo } from "../../src/features/ficha/FichaDeTitulo.tsx";
import {
  datosEstructuradosDeFicha,
  metadatosDeFicha,
} from "../../src/features/ficha/seo.ts";
import { Portada } from "../../src/features/portada/Portada.tsx";
import { DESTINOS, esDestinoActual } from "../../src/lib/navegacion.ts";

/**
 * La interfaz renderizada a HTML estático, como la sirve el servidor: sin
 * navegador y sin Mis plataformas (el HTML servido nunca depende de ellas).
 */

const repo = crearRepositorioDeDesarrollo();
const validos = PLATAFORMAS.map((p) => p.id);

async function htmlDeFicha(tipo: TipoDeObra, slug: string) {
  const vista = await construirFicha(repo, tipo, slug);
  if (!vista) throw new Error(`Sin ficha ${slug}`);
  return {
    vista,
    html: renderToStaticMarkup(
      <FichaDeTitulo vista={vista} plataformasValidas={validos} />,
    ),
  };
}

function encabezados(html: string): string[] {
  return [...html.matchAll(/<h([1-6])\b/g)].map((m) => `h${m[1]}`);
}

describe("portada", () => {
  it("sigue la jerarquía aprobada: lema como único h1 y secciones en orden", async () => {
    const html = renderToStaticMarkup(<Portada datos={await construirPortada(repo)} />);
    expect(encabezados(html).filter((h) => h === "h1")).toHaveLength(1);
    expect(html).toMatch(/<h1[^>]*>Qué merece la pena ver, y dónde verlo<\/h1>/);
    const orden = [
      "Series cortas para un fin de semana",
      "Encuentra qué ver",
      "Qué merece la pena ver</h2>",
      "Radar del catálogo</h2>",
      "Mejor valoradas</h2>",
      "Explora por plataforma",
    ].map((texto) => html.indexOf(texto));
    expect(orden.every((i) => i !== -1)).toBe(true);
    expect(orden).toEqual([...orden].sort((a, b) => a - b));
  });

  it("funciona sin imágenes: la selección principal es tipográfica y no hay <img>", async () => {
    const html = renderToStaticMarkup(<Portada datos={await construirPortada(repo)} />);
    // Ningún título de la portada tiene imagen publicable salvo los de relleno de
    // las tarjetas; la selección principal no depende de ninguna.
    expect(html).toContain("data-placeholder");
    expect(html).not.toMatch(/<img[^>]+fetchPriority="high"/i);
  });

  it("el ranking automático no usa vocabulario editorial y enlaza su metodología", async () => {
    const html = renderToStaticMarkup(<Portada datos={await construirPortada(repo)} />);
    const ranking = html.slice(
      html.indexOf("Mejor valoradas</h2>"),
      html.indexOf("Explora por plataforma"),
    );
    expect(ranking).toContain("Así lo calculamos");
    expect(ranking).toContain("valoración externa");
    expect(ranking).not.toMatch(
      /recomendamos|nuestra selección|imprescindible|Por <a/i,
    );
  });

  it("el HTML del servidor no depende de Mis plataformas: nada marcado, nada filtrado", async () => {
    const datos = await construirPortada(repo);
    const html = renderToStaticMarkup(<Portada datos={datos} />);
    expect(html).not.toMatch(/checked=""/);
    expect(html).not.toContain("data-mis-plataformas");
    // Todo lo del radar está en el HTML, sea de la plataforma que sea.
    for (const fila of [
      ...datos.radar.llega,
      ...datos.radar.seVa,
      ...datos.radar.proximamente,
      ...datos.radar.seFue,
      ...datos.radar.cambios,
    ]) {
      expect(html).toContain(fila.titulo.titulo.replace(/&/g, "&amp;"));
    }
  });
});

describe("ficha de título", () => {
  it("película con imagen: un h1, «Dónde ver» antes que el veredicto y la sinopsis", async () => {
    const { html } = await htmlDeFicha("pelicula", "la-casa-del-faro");
    expect(encabezados(html).filter((h) => h === "h1")).toHaveLength(1);
    const donde = html.indexOf("Dónde ver La casa del faro");
    expect(donde).toBeGreaterThan(-1);
    expect(donde).toBeLessThan(html.indexOf("Por qué la recomendamos"));
    expect(donde).toBeLessThan(html.indexOf(">Sinopsis<"));
    expect(html).toContain("/desarrollo/faro-fondo.svg");
    expect(html).toContain("Comprobado");
    expect(html).toContain("Streaming Availability");
  });

  it("alquiler, compra y precio solo si lo tenemos", async () => {
    const { html } = await htmlDeFicha("pelicula", "frontera-norte");
    // Intl separa la cifra del símbolo con un espacio de no separación.
    expect(html).toMatch(/Alquiler desde 3,99\s€/);
    expect(html).toMatch(/Compra desde 12,99\s€/);
    // Apple: compra sin precio conocido → «Compra», sin inventar cifra.
    expect(html).toMatch(/>Compra<\/span>/);
  });

  it("sin contexto editorial no hay bloque de veredicto", async () => {
    const { html } = await htmlDeFicha("pelicula", "frontera-norte");
    expect(html).not.toContain("Por qué la recomendamos");
  });

  it("serie sin imagen: cabecera tipográfica, sin cartel que repita el título", async () => {
    const { html } = await htmlDeFicha("serie", "cinco-noches");
    const cabecera = html.slice(0, html.indexOf("Dónde ver Cinco noches"));
    expect(cabecera).not.toContain("data-placeholder");
    expect(cabecera).not.toContain("<img");
    expect(html).toContain("1 temporada · 5 episodios");
  });

  it("sin sinopsis en español, el bloque desaparece (sin traducción ni «N/D»)", async () => {
    const { html } = await htmlDeFicha("serie", "distrito-once");
    expect(html).not.toContain(">Sinopsis<");
    expect(html).not.toMatch(/N\/D|no disponible/i);
  });

  it("título sin disponibilidad: lo dice y muestra su última salida", async () => {
    const { html } = await htmlDeFicha("pelicula", "el-ultimo-tren-a-soria");
    expect(html).toContain(
      "Ahora mismo no está en ninguna de las seis plataformas que seguimos",
    );
    expect(html).toContain("Salió de Prime Video");
  });

  it("título largo y sinopsis larga: se pintan enteros, con sus párrafos", async () => {
    const { vista, html } = await htmlDeFicha(
      "pelicula",
      "todo-lo-que-no-nos-dijimos-el-invierno-en-que-dejamos-de-escribirnos-cartas",
    );
    expect(html).toContain(`>${vista.ficha.titulo}</h1>`);
    expect(html.match(/<p>/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("datos estructurados: Movie/TVSeries con WatchAction y nunca aggregateRating", async () => {
    for (const [tipo, slug, esperado] of [
      ["pelicula", "la-casa-del-faro", "Movie"],
      ["serie", "los-anos-de-plomo", "TVSeries"],
    ] as const) {
      const vista = await construirFicha(repo, tipo, slug);
      if (!vista) throw new Error("sin ficha");
      const [obra, migas] = datosEstructuradosDeFicha(vista) as Record<
        string,
        unknown
      >[];
      expect(obra?.["@type"]).toBe(esperado);
      expect(JSON.stringify(obra)).toContain("WatchAction");
      expect(JSON.stringify(obra)).not.toContain("aggregateRating");
      expect(migas?.["@type"]).toBe("BreadcrumbList");
      expect(metadatosDeFicha(vista).alternates?.canonical).toBe(
        `/${tipo === "pelicula" ? "peliculas" : "series"}/${slug}`,
      );
    }
  });
});

describe("imagen o placeholder editorial (ADR 0008)", () => {
  const titulo = {
    id: "t-x",
    titulo: "Un título",
    tipo: "pelicula" as const,
    anio: 2020,
  };

  it("sin imagen publicable pinta el cartel tipográfico, decorativo y en el mismo hueco", () => {
    const html = renderToStaticMarkup(
      <TitleImage
        titulo={titulo}
        imagen={undefined}
        proporcion="poster"
        sizes="100px"
      />,
    );
    expect(html).toContain("data-placeholder");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('data-proporcion="poster"');
    expect(html).not.toContain("<img");
  });

  it("con imagen publicable pinta <img> con dimensiones y alt vacío", () => {
    const html = renderToStaticMarkup(
      <TitleImage
        titulo={titulo}
        imagen={{ url: "/x.svg", ancho: 600, alto: 900 }}
        proporcion="poster"
        sizes="100px"
      />,
    );
    expect(html).toMatch(/<img[^>]+src="\/x.svg"/);
    expect(html).toContain('width="600"');
    expect(html).toContain('alt=""');
    expect(html).not.toContain("data-placeholder");
  });

  it("el cartel es determinista: mismo id, mismo campo y horizonte", () => {
    const a = renderToStaticMarkup(
      <TitleImage titulo={titulo} imagen={undefined} proporcion="poster" sizes="1px" />,
    );
    const b = renderToStaticMarkup(
      <TitleImage titulo={titulo} imagen={undefined} proporcion="poster" sizes="1px" />,
    );
    expect(a).toBe(b);
  });
});

describe("selector de Mis plataformas", () => {
  it("seis casillas nativas con su nombre, dentro de un fieldset con leyenda", () => {
    const html = renderToStaticMarkup(
      <PlatformSelector plataformas={PLATAFORMAS} variante="en-linea" />,
    );
    expect(html).toMatch(/<fieldset/);
    expect(html).toMatch(/<legend[^>]*>Mis plataformas<\/legend>/);
    expect(html.match(/type="checkbox"/g)).toHaveLength(6);
    for (const p of PLATAFORMAS) expect(html).toContain(`>${p.nombre}</span>`);
    expect(html).toContain("Se guarda solo en este navegador. Sin cuenta.");
    expect(html).toMatch(/role="status"/);
  });
});

describe("regla temporal del radar", () => {
  it("los cinco tipos, un día por columna en orden cronológico y hoy marcado aunque esté vacío", async () => {
    const datos = await construirPortada(repo);
    const filas = [
      ...datos.radar.llega,
      ...datos.radar.seFue,
      ...datos.radar.cambios,
      ...datos.radar.seVa,
      ...datos.radar.proximamente,
    ];
    const tipos = new Set(filas.map((f) => f.movimiento.tipo));
    expect([...tipos].sort()).toEqual(
      ["cambio", "llega", "proximamente", "se-fue", "se-va"].sort(),
    );
    const html = renderToStaticMarkup(
      <ReglaTemporal filas={filas} referencia={datos.comprobadoEn} etiqueta="Radar" />,
    );
    for (const tipo of tipos) expect(html).toContain(`data-tipo="${tipo}"`);
    const dias = [...html.matchAll(/<h3[^>]*><time dateTime="([\d-]+)"/g)].map(
      (m) => m[1],
    );
    expect(dias).toEqual([...dias].sort());
    // Hoy es el día de la edición: existe aunque no tenga movimientos.
    expect(html.match(/data-hoy=""/g)).toHaveLength(1);
    expect(dias).toContain("2026-09-28");
    expect(html).toContain("Nada registrado este día.");
    // El servidor nunca escribe «Hoy» como nombre del día: el HTML se cachea.
    expect(html).not.toMatch(/<time dateTime="[\d-]+">Hoy</);
  });
});

describe("navegación", () => {
  it("cinco destinos primarios en el orden aprobado", () => {
    expect(DESTINOS.map((d) => d.etiqueta)).toEqual([
      "Listas",
      "Películas",
      "Series",
      "Radar",
      "Plataformas",
    ]);
  });

  it("una ficha activa su sección, y nada más", () => {
    expect(esDestinoActual("/peliculas/la-casa-del-faro", "/peliculas")).toBe(true);
    expect(esDestinoActual("/peliculas", "/peliculas")).toBe(true);
    expect(esDestinoActual("/series/marea-baja", "/peliculas")).toBe(false);
    expect(esDestinoActual("/peliculas-antiguas", "/peliculas")).toBe(false);
  });
});
