/**
 * Contract tests de Streaming Availability.
 *
 * Recorren la cadena completa sobre **respuestas reales** capturadas en el
 * Spike 1, no sobre datos inventados:
 *
 *     fixture real → schema externo válido → normalización → contrato canónico
 *
 * Su función es detectar el día en que el proveedor cambie la forma de sus
 * respuestas. Si esto se pone rojo, no es el test: es la fuente.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { TituloCanonico } from "../../jobs/adapters/contracts.ts";
import {
  adaptadorStreamingAvailability,
  normalizarValoracion,
} from "../../jobs/adapters/streaming-availability/normalizar.ts";
import { respuestaBusquedaProveedor } from "../../jobs/adapters/streaming-availability/schema.ts";

const DIRECTORIO_FIXTURES = join(import.meta.dirname, "..", "fixtures");
const FIXTURES = readdirSync(DIRECTORIO_FIXTURES).filter((f) => f.endsWith(".json"));

/**
 * La respuesta **de la API**, desenvuelta del formato del grabador: el `body`
 * de estos ficheros es la respuesta HTTP entera, y el `meta` son los
 * metadatos que anadio `spike-1/probe.mjs`.
 */
function cargar(nombre: string): unknown {
  const guardado = JSON.parse(
    readFileSync(join(DIRECTORIO_FIXTURES, nombre), "utf8"),
  ) as { body: unknown };
  return guardado.body;
}

describe("fixtures", () => {
  it("hay fixtures que ejercitar", () => {
    expect(FIXTURES.length).toBeGreaterThan(0);
  });
});

describe.each(FIXTURES)("%s", (nombre) => {
  const crudo = cargar(nombre);

  it("valida contra el schema externo del proveedor", () => {
    const resultado = respuestaBusquedaProveedor.safeParse(crudo);
    // Si falla, se imprime el error concreto en vez de un booleano inútil.
    expect(resultado.success ? null : resultado.error.issues).toBeNull();
  });

  it("se normaliza al contrato canónico", () => {
    const titulos = adaptadorStreamingAvailability.normalizar(crudo, "es");
    expect(titulos.length).toBeGreaterThan(0);

    for (const t of titulos satisfies readonly TituloCanonico[]) {
      // imdbId al 100 %: es la clave de deduplicación (Spike 1, D2).
      expect(t.ids.imdbId).toMatch(/^tt\d+$/);
      expect(["pelicula", "serie"]).toContain(t.tipo);
      expect(t.titulo.length).toBeGreaterThan(0);

      // La valoración canónica es 1..100 o null. Nunca 0.
      expect(t.valoracion === null || t.valoracion > 0).toBe(true);

      // Las series no llevan duración y las películas no llevan temporadas.
      if (t.tipo === "pelicula") {
        expect(t.numeroTemporadas).toBeNull();
        expect(t.numeroEpisodios).toBeNull();
      } else {
        expect(t.duracionMinutos).toBeNull();
      }

      for (const d of t.disponibilidad) {
        expect(d.pais).toBe("es");
        expect(d.enlace.length).toBeGreaterThan(0);
        expect(["subscription", "rent", "buy", "free", "addon"]).toContain(
          d.tipoOferta,
        );
      }
    }
  });
});

describe("rating 0 significa «sin valoración», no un cero real", () => {
  it("la normalización lo convierte en null", () => {
    expect(normalizarValoracion(0)).toBeNull();
    expect(normalizarValoracion(undefined)).toBeNull();
    expect(normalizarValoracion(1)).toBe(1);
    expect(normalizarValoracion(67)).toBe(67);
  });

  it("sobre el caso real capturado en el Spike 1", () => {
    // Esta fixture contiene el título con rating 0 que destapó la trampa:
    // «Título ficticio», junto a dos títulos con valoración real.
    const crudo = cargar("max-series-rating-cero.json");
    const parseado = respuestaBusquedaProveedor.parse(crudo);

    // El schema externo lo conserva tal cual: describe lo que la fuente dice.
    const conCeroEnOrigen = parseado.shows.filter((s) => s.rating === 0);
    expect(conCeroEnOrigen.length).toBeGreaterThan(0);

    // El modelo canónico lo representa como ausencia.
    const titulos = adaptadorStreamingAvailability.normalizar(crudo, "es");
    const nulos = titulos.filter((t) => t.valoracion === null);
    expect(nulos.length).toBe(conCeroEnOrigen.length);
    expect(titulos.every((t) => t.valoracion !== 0)).toBe(true);
  });
});

describe("el addon se identifica por id, nunca por nombre (ADR 0005)", () => {
  it("la normalización guarda el id del proveedor", () => {
    const crudo = cargar("apple-peliculas.json");
    const parseado = respuestaBusquedaProveedor.parse(crudo);

    // Este addon es uno de los dos casos medidos: «MUBI» es el nombre de DOS
    // ids distintos (`tvs.sbd.1000249` y `mubies`).
    const conAddon = parseado.shows
      .flatMap((s) => s.streamingOptions?.es ?? [])
      .filter((o) => o.addon !== undefined);
    expect(conAddon.length).toBeGreaterThan(0);

    const canonicos = adaptadorStreamingAvailability.normalizar(crudo, "es");
    const addons = canonicos
      .flatMap((t) => t.disponibilidad)
      .map((d) => d.addon)
      .filter((a): a is string => a !== null);

    expect(addons.length).toBe(conAddon.length);
    // El id, no el nombre.
    expect(addons).toContain("tvs.sbd.1000249");
    expect(addons).not.toContain("MUBI");
  });

  it("una oferta sin addon lo deja en null, no en cadena vacía", () => {
    for (const fixture of FIXTURES) {
      const titulos = adaptadorStreamingAvailability.normalizar(cargar(fixture), "es");
      for (const d of titulos.flatMap((t) => t.disponibilidad)) {
        expect(d.addon === null || d.addon.length > 0).toBe(true);
      }
    }
  });
});
