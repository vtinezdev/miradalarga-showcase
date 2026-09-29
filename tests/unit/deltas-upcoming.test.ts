/**
 * El pipeline entero, con base de datos y red simuladas.
 *
 * Cubre `upcoming` con y sin enlace —desde el ADR 0007, los dos son **un
 * anuncio**, nunca una opción— y la reconciliación de una provisional
 * **heredada** contra el snapshot real, sobre las sentencias que de verdad se
 * emiten. Las provisionales ya no se crean, pero la rama de validación guarda
 * las de la fila 50 y `deltas` las sigue reconciliando igual.
 */
import { describe, expect, it } from "vitest";

import { ejecutarDeltas } from "../../jobs/pipelines/deltas/index.ts";
import {
  crearEjecutorFalso,
  crearTransporteFalso,
  filasInsertadas,
  respuestaCruda,
  showCrudo,
} from "./ayudas-deltas.ts";

const AHORA = new Date("2026-09-22T10:00:00.000Z");
/** Una semana por delante de `AHORA`: el estreno tiene que ser futuro de verdad. */
const ESTRENO_UNIX = Math.floor(AHORA.getTime() / 1000) + 7 * 86_400;
const LINK = "https://www.netflix.com/title/81749605";

async function correr(
  respuesta: Record<string, unknown>,
  estadoAnterior: readonly Record<string, unknown>[] = [],
) {
  const bd = crearEjecutorFalso(estadoAnterior);
  const red = crearTransporteFalso([respuesta]);
  const informe = await ejecutarDeltas({
    ejecutor: bd.ejecutor,
    peticion: { transporte: red.transporte, apiKey: "k" },
    tipos: ["upcoming"],
    ventana: null,
    ahora: AHORA,
    maximoDePaginas: 5,
  });
  return { informe, bd };
}

describe("upcoming con enlace: un anuncio, no una opción", () => {
  const respuesta = respuestaCruda({
    cambios: [
      {
        changeType: "upcoming",
        showId: "5000113",
        service: "netflix",
        type: "subscription",
        link: LINK,
        timestamp: ESTRENO_UNIX,
      },
    ],
    // 📏 21 de 25 shows anunciados traen `streamingOptions.es` VACÍO: la
    // oferta anunciada todavía no está en el catálogo.
    shows: [showCrudo({ id: "5000113", imdbId: "tt9000023", opciones: [] })],
  });

  it("escribe el título aunque la oferta no esté todavía en el catálogo", async () => {
    const { bd } = await correr(respuesta);
    const titulos = filasInsertadas(bd.sentencias, "external_titles");
    expect(titulos).toHaveLength(1);
    expect(titulos[0]?.imdb_id).toBe("tt9000023");
  });

  it("inserta el anuncio con su fecha y su link, sin opción ni oferta padre", async () => {
    const { bd } = await correr(respuesta);
    const anuncios = filasInsertadas(
      bd.sentencias,
      "external_availability_announcements",
    );
    expect(anuncios).toHaveLength(1);
    expect(anuncios[0]).toMatchObject({
      platform_id: "netflix",
      country: "es",
      offer_type: "subscription",
      addon: null,
      announced_for: new Date(ESTRENO_UNIX * 1000),
      first_announced_for: new Date(ESTRENO_UNIX * 1000),
      link: LINK,
      first_seen_at: AHORA,
      last_seen_at: AHORA,
    });
    expect(
      filasInsertadas(bd.sentencias, "external_availability_options"),
    ).toHaveLength(0);
    expect(filasInsertadas(bd.sentencias, "external_availability")).toHaveLength(0);
  });

  it("no emite ningún evento: un anuncio no es un cambio de disponibilidad", async () => {
    const { informe } = await correr(respuesta);
    expect(informe.eventos).toEqual({});
    expect(informe.eventosEscritos).toBe(0);
    expect(informe.anuncios).toMatchObject({ observados: 1, nuevos: 1 });
  });

  it("no marca ninguna ausencia: un anuncio no muere antes de estrenarse", async () => {
    const { informe } = await correr(respuesta);
    expect(informe.opcionesMarcadasAusentes).toBe(0);
    expect(informe.descartes).toHaveLength(0);
  });
});

describe("📏 upcoming sin enlace: también es un anuncio, con link NULL", () => {
  // 📏 Caso real del corpus: showId 5000107 (tt90000053), Prime, sin `link`,
  // y con `streamingOptions.es` vacío. No hay de dónde sacar el enlace.
  const respuesta = respuestaCruda({
    cambios: [
      {
        changeType: "upcoming",
        showId: "5000107",
        service: "prime",
        type: "subscription",
        timestamp: ESTRENO_UNIX,
      },
    ],
    shows: [showCrudo({ id: "5000107", imdbId: "tt90000053", opciones: [] })],
  });

  it("guarda el anuncio con link NULL: no inventa un enlace", async () => {
    const { bd, informe } = await correr(respuesta);
    const anuncios = filasInsertadas(
      bd.sentencias,
      "external_availability_announcements",
    );
    expect(anuncios).toHaveLength(1);
    expect(anuncios[0]).toMatchObject({ platform_id: "prime", link: null });
    expect(informe.anuncios).toMatchObject({ nuevos: 1, sinEnlace: 1 });
  });

  it("ni opción ni oferta padre: vacía se leería como `gone`", async () => {
    const { bd } = await correr(respuesta);
    expect(
      filasInsertadas(bd.sentencias, "external_availability_options"),
    ).toHaveLength(0);
    expect(filasInsertadas(bd.sentencias, "external_availability")).toHaveLength(0);
  });

  it("ya no es un descarte: el anuncio es representable", async () => {
    const { informe } = await correr(respuesta);
    expect(informe.descartes).toEqual([]);
  });

  it("el título sí se guarda: su identidad es un dato real", async () => {
    const { bd } = await correr(respuesta);
    const titulos = filasInsertadas(bd.sentencias, "external_titles");
    expect(titulos[0]?.imdb_id).toBe("tt90000053");
  });

  it("y no se emite ningún evento sobre una oferta que no existe", async () => {
    const { informe } = await correr(respuesta);
    expect(informe.eventosEscritos).toBe(0);
  });
});

describe("la provisional se reconcilia contra el snapshot real", () => {
  const ANUNCIADO_EL = new Date("2026-09-20T09:00:00.000Z");

  const estadoAnterior = [
    {
      imdb_id: "tt9000023",
      availability_id: 42,
      platform_id: "netflix",
      offer_type: "subscription",
      addon: null,
      option_id: 501,
      link: LINK,
      quality: null, // ← la provisional que dejó `upcoming`
      price_amount: null,
      price_currency: null,
      audio_languages: [],
      subtitle_languages: [],
      available_since: new Date(ESTRENO_UNIX * 1000),
      expires_at: null,
      first_seen_at: ANUNCIADO_EL,
      missing_streak: 0,
    },
  ];

  const respuesta = respuestaCruda({
    cambios: [
      {
        changeType: "new",
        showId: "5000113",
        service: "netflix",
        type: "subscription",
        link: LINK,
        timestamp: 1787357748,
      },
    ],
    shows: [
      showCrudo({
        id: "5000113",
        imdbId: "tt9000023",
        opciones: [
          {
            service: "netflix",
            type: "subscription",
            link: LINK,
            quality: "hd",
            availableSince: ESTRENO_UNIX,
          },
        ],
      }),
    ],
  });

  async function correrNew() {
    const bd = crearEjecutorFalso(estadoAnterior);
    const red = crearTransporteFalso([respuesta]);
    const informe = await ejecutarDeltas({
      ejecutor: bd.ejecutor,
      peticion: { transporte: red.transporte, apiKey: "k" },
      tipos: ["new"],
      ventana: null,
      ahora: AHORA,
      maximoDePaginas: 5,
    });
    return { informe, bd };
  }

  it("borra la provisional: `ON CONFLICT` no la habría tocado", async () => {
    const { informe, bd } = await correrNew();
    const borrados = bd.buscar("DELETE FROM external_availability_options");
    expect(borrados).toHaveLength(1);
    expect(borrados[0]?.valores[0]).toEqual(["501"]);
    expect(informe.opcionesReconciliadas).toBe(1);
  });

  it("hereda la antigüedad con LEAST: no reinicia «desde cuándo»", async () => {
    const { bd } = await correrNew();
    const herencias = bd.buscar("LEAST(first_seen_at");
    expect(herencias).toHaveLength(1);
    expect(herencias[0]?.valores[1]).toBe(LINK);
    expect(herencias[0]?.valores[2]).toEqual(ANUNCIADO_EL);
  });

  it("emite `changed`, nunca el par falso removed + added", async () => {
    const { informe } = await correrNew();
    expect(informe.eventos).toEqual({ changed: 1 });
    expect(informe.eventos.removed).toBeUndefined();
    expect(informe.eventos.added).toBeUndefined();
  });

  it("escribe el evento contra la oferta que YA existía, sin crear otra", async () => {
    const { bd } = await correrNew();
    const eventos = bd.buscar("INSERT INTO external_availability_events");
    expect(eventos).toHaveLength(1);
    expect(eventos[0]?.valores[0]).toBe("42");
    expect(eventos[0]?.valores[1]).toBe("changed");
  });
});
