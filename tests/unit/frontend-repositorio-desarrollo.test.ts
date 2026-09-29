import { describe, expect, it } from "vitest";
import { crearRepositorioDeDesarrollo } from "../../src/features/catalogo/desarrollo/repositorio-de-desarrollo.ts";
import {
  CAPACIDADES,
  FICHAS,
  LISTAS,
  MOVIMIENTOS,
} from "../../src/features/catalogo/desarrollo/datos.ts";

/**
 * El adaptador de desarrollo cumple el contrato del puerto de catálogo con las
 * mismas reglas que tendrá el de Neon: capacidades, orden y desempate.
 */
describe("repositorio de desarrollo", () => {
  const repo = crearRepositorioDeDesarrollo();

  it("encuentra una ficha solo con su tipo y su slug", async () => {
    expect((await repo.ficha("pelicula", "la-casa-del-faro"))?.titulo).toBe(
      "La casa del faro",
    );
    expect(await repo.ficha("serie", "la-casa-del-faro")).toBeNull();
    expect(await repo.ficha("pelicula", "no-existe")).toBeNull();
  });

  it("deriva la disponibilidad resumida y la fecha de comprobación de cada ficha", async () => {
    const ficha = await repo.ficha("pelicula", "frontera-norte");
    expect(ficha?.disponibilidad.map((o) => `${o.plataforma.id}:${o.tipo}`)).toEqual([
      "prime:rent",
      "prime:buy",
      "apple:rent",
      "apple:buy",
    ]);
    expect(ficha?.comprobadoEn).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("no inventa datos: sin sinopsis, sin valoración o sin imagen quedan ausentes", async () => {
    const distrito = await repo.ficha("serie", "distrito-once");
    expect(distrito?.sinopsis).toBeUndefined();
    const ruido = await repo.ficha("pelicula", "ruido-blanco-en-la-sierra");
    expect(ruido?.valoracion).toBeUndefined();
    expect(ruido?.imagenes).toEqual({});
  });

  it("solo publica salidas y llegadas anunciadas de plataformas con la capacidad en ✅", async () => {
    const soloPermitidas = crearRepositorioDeDesarrollo({
      fichas: FICHAS,
      listas: LISTAS,
      capacidades: CAPACIDADES,
      movimientos: [
        ...MOVIMIENTOS,
        // Disney+ tiene `expiring` en ⚪: su salida no puede publicarse.
        {
          tipo: "se-va",
          tituloId: "t-luz",
          plataforma: { id: "disney", nombre: "Disney+", slug: "disney-plus" },
          fecha: "2026-10-01T00:00:00Z",
        },
        // SkyShowtime tiene `upcoming` en ❌.
        {
          tipo: "proximamente",
          tituloId: "t-distrito",
          plataforma: { id: "skyshowtime", nombre: "SkyShowtime", slug: "skyshowtime" },
          fecha: "2026-10-02T00:00:00Z",
        },
      ],
    });
    const seVa = await soloPermitidas.movimientos("se-va", 50);
    expect(seVa.some((m) => m.plataforma.id === "disney")).toBe(false);
    const proximamente = await soloPermitidas.movimientos("proximamente", 50);
    expect(proximamente.some((m) => m.plataforma.id === "skyshowtime")).toBe(false);
  });

  it("ordena los movimientos pasados del más reciente y los futuros del más próximo", async () => {
    const llega = await repo.movimientos("llega", 50);
    const fechas = llega.map((m) => m.fecha);
    expect(fechas).toEqual([...fechas].sort().reverse());
    const seVa = await repo.movimientos("se-va", 50);
    expect(seVa.map((m) => m.fecha)).toEqual(seVa.map((m) => m.fecha).sort());
  });

  it("Ranking A: con valoración y disponible, desempate por título en es-ES", async () => {
    const peliculas = await repo.mejorValoradas("pelicula", 10);
    const titulos = peliculas.map((p) => p.titulo.titulo);
    // Sin valoración (Ruido blanco) y sin disponibilidad (El último tren) no entran.
    expect(titulos).not.toContain("Ruido blanco en la sierra");
    expect(titulos).not.toContain("El último tren a Soria");
    // Empate a 78: «Frontera norte» antes que «La vida en préstamo».
    expect(titulos.indexOf("Frontera norte")).toBeLessThan(
      titulos.indexOf("La vida en préstamo"),
    );
    expect(peliculas.map((p) => p.posicion)).toEqual(peliculas.map((_, i) => i + 1));
    const valores = peliculas.map((p) => p.valoracion.valor);
    expect(valores).toEqual([...valores].sort((a, b) => b - a));
  });

  it("relaciona por dirección sin incluir el propio título", async () => {
    const relacionados = await repo.delMismoDirector("t-faro", 4);
    expect(relacionados.map((t) => t.id)).toEqual(["t-frontera"]);
  });

  it("devuelve las listas de la revisada más reciente a la más antigua", async () => {
    const listas = await repo.listas();
    const revisadas = listas.map((l) => l.revisada);
    expect(revisadas).toEqual([...revisadas].sort().reverse());
    expect((await repo.listaDestacada())?.id).toBe("l-fin-de-semana");
  });

  it("no publica ninguna URL de imagen del proveedor (ADR 0008)", () => {
    const urls = FICHAS.flatMap((f) => [
      f.imagenes.poster?.url,
      f.imagenes.fondo?.url,
    ]).filter(Boolean);
    for (const url of urls) expect(url).toMatch(/^\/desarrollo\//);
  });
});

describe("repositorio de desarrollo: operaciones de las pantallas del MVP", () => {
  const repo = crearRepositorioDeDesarrollo();

  it("filtra movimientos por plataforma, obra y ventana (instantes inclusivos)", async () => {
    const netflix = await repo.movimientos("llega", 50, { plataforma: "netflix" });
    expect(netflix.every((m) => m.plataforma.id === "netflix")).toBe(true);
    const series = await repo.movimientos("llega", 50, { obra: "serie" });
    const fichas = new Map(FICHAS.map((f) => [f.id, f.tipo]));
    expect(series.every((m) => fichas.get(m.tituloId) === "serie")).toBe(true);
    const ventana = await repo.movimientos("llega", 50, {
      desde: "2026-09-24T07:00:00Z",
      hasta: "2026-09-26T07:00:00Z",
    });
    expect(ventana.map((m) => m.tituloId)).toEqual([
      "t-faro",
      "t-frontera",
      "t-cumbre",
    ]);
  });

  it("explorar: solo disponibles hoy, en orden alfabético, con el total", async () => {
    const { titulos, total } = await repo.explorar(
      { tipo: "pelicula", genero: "Drama" },
      2,
    );
    expect(titulos).toHaveLength(2);
    expect(total).toBeGreaterThan(2);
    const todos = (await repo.explorar({ tipo: "pelicula", genero: "Drama" }, 50))
      .titulos;
    expect(todos.every((t) => t.disponibilidad.length > 0)).toBe(true);
    // «La sombra del alcalde» es un drama que ya no está en ninguna plataforma.
    expect(todos.map((t) => t.id)).not.toContain("t-sombra");
  });

  it("géneros del catálogo disponible, del más al menos frecuente", async () => {
    const generos = await repo.generos({ tipo: "serie" });
    const n = generos.map((g) => g.recuento);
    expect(n).toEqual([...n].sort((a, b) => b - a));
    expect(generos.every((g) => g.recuento > 0)).toBe(true);
  });

  it("recuento por plataforma y tipo, contando cada título una vez por plataforma", async () => {
    const recuento = await repo.recuentoPorPlataforma();
    expect(Object.keys(recuento).sort()).toEqual(
      ["apple", "disney", "max", "netflix", "prime", "skyshowtime"].sort(),
    );
    // Frontera norte tiene alquiler y compra en Prime: cuenta una vez.
    const prime = FICHAS.filter(
      (f) =>
        f.tipo === "pelicula" && f.ofertas.some((o) => o.plataforma.id === "prime"),
    ).length;
    expect(recuento.prime?.pelicula).toBe(prime);
  });

  it("Ranking A por plataforma: numerado dentro de ese ranking", async () => {
    const ranking = await repo.mejorValoradas("serie", 10, { plataforma: "netflix" });
    expect(ranking.map((p) => p.posicion)).toEqual(ranking.map((_, i) => i + 1));
    expect(
      ranking.every((p) =>
        p.titulo.disponibilidad.some((o) => o.plataforma.id === "netflix"),
      ),
    ).toBe(true);
  });

  it("una lista por slug, y null si no existe", async () => {
    expect((await repo.lista("series-cortas-para-un-fin-de-semana"))?.id).toBe(
      "l-fin-de-semana",
    );
    expect(await repo.lista("no-existe")).toBeNull();
  });

  it("un título fuera de catálogo lleva su última salida; uno anunciado, no", async () => {
    const [sombra, eco] = await repo.titulos(["t-sombra", "t-eco"]);
    expect(sombra?.fueraDesde).toBe("2026-09-23T00:00:00Z");
    expect(eco?.fueraDesde).toBeUndefined();
  });
});
