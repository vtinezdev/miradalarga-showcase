/**
 * El schema de `/changes` contra las respuestas **reales** del Spike 1.
 *
 * Es la validación más barata que existe: cuesta **cero requests** y prueba
 * contra lo que el proveedor devolvió de verdad, no contra su documentación.
 *
 * Solo corre en local: `spike-1/raw/` está en `.gitignore` y el CI no lo
 * tiene, igual que ocurre con el corpus del seed. Un test que dependiera del
 * crudo se pondría rojo en CI por una razón que no es un defecto.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { normalizarPaginaDeCambios } from "../../jobs/adapters/streaming-availability/normalizar-cambios.ts";
import {
  respuestaCambiosProveedor,
  showProveedor,
} from "../../jobs/adapters/streaming-availability/schema.ts";
import { contrastarExpiracion } from "../../jobs/pipelines/deltas/validacion.ts";

const RAIZ_CRUDA = join(import.meta.dirname, "..", "..", "spike-1", "raw");
const hayCrudo = existsSync(RAIZ_CRUDA);

/** Las cinco respuestas 200. Las otras tres son el HTTP 400 por desfase de reloj. */
const RESPUESTAS = [
  ["new", "018-C-changes-new-sinventana.json", 21],
  ["removed", "020-C-changes-removed-sinventana.json", 23],
  ["updated", "022-C-changes-updated-sinventana.json", 16],
  ["expiring", "023-C-changes-expiring.json", 25],
  ["upcoming", "024-C-changes-upcoming.json", 25],
] as const;

/**
 * La respuesta **de la API**, desenvuelta del formato del grabador.
 *
 * Los ficheros de `spike-1/raw/` son nuestros: `spike-1/probe.mjs` guarda
 * `{ meta: <sus metadatos>, body: <la respuesta> }`. El schema describe lo que
 * emite el proveedor, no lo que archivamos nosotros, asi que aqui se saca el
 * `body`. Confundir las dos cosas costo una request y un `ZodError`.
 */
function leer(fichero: string): unknown {
  const guardado = JSON.parse(readFileSync(join(RAIZ_CRUDA, fichero), "utf8")) as {
    body: unknown;
  };
  return guardado.body;
}

describe.skipIf(!hayCrudo)("el schema de /changes contra el crudo del Spike 1", () => {
  it.each(RESPUESTAS)(
    "change_type=%s valida y trae 25 avisos con sus %i shows",
    (_tipo, fichero, shows) => {
      const analizada = respuestaCambiosProveedor.parse(leer(fichero));
      expect(analizada.changes).toHaveLength(25);
      expect(Object.keys(analizada.shows)).toHaveLength(shows);
    },
  );

  it.each(RESPUESTAS)(
    "change_type=%s: cada showId resuelve contra shows",
    (_tipo, fichero) => {
      const pagina = respuestaCambiosProveedor.parse(leer(fichero));
      const claves = new Set(Object.keys(pagina.shows));

      // Ni un aviso huérfano...
      for (const cambio of pagina.changes) expect(claves.has(cambio.showId)).toBe(true);
      // ...ni un show que nadie referencie.
      const referenciados = new Set(pagina.changes.map((c) => c.showId));
      for (const clave of claves) expect(referenciados.has(clave)).toBe(true);
    },
  );

  it("los 110 shows cumplen el `showProveedor` que YA existía, sin tocarlo", () => {
    // Es lo que permite reutilizar `normalizarShow` y no pedir ninguna ficha
    // por separado: el coste del pipeline es exactamente el de paginar.
    let validados = 0;
    for (const [, fichero] of RESPUESTAS) {
      const pagina = respuestaCambiosProveedor.parse(leer(fichero));
      for (const show of Object.values(pagina.shows)) {
        expect(showProveedor.safeParse(show).success).toBe(true);
        validados++;
      }
    }
    expect(validados).toBe(110);
  });

  it("`link` falta donde está medido que falta, y solo ahí", () => {
    const conEnlace = (fichero: string): number =>
      respuestaCambiosProveedor
        .parse(leer(fichero))
        .changes.filter((c) => c.link !== undefined).length;

    // Una oferta retirada no tiene enlace que dar: 0 de 25.
    expect(conEnlace("020-C-changes-removed-sinventana.json")).toBe(0);
    // Y un anuncio, casi siempre sí: 24 de 25. El que falta no es
    // representable como opción y el pipeline lo descarta con motivo.
    expect(conEnlace("024-C-changes-upcoming.json")).toBe(24);
    expect(conEnlace("018-C-changes-new-sinventana.json")).toBe(25);
    expect(conEnlace("022-C-changes-updated-sinventana.json")).toBe(25);
  });

  it("la oferta anunciada todavía NO está en el catálogo", () => {
    // 📏 El hecho que obliga a sintetizar la opción provisional, y con ella a
    // la reconciliación posterior.
    const pagina = respuestaCambiosProveedor.parse(leer("024-C-changes-upcoming.json"));
    const presentes = pagina.changes.filter((cambio) => {
      const show = pagina.shows[cambio.showId];
      return (show?.streamingOptions?.es ?? []).some(
        (o) => o.service.id === cambio.service.id && o.link === cambio.link,
      );
    });
    expect(presentes).toHaveLength(0);
  });

  it("el `timestamp` de un aviso `expiring` ES el `expiresOn` del snapshot", () => {
    // 📏 25 de 25 pares coinciden **al segundo**, y ninguno queda sin
    // contrastar. El diseño usaba ese timestamp como `expires_at` por
    // inferencia —caía dentro de la ventana y era futuro—; con esto deja de
    // ser una inferencia y pasa a estar medido, sin gastar una sola request.
    const { contrastes, descartados } = contrastarExpiracion(
      respuestaCambiosProveedor.parse(leer("023-C-changes-expiring.json")),
    );
    expect(contrastes).toHaveLength(25);
    expect(descartados).toBe(0);
    expect(contrastes.filter((c) => c.coinciden)).toHaveLength(25);
    expect(Math.max(...contrastes.map((c) => Math.abs(c.diferenciaSegundos)))).toBe(0);
  });

  it("B3: 25 avisos `updated` son solo 16 títulos distintos", () => {
    // Por eso se agrupa por showId antes de tocar la base de datos.
    const pagina = respuestaCambiosProveedor.parse(
      leer("022-C-changes-updated-sinventana.json"),
    );
    expect(new Set(pagina.changes.map((c) => c.showId)).size).toBe(16);
  });
});

describe.skipIf(!hayCrudo)("la traducción al modelo canónico", () => {
  it("normaliza avisos y títulos sin perder ninguno", () => {
    const analizada = respuestaCambiosProveedor.parse(
      leer("018-C-changes-new-sinventana.json"),
    );
    const pagina = normalizarPaginaDeCambios(analizada, "es");

    expect(pagina.avisos).toHaveLength(25);
    expect(pagina.titulos.size).toBe(21);
    expect(pagina.hayMas).toBe(true);
    expect(pagina.cursorSiguiente).toBe("1787578334:2787037446");

    // El aviso trae el id del proveedor; el `imdbId` sale del show que lo
    // acompaña. Ese emparejamiento es lo que elimina el `GET /shows/{id}`.
    for (const aviso of pagina.avisos) {
      expect(pagina.titulos.get(aviso.idProveedor)?.ids.imdbId).toMatch(/^tt\d+$/);
    }
  });

  it("el addon viaja por `id` y nunca por nombre (ADR 0005)", () => {
    const analizada = respuestaCambiosProveedor.parse(
      leer("023-C-changes-expiring.json"),
    );
    const pagina = normalizarPaginaDeCambios(analizada, "es");
    const conAddon = pagina.avisos.filter((a) => a.addon !== null);

    expect(conAddon.length).toBeGreaterThan(0);
    for (const aviso of conAddon) {
      // Un id no lleva espacios ni mayúsculas: «SHADOWZ» es el nombre,
      // `shadowzes` es la identidad.
      expect(aviso.addon).toMatch(/^[a-z0-9._-]+$/);
    }
  });
});
