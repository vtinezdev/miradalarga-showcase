/**
 * Adaptador de lectura de Neon (`src/db/queries/`), **sin base de datos**:
 * slugs, mapeo fila → modelo, el repositorio sobre un lector doble que devuelve
 * filas fijas, el SQL que de verdad se emite y la selección de fuente.
 *
 * Lo que un doble no puede probar —que el SQL corre contra el esquema real y
 * no escribe— lo prueba `pnpm ops historica db:validate:catalogo`.
 */
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import * as q from "@/db/queries/catalogo-sql.ts";
import { ErrorDeCatalogo, sanear } from "@/db/queries/errores.ts";
import { type LectorSql, validarUrlDeLectura } from "@/db/queries/lector.ts";
import {
  type FilaDeFicha,
  type FilaDeOferta,
  type FilaDeTitulo,
  detalleDeCambio,
  ficha,
  imagenesPublicables,
  instante,
  movimiento,
  oferta,
  tituloResumen,
} from "@/db/queries/mapeo.ts";
import { crearRepositorioNeon } from "@/db/queries/repositorio-neon.ts";
import { describirOferta } from "@/features/catalogo/formato.ts";
import { crearRepositorio, fuenteDelCatalogo } from "@/features/catalogo/proveedor.ts";
import { imdbDeSlug, imdbEnrutable, slugDeTitulo, textoDeSlug } from "@/lib/slug.ts";

const dialecto = new PgDialect();
const compilar = (s: SQL) => dialecto.sqlToQuery(s);

// ── Slugs ──────────────────────────────────────────────────────────────────

describe("slugs derivados", () => {
  it("texto sin tildes ni signos, más el imdb", () => {
    expect(slugDeTitulo("¡Pisándonos los tacones!", "tt2967224")).toBe(
      "pisandonos-los-tacones-tt2967224",
    );
    expect(
      slugDeTitulo("El señor de los anillos: El retorno del rey", "tt0167260"),
    ).toBe("el-senor-de-los-anillos-el-retorno-del-rey-tt0167260");
  });

  it("es determinista y reproducible", () => {
    expect(slugDeTitulo("Norte Magnético", "tt1")).toBe(
      slugDeTitulo("Norte Magnético", "tt1"),
    );
  });

  it("un título sin letras latinas se queda en el imdb", () => {
    expect(slugDeTitulo("東京物語", "tt0046438")).toBe("tt0046438");
  });

  it("corta los títulos largos en un guion", () => {
    const texto = textoDeSlug("palabra ".repeat(30));
    expect(texto.length).toBeLessThanOrEqual(80);
    expect(texto.endsWith("-")).toBe(false);
    expect(texto.endsWith("palabra")).toBe(true);
  });

  it("solo los imdb con forma tt + dígitos son enrutables", () => {
    expect(imdbEnrutable("tt0111161")).toBe(true);
    expect(imdbEnrutable("nm0000001")).toBe(false);
    expect(imdbEnrutable("")).toBe(false);
    expect(slugDeTitulo("Título", "abc")).toBeNull();
  });

  it("la ficha se resuelve por el sufijo: un cambio de texto no rompe la URL", () => {
    expect(imdbDeSlug("la-casa-del-faro-tt1234567")).toBe("tt1234567");
    expect(imdbDeSlug("otro-titulo-tt1234567")).toBe("tt1234567");
    expect(imdbDeSlug("tt1234567")).toBe("tt1234567");
    expect(imdbDeSlug("la-casa-del-faro")).toBeNull();
    expect(imdbDeSlug("xtt1234567")).toBeNull();
    expect(imdbDeSlug("a".repeat(200) + "-tt1")).toBeNull();
  });

  it("dos títulos homónimos no colisionan", () => {
    expect(slugDeTitulo("Cumbre", "tt1")).not.toBe(slugDeTitulo("Cumbre", "tt2"));
  });
});

// ── Mapeo ──────────────────────────────────────────────────────────────────

const pelicula: FilaDeTitulo = {
  imdb_id: "tt0000001",
  type: "movie",
  title: "La casa del faro",
  year: 2021,
  season_count: null,
  generos: ["Drama"],
  disponibilidad: [
    {
      plataforma: "netflix",
      tipo: "subscription",
      centimos: null,
    },
    {
      plataforma: "apple",
      tipo: "rent",
      centimos: 399,
    },
  ],
  ultima_salida: null,
};

describe("mapeo fila → modelo", () => {
  it("película: identidad por imdb, slug derivado, sin imágenes", () => {
    const t = tituloResumen(pelicula);
    expect(t).toMatchObject({
      id: "tt0000001",
      slug: "la-casa-del-faro-tt0000001",
      tipo: "pelicula",
      anio: 2021,
      generos: ["Drama"],
      imagenes: {},
    });
    expect(t.disponibilidad).toEqual([
      {
        plataforma: { id: "netflix", nombre: "Netflix", slug: "netflix" },
        tipo: "subscription",
      },
      {
        plataforma: { id: "apple", nombre: "Apple TV", slug: "apple-tv" },
        tipo: "rent",
        precioDesde: { centimos: 399, moneda: "EUR" },
      },
    ]);
    expect("temporadas" in t).toBe(false);
    expect("anioFin" in t).toBe(false);
  });

  it("serie: temporadas solo en series y nunca `anioFin` (la base no sabe si terminó)", () => {
    const t = tituloResumen({ ...pelicula, type: "series", season_count: "3" });
    expect(t.tipo).toBe("serie");
    expect(t.temporadas).toBe(3);
    expect("anioFin" in t).toBe(false);
    expect("temporadas" in tituloResumen({ ...pelicula, season_count: 3 })).toBe(false);
  });

  it("géneros nulos son lista vacía; disponibilidad en texto JSON también se lee", () => {
    const t = tituloResumen({
      ...pelicula,
      generos: null,
      disponibilidad: JSON.stringify(pelicula.disponibilidad),
    });
    expect(t.generos).toEqual([]);
    expect(t.disponibilidad).toHaveLength(2);
  });

  it("`fueraDesde` solo sin disponibilidad y con una salida registrada", () => {
    expect(
      tituloResumen({
        ...pelicula,
        disponibilidad: null,
        ultima_salida: "2026-09-20T10:00:00Z",
      }).fueraDesde,
    ).toBe("2026-09-20T10:00:00.000Z");
    expect("fueraDesde" in tituloResumen({ ...pelicula, disponibilidad: null })).toBe(
      false,
    );
    expect(
      "fueraDesde" in
        tituloResumen({ ...pelicula, ultima_salida: "2026-09-20T10:00:00Z" }),
    ).toBe(false);
  });

  it("sin año o sin imdb enrutable, falla: el SQL debía haberlo filtrado", () => {
    expect(() => tituloResumen({ ...pelicula, year: null })).toThrow(ErrorDeCatalogo);
    expect(() => tituloResumen({ ...pelicula, imdb_id: "x" })).toThrow(ErrorDeCatalogo);
    expect(() => tituloResumen({ ...pelicula, type: "short" })).toThrow(
      ErrorDeCatalogo,
    );
  });

  it("un precio a cero o nulo no es un precio", () => {
    const t = tituloResumen({
      ...pelicula,
      disponibilidad: [{ plataforma: "apple", tipo: "buy", centimos: 0 }],
    });
    expect(t.disponibilidad[0]).not.toHaveProperty("precioDesde");
  });

  const filaDeOferta: FilaDeOferta = {
    platform_id: "prime",
    offer_type: "addon",
    addon: "canalpanico",
    enlace: "https://example.com/ver",
    centimos: null,
    calidad: 3,
    audio: [],
    subtitulos: [],
    salida: "2026-10-05T00:00:00Z",
  };

  it("oferta: addon sin nombre (ADR 0005), calidad, salida e idiomas ausentes", () => {
    const o = oferta(filaDeOferta);
    expect(o).toEqual({
      plataforma: { id: "prime", nombre: "Prime Video", slug: "prime-video" },
      tipo: "addon",
      addon: { id: "canalpanico" },
      calidad: "uhd",
      disponibleHasta: "2026-10-05T00:00:00.000Z",
      enlace: "https://example.com/ver",
    });
    // La interfaz dice «Canal adicional» sin inventar un nombre.
    expect(describirOferta(o!)).toBe("Canal adicional");
  });

  it("oferta: idiomas si consta alguno, sin enlace no hay oferta", () => {
    expect(
      oferta({ ...filaDeOferta, audio: ["spa"], subtitulos: null })?.idiomas,
    ).toEqual({
      audio: ["spa"],
      subtitulos: [],
    });
    expect(oferta({ ...filaDeOferta, enlace: null })).toBeNull();
    expect(oferta({ ...filaDeOferta, calidad: null })).not.toHaveProperty("calidad");
    expect(oferta({ ...filaDeOferta, salida: null })).not.toHaveProperty(
      "disponibleHasta",
    );
  });

  const filaDeFicha: FilaDeFicha = {
    ...pelicula,
    original_title: "La casa del faro",
    overview: "",
    rating: null,
    runtime_minutes: 128,
    episode_count: 10,
    directors: ["Ana Ruiz", ""],
    cast_members: null,
    comprobado_en: "2026-09-28T04:10:00Z",
  };

  it("ficha: sin sinopsis, sin valoración, original igual al español → ausentes", () => {
    const f = ficha(filaDeFicha, {
      ofertas: [],
      anuncios: [],
      movimientos: [],
      comprobadoEn: "2026-09-28T04:10:00.000Z",
    });
    expect(f).not.toHaveProperty("sinopsis");
    expect(f).not.toHaveProperty("valoracion");
    expect(f).not.toHaveProperty("tituloOriginal");
    expect(f).not.toHaveProperty("episodios");
    expect(f.duracionMinutos).toBe(128);
    expect(f.direccion).toEqual(["Ana Ruiz"]);
    expect(f.reparto).toEqual([]);
    expect(f.comprobadoEn).toBe("2026-09-28T04:10:00.000Z");
  });

  it("ficha: valoración con su fuente, original distinto, episodios solo en series", () => {
    const f = ficha(
      {
        ...filaDeFicha,
        type: "series",
        rating: "87",
        original_title: "Lighthouse",
        overview: "Una sinopsis.",
      },
      {
        ofertas: [],
        anuncios: [],
        movimientos: [],
        comprobadoEn: "2026-09-28T04:10:00.000Z",
      },
    );
    expect(f.valoracion).toEqual({ valor: 87, fuente: "Streaming Availability" });
    expect(f.tituloOriginal).toBe("Lighthouse");
    expect(f.sinopsis).toBe("Una sinopsis.");
    expect(f.episodios).toBe(10);
    expect(f).not.toHaveProperty("duracionMinutos");
  });

  it("movimiento de cambio con detalle presentable", () => {
    const fila = {
      imdb_id: "tt1",
      platform_id: "max",
      fecha: new Date("2026-09-27T06:00:00Z"),
      campos: ["price"],
    };
    expect(movimiento("cambio", fila)).toEqual({
      tipo: "cambio",
      tituloId: "tt1",
      plataforma: { id: "max", nombre: "HBO Max", slug: "hbo-max" },
      fecha: "2026-09-27T06:00:00.000Z",
      detalle: "Cambio de precio",
    });
    expect(movimiento("llega", fila)).not.toHaveProperty("detalle");
  });

  it("detalle: solo campos presentables; la mecánica de la ingesta no se cuenta", () => {
    expect(detalleDeCambio(["options", "state"])).toBeUndefined();
    expect(detalleDeCambio(["quality", "options"])).toBe("Cambio de calidad");
    expect(detalleDeCambio(["price", "quality"])).toBe("Cambios en la oferta");
  });

  it("instantes: Date o texto a ISO; ilegible, error", () => {
    expect(instante("2026-09-28T04:10:00+02:00")).toBe("2026-09-28T02:10:00.000Z");
    expect(() => instante("no es fecha")).toThrow(ErrorDeCatalogo);
  });

  it("ninguna imagen es publicable hoy (ADR 0008)", () => {
    expect(imagenesPublicables()).toEqual({});
  });
});

// ── Repositorio sobre un lector doble ──────────────────────────────────────

type Respuestas = Record<string, unknown[] | ((s: SQL) => unknown[])>;

function lectorDoble(respuestas: Respuestas) {
  const llamadas: { operacion: string; sql: string; params: unknown[] }[] = [];
  const lector: LectorSql = {
    leer<T>(operacion: string, consulta: SQL): Promise<T[]> {
      const { sql, params } = compilar(consulta);
      llamadas.push({ operacion, sql, params });
      const r = respuestas[operacion];
      if (r === undefined)
        return Promise.reject(new Error(`sin respuesta para ${operacion}`));
      return Promise.resolve((typeof r === "function" ? r(consulta) : r) as T[]);
    },
  };
  return { lector, llamadas };
}

const tarjeta = (imdb: string, title: string, extra: Partial<FilaDeTitulo> = {}) => ({
  ...pelicula,
  imdb_id: imdb,
  title,
  ...extra,
});

describe("repositorio de Neon", () => {
  it("titulos: una sola consulta, en el orden pedido, sin repetir ids", async () => {
    const { lector, llamadas } = lectorDoble({
      titulos: [tarjeta("tt2", "Beta"), tarjeta("tt1", "Alfa")],
    });
    const repo = crearRepositorioNeon(lector);
    const t = await repo.titulos(["tt1", "tt2", "tt1", "tt9"]);
    expect(t.map((x) => x.id)).toEqual(["tt1", "tt2"]);
    expect(llamadas).toHaveLength(1);
    expect(
      llamadas[0]!.params.filter((p) => typeof p === "string" && p.startsWith("tt")),
    ).toEqual(["tt1", "tt2", "tt9"]);
    expect(await repo.titulos([])).toEqual([]);
    expect(llamadas).toHaveLength(1);
  });

  it("ficha: un slug sin imdb no consulta nada", async () => {
    const { lector, llamadas } = lectorDoble({});
    expect(
      await crearRepositorioNeon(lector).ficha("pelicula", "sin-sufijo"),
    ).toBeNull();
    expect(llamadas).toHaveLength(0);
  });

  it("ficha: ofertas, anuncios y movimientos en una sola ronda paralela", async () => {
    const { lector, llamadas } = lectorDoble({
      ficha: [
        {
          ...tarjeta("tt1", "Alfa"),
          original_title: null,
          overview: null,
          rating: 70,
          runtime_minutes: null,
          episode_count: null,
          directors: [],
          cast_members: [],
          comprobado_en: "2026-09-28T04:10:00Z",
        },
      ],
      "ficha:ofertas": [
        {
          platform_id: "netflix",
          offer_type: "subscription",
          addon: null,
          enlace: "https://example.com/1",
          centimos: null,
          calidad: 2,
          audio: ["spa"],
          subtitulos: ["spa"],
          salida: "2026-10-10T00:00:00Z",
        },
      ],
      "ficha:anuncios": [
        {
          platform_id: "max",
          offer_type: "subscription",
          announced_for: "2026-10-02T07:00:00Z",
        },
      ],
      "ficha:historico": [
        {
          imdb_id: "tt1",
          platform_id: "netflix",
          event_type: "added",
          fecha: "2026-09-25T06:00:00Z",
          campos: null,
        },
        {
          imdb_id: "tt1",
          platform_id: "netflix",
          event_type: "announced",
          fecha: "2026-09-20T06:00:00Z",
          campos: null,
        },
      ],
    });
    const f = await crearRepositorioNeon(lector).ficha(
      "pelicula",
      "cualquier-texto-tt1",
    );
    expect(llamadas.map((l) => l.operacion).sort()).toEqual([
      "ficha",
      "ficha:anuncios",
      "ficha:historico",
      "ficha:ofertas",
    ]);
    expect(f?.slug).toBe("alfa-tt1");
    expect(f?.comprobadoEn).toBe("2026-09-28T04:10:00.000Z");
    expect(f?.anuncios).toEqual([
      {
        plataforma: { id: "max", nombre: "HBO Max", slug: "hbo-max" },
        tipo: "subscription",
        fecha: "2026-10-02T07:00:00.000Z",
      },
    ]);
    // `announced` no es un movimiento de la web: «Próximamente» sale de los anuncios.
    expect(f?.movimientos.map((m) => m.tipo)).toEqual([
      "se-va",
      "proximamente",
      "llega",
    ]);
  });

  it("ficha sin ofertas observadas: la comprobación del catálogo, nunca la hora actual", async () => {
    const { lector } = lectorDoble({
      ficha: [
        {
          ...tarjeta("tt1", "Alfa"),
          original_title: null,
          overview: null,
          rating: null,
          runtime_minutes: null,
          episode_count: null,
          directors: null,
          cast_members: null,
          comprobado_en: null,
        },
      ],
      "ficha:ofertas": [],
      "ficha:anuncios": [],
      "ficha:historico": [],
      ultimaComprobacion: [{ comprobado: "2026-09-27T12:00:00Z" }],
    });
    const f = await crearRepositorioNeon(lector).ficha("pelicula", "alfa-tt1");
    expect(f?.comprobadoEn).toBe("2026-09-27T12:00:00.000Z");
  });

  it("buscar: título original solo si no coincide el español, desempate es-ES", async () => {
    const { lector, llamadas } = lectorDoble({
      buscar: [
        {
          imdb_id: "tt2",
          title: "Zeta",
          original_title: "Norte",
          en_titulo: false,
          puntos: 1,
          total: "3",
        },
        {
          imdb_id: "tt1",
          title: "Ámbar norte",
          original_title: null,
          en_titulo: true,
          puntos: "1",
          total: "3",
        },
      ],
      titulos: [tarjeta("tt1", "Ámbar norte"), tarjeta("tt2", "Zeta")],
    });
    const r = await crearRepositorioNeon(lector).buscar("NORTE", 50);
    expect(r.total).toBe(3);
    expect(r.resultados.map((x) => x.titulo.id)).toEqual(["tt1", "tt2"]);
    expect(r.resultados[0]).not.toHaveProperty("tituloOriginal");
    expect(r.resultados[1]!.tituloOriginal).toBe("Norte");
    // La consulta viaja normalizada y como parámetro, nunca en el texto.
    expect(llamadas[0]!.params).toContain("norte");
    expect(llamadas[0]!.sql).not.toContain("NORTE");
  });

  it("buscar: sin palabras, sin consulta", async () => {
    const { lector, llamadas } = lectorDoble({});
    expect(await crearRepositorioNeon(lector).buscar("  ", 50)).toEqual({
      resultados: [],
      total: 0,
    });
    expect(llamadas).toHaveLength(0);
  });

  it("mejorValoradas: desempate por título es-ES e imdb, posiciones consecutivas", async () => {
    const { lector } = lectorDoble({
      mejorValoradas: [
        { imdb_id: "tt3", title: "Zeta", rating: 90 },
        { imdb_id: "tt2", title: "Beta", rating: 80 },
        { imdb_id: "tt1", title: "Álamo", rating: 80 },
        { imdb_id: "tt4", title: "Ceta", rating: 80 },
      ],
      titulos: [
        tarjeta("tt3", "Zeta"),
        tarjeta("tt2", "Beta"),
        tarjeta("tt1", "Álamo"),
      ],
    });
    const r = await crearRepositorioNeon(lector).mejorValoradas("pelicula", 3);
    expect(r.map((p) => [p.posicion, p.titulo.id, p.valoracion.valor])).toEqual([
      [1, "tt3", 90],
      [2, "tt1", 80],
      [3, "tt2", 80],
    ]);
  });

  it("explorar con límite 0 solo cuenta", async () => {
    const { lector, llamadas } = lectorDoble({ explorar: [{ total: "59" }] });
    expect(await crearRepositorioNeon(lector).explorar({ tipo: "serie" }, 0)).toEqual({
      titulos: [],
      total: 59,
    });
    expect(llamadas[0]!.sql).toMatch(/^\s*SELECT count\(\*\)/);
  });

  it("capacidades: solo valores conocidos; lo ausente queda ausente (unknown)", async () => {
    const { lector } = lectorDoble({
      capacidades: [
        {
          platform_id: "netflix",
          capability: "expiring",
          status: "supported_with_data",
        },
        {
          platform_id: "netflix",
          capability: "inventada",
          status: "supported_with_data",
        },
        { platform_id: "max", capability: "upcoming", status: "raro" },
      ],
    });
    expect(await crearRepositorioNeon(lector).capacidades()).toEqual({
      netflix: { expiring: "supported_with_data" },
    });
  });

  it("recuentoPorPlataforma: todas las activas, también con cero", async () => {
    const { lector } = lectorDoble({
      recuentoPorPlataforma: (s) =>
        compilar(s).sql.includes("count(DISTINCT")
          ? [{ platform_id: "netflix", type: "series", recuento: "4" }]
          : [
              {
                platform_id: "netflix",
              },
              { platform_id: "max" },
            ],
    });
    expect(await crearRepositorioNeon(lector).recuentoPorPlataforma()).toEqual({
      netflix: { pelicula: 0, serie: 4 },
      max: { pelicula: 0, serie: 0 },
    });
  });

  it("sin ninguna observación no hay «Comprobado el…»: error, no una fecha inventada", async () => {
    const { lector } = lectorDoble({ ultimaComprobacion: [{ comprobado: null }] });
    await expect(
      crearRepositorioNeon(lector).ultimaComprobacion(),
    ).rejects.toMatchObject({
      motivo: "sin_datos",
    });
  });

  it("inicioDelRegistro: ancla del seed, si no el primer evento", async () => {
    const conAncla = lectorDoble({
      inicioDelRegistro: [
        { ancla: "2026-10-01T03:00:00Z", primer_evento: "2026-09-23T00:00:00Z" },
      ],
    });
    expect(await crearRepositorioNeon(conAncla.lector).inicioDelRegistro()).toBe(
      "2026-10-01T03:00:00.000Z",
    );
    const sinAncla = lectorDoble({
      inicioDelRegistro: [{ ancla: null, primer_evento: "2026-09-23T00:00:00Z" }],
    });
    expect(await crearRepositorioNeon(sinAncla.lector).inicioDelRegistro()).toBe(
      "2026-09-23T00:00:00.000Z",
    );
  });

  it("editorial: ninguna lista, ninguna destacada (no vive en Neon)", async () => {
    const { lector, llamadas } = lectorDoble({});
    const repo = crearRepositorioNeon(lector);
    expect(await repo.listas()).toEqual([]);
    expect(await repo.listaDestacada()).toBeNull();
    expect(await repo.lista("cualquiera")).toBeNull();
    expect(llamadas).toHaveLength(0);
  });

  it("movimientos: límite 0 no consulta; límite inválido es un error", async () => {
    const { lector, llamadas } = lectorDoble({});
    const repo = crearRepositorioNeon(lector);
    expect(await repo.movimientos("llega", 0)).toEqual([]);
    expect(llamadas).toHaveLength(0);
    await expect(repo.movimientos("llega", -1)).rejects.toBeInstanceOf(ErrorDeCatalogo);
  });

  it("un fallo de la base se propaga: nunca se cae a datos de desarrollo", async () => {
    const lector: LectorSql = {
      leer: () =>
        Promise.reject(new ErrorDeCatalogo("consulta", "plataformas", "timeout")),
    };
    await expect(crearRepositorioNeon(lector).plataformas()).rejects.toBeInstanceOf(
      ErrorDeCatalogo,
    );
  });
});

// ── El SQL que se emite ────────────────────────────────────────────────────

describe("SQL del adaptador", () => {
  const todas: [string, SQL][] = [
    ["plataformas", q.plataformas()],
    ["capacidades", q.capacidades()],
    ["tarjetas", q.tarjetas(["tt1", "tt2"])],
    ["fichaBase", q.fichaBase("pelicula", "tt1")],
    ["ofertasDeFicha", q.ofertasDeFicha("pelicula", "tt1")],
    ["anunciosDeFicha", q.anunciosDeFicha("serie", "tt1")],
    ["slugs", q.slugs("serie")],
    ["delMismoDirector", q.delMismoDirector("tt1", 4)],
    [
      "explorar",
      q.explorar({ tipo: "pelicula", plataforma: "netflix", genero: "Drama" }, 24),
    ],
    ["generos", q.generos({ tipo: "serie" })],
    ["recuentoPorPlataforma", q.recuentoPorPlataforma()],
    ["mejorValoradas", q.candidatasMejorValoradas("pelicula", 5, "max")],
    [
      "llega",
      q.movimientosDelHistorico("added", 50, { desde: "2026-09-01T00:00:00Z" }),
    ],
    ["se-fue", q.movimientosDelHistorico("removed", 50, {})],
    ["cambio", q.movimientosDelHistorico("changed", 50, { obra: "serie" })],
    ["se-va", q.movimientosSeVa(50, { plataforma: "netflix" })],
    ["proximamente", q.movimientosProximamente(50, {})],
    ["historicoDeTitulo", q.historicoDeTitulo("pelicula", "tt1")],
    ["buscar", q.buscar("norte", ["norte"], 50)],
  ];

  it.each(todas)("%s: solo lectura, acotada y sin SELECT *", (_, consulta) => {
    const { sql } = compilar(consulta);
    expect(sql).toMatch(/^\s*(SELECT|WITH)\b/);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/i);
    expect(sql).not.toMatch(/SELECT\s+\*/i);
    expect(sql).toMatch(/\bLIMIT\b/);
  });

  it("los valores viajan como parámetros, nunca en el texto", () => {
    const hostil = "x'; DROP TABLE external_titles; --";
    for (const consulta of [
      q.fichaBase("pelicula", hostil),
      q.explorar({ genero: hostil, plataforma: hostil }, 5),
      q.buscar(hostil, [hostil], 5),
    ]) {
      const { sql, params } = compilar(consulta);
      expect(sql).not.toContain("DROP TABLE");
      expect(
        params.some((p) => typeof p === "string" && p.includes("DROP TABLE")),
      ).toBe(true);
    }
  });

  it("buscar escapa los comodines de LIKE", () => {
    expect(q.escaparLike("100%_\\")).toBe("100\\%\\_\\\\");
    const { params } = compilar(q.buscar("100%", ["100%"], 5));
    expect(params).toContain("%100\\%%");
  });

  it("buscar: la tabla de tildes está alineada letra a letra", () => {
    const { params } = compilar(q.buscar("a", ["a"], 5));
    const [con, sin] = params.filter(
      (p) => typeof p === "string" && p.length > 40,
    ) as string[];
    expect([...con!].length).toBe([...sin!].length);
  });

  it("se va exige expiring en ✅ y la salida futura a ≤ 30 días", () => {
    const { sql, params } = compilar(q.movimientosSeVa(50, {}));
    expect(params).toContain("expiring");
    expect(sql).toContain("supported_with_data");
    expect(sql).toContain("o.expires_at > now()");
    expect(sql).toContain("interval '30 days'");
  });

  it("próximamente: anuncios vigentes (recorrido de referencia de upcoming) y upcoming en ✅", () => {
    const { sql, params } = compilar(q.movimientosProximamente(50, {}));
    expect(sql).toContain("external_availability_announcements");
    expect(sql).toContain("last_seen_run_id >=");
    expect(sql).toContain("r.pipeline = 'upcoming'");
    expect(params).toContain("upcoming");
  });

  it("llega, se fue y cambio salen del histórico, no del estado", () => {
    for (const evento of ["added", "removed", "changed"] as const) {
      const { sql, params } = compilar(q.movimientosDelHistorico(evento, 10, {}));
      expect(sql).toContain("FROM external_availability_events e");
      expect(params).toContain(evento);
    }
  });

  it("solo opciones activas (missing_streak < 2) y títulos publicables", () => {
    const { sql } = compilar(q.explorar({}, 5));
    expect(sql).toContain("o.missing_streak < 2");
    expect(sql).toContain("t.year IS NOT NULL");
    expect(sql).toContain('COLLATE "es-x-icu"');
  });

  it("ninguna consulta lee las URLs de imagen (ADR 0008)", () => {
    for (const [, consulta] of todas)
      expect(compilar(consulta).sql).not.toContain("observed_url");
  });
});

// ── Selección de fuente y errores ──────────────────────────────────────────

describe("selección de fuente (fail closed)", () => {
  it("ausente o `desarrollo` → desarrollo; `neon` → neon", () => {
    expect(fuenteDelCatalogo({}, false)).toBe("desarrollo");
    expect(fuenteDelCatalogo({ CATALOGO_FUENTE: "desarrollo" }, false)).toBe(
      "desarrollo",
    );
    expect(fuenteDelCatalogo({ CATALOGO_FUENTE: "neon" }, false)).toBe("neon");
  });

  it("un valor desconocido se niega", () => {
    expect(() => fuenteDelCatalogo({ CATALOGO_FUENTE: "fixtures" }, false)).toThrow(
      ErrorDeCatalogo,
    );
  });

  it("indexable con datos de desarrollo se niega", () => {
    expect(() => fuenteDelCatalogo({}, true)).toThrow(/indexable/);
    expect(fuenteDelCatalogo({ CATALOGO_FUENTE: "neon" }, true)).toBe("neon");
  });

  it("neon sin DATABASE_URL, con una URL rara o con credenciales de jobs, se niega", () => {
    expect(() => crearRepositorio({ CATALOGO_FUENTE: "neon" })).toThrow(/DATABASE_URL/);
    expect(() =>
      crearRepositorio({
        CATALOGO_FUENTE: "neon",
        DATABASE_URL: "https://example.com",
      }),
    ).toThrow(/PostgreSQL/);
    const secreto = "postgresql://usuario:clave-secreta@ep-x.neon.tech/db";
    let mensaje = "";
    try {
      crearRepositorio({
        CATALOGO_FUENTE: "neon",
        DATABASE_URL: secreto,
        STREAMING_AVAILABILITY_API_KEY: "k",
      });
    } catch (e) {
      mensaje = (e as Error).message;
    }
    expect(mensaje).toContain("STREAMING_AVAILABILITY_API_KEY");
    expect(mensaje).not.toContain("clave-secreta");
  });

  it("neon con una URL válida crea el repositorio sin conectar", () => {
    const repo = crearRepositorio({
      CATALOGO_FUENTE: "neon",
      DATABASE_URL: "postgresql://lector:x@ep-x.neon.tech/db",
    });
    expect(typeof repo.ficha).toBe("function");
  });

  it("validarUrlDeLectura no repite la URL en sus errores", () => {
    expect(() => validarUrlDeLectura("mysql://a:b@c/d")).toThrow(ErrorDeCatalogo);
    try {
      validarUrlDeLectura("mysql://a:secreta@c/d");
    } catch (e) {
      expect((e as Error).message).not.toContain("secreta");
    }
  });

  it("sanear quita cadenas de conexión, usuario:clave@ y tokens", () => {
    const texto = sanear(
      "fallo en postgresql://u:p@host/db y en u2:p2@host2 password=abc token=" +
        "a".repeat(40),
    );
    expect(texto).not.toMatch(/u:p@|p2@|abc|a{40}/);
    expect(
      new ErrorDeCatalogo("consulta", "x", "postgres://u:p@h/d").message,
    ).not.toContain("u:p@");
  });
});

describe("calidad de una oferta con variantes", () => {
  it("con precio y varias calidades no se afirma ninguna", () => {
    const { sql } = compilar(q.ofertasDeFicha("pelicula", "tt1"));
    expect(sql).toContain(
      "count(DISTINCT o.quality) > 1 AND count(o.price_amount) > 0",
    );
  });
});

describe("ficha: una salida por plataforma", () => {
  it("alquiler y compra que caducan en la misma plataforma son un solo «se va», el más próximo", async () => {
    const oferta = (tipo: string, salida: string) => ({
      platform_id: "apple",
      offer_type: tipo,
      addon: null,
      enlace: `https://example.com/${tipo}`,
      centimos: 399,
      calidad: null,
      audio: null,
      subtitulos: null,
      salida,
    });
    const { lector } = lectorDoble({
      ficha: [
        {
          ...tarjeta("tt1", "Alfa"),
          original_title: null,
          overview: null,
          rating: null,
          runtime_minutes: null,
          episode_count: null,
          directors: null,
          cast_members: null,
          comprobado_en: "2026-09-28T04:10:00Z",
        },
      ],
      "ficha:ofertas": [
        oferta("rent", "2026-10-10T00:00:00Z"),
        oferta("buy", "2026-10-05T00:00:00Z"),
      ],
      "ficha:anuncios": [],
      "ficha:historico": [],
    });
    const f = await crearRepositorioNeon(lector).ficha("pelicula", "alfa-tt1");
    expect(f?.ofertas).toHaveLength(2);
    expect(f?.movimientos).toEqual([
      {
        tipo: "se-va",
        tituloId: "tt1",
        plataforma: { id: "apple", nombre: "Apple TV", slug: "apple-tv" },
        fecha: "2026-10-05T00:00:00.000Z",
      },
    ]);
  });
});
