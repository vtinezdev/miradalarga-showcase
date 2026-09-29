/**
 * **Qué hace `updated` con cada cambio**, oferta a oferta, contra una base en
 * memoria con estado y transacciones de verdad.
 *
 * `updated` es un cambio sobre algo que el proveedor ya conoce:
 *
 *   · no crea una oferta que ni la base ni el snapshot conocen;
 *   · no interpreta ausencias: ni `missing_streak`, ni borrados;
 *   · no fabrica eventos si el agregado no cambia;
 *   · no toca títulos que no están en la base;
 *   · respeta las observaciones fuera de orden como el resto del núcleo.
 *
 * Y lo que sí cambia se clasifica en tres planos que no se mezclan:
 * persistencia (lo que se escribe), evento técnico (el agregado) y —fuera de
 * aquí— valor editorial.
 */
import { describe, expect, it } from "vitest";

import { ejecutarDeltas } from "../../jobs/pipelines/deltas/index.ts";
import { transaccionPorPagina } from "../../jobs/pipelines/deltas/job.ts";
import type { CambioCrudo, OpcionCruda } from "./ayudas-deltas.ts";
import { crearTransporteFalso, respuestaCruda, showCrudo } from "./ayudas-deltas.ts";
import { foto, observarUpdated, sembrar } from "./ayudas-updated.ts";
import type { BaseEnMemoria } from "./base-en-memoria.ts";
import { crearBaseEnMemoria } from "./base-en-memoria.ts";

const T0 = new Date("2026-09-24T06:00:00.000Z");
const T1 = new Date("2026-09-25T06:00:00.000Z");
const T2 = new Date("2026-09-26T06:00:00.000Z");
const seg = (d: Date) => Math.floor(d.getTime() / 1000);

const ID = "7";
const IMDB = "tt0000007";

const L_NETFLIX = "https://netflix.test/7";
const L_APPLE = "https://apple.test/7?playableId=1";
const L_APPLE_2 = "https://apple.test/7?playableId=2";

const NETFLIX: OpcionCruda = {
  service: "netflix",
  type: "subscription",
  link: L_NETFLIX,
  quality: "hd",
};
const COMPRA: OpcionCruda = {
  service: "apple",
  type: "buy",
  link: L_APPLE,
  quality: "hd",
  price: { amount: "9.99", currency: "EUR" },
};
const ALQUILER: OpcionCruda = {
  service: "apple",
  type: "rent",
  link: L_APPLE,
  quality: "hd",
  price: { amount: "3.99", currency: "EUR" },
};

const show = (opciones: readonly OpcionCruda[], id = ID) =>
  showCrudo({ id, imdbId: `tt${id.padStart(7, "0")}`, opciones });

const aviso = (
  service: string,
  type: string,
  extra: Partial<CambioCrudo> = {},
): CambioCrudo => ({
  changeType: "updated",
  showId: ID,
  service,
  type,
  timestamp: seg(T0) + 3600,
  ...extra,
});

const pagina = (
  avisos: readonly CambioCrudo[],
  shows: readonly Record<string, unknown>[],
  extra: { hasMore?: boolean; nextCursor?: string } = {},
) => respuestaCruda({ cambios: avisos, shows, ...extra });

/** Base con el título 7 en Netflix, Apple compra y Apple alquiler, vistos en T0. */
async function conCatalogo(
  opciones: readonly OpcionCruda[] = [NETFLIX, COMPRA, ALQUILER],
): Promise<BaseEnMemoria> {
  const base = crearBaseEnMemoria();
  await sembrar(base, T0, [show(opciones)]);
  return base;
}

/** Un solo `updated` sobre una oferta, con el show que trae la página. */
async function unUpdated(
  base: BaseEnMemoria,
  service: string,
  type: string,
  despues: readonly OpcionCruda[],
  ahora = T1,
) {
  return observarUpdated(base, ahora, [
    pagina([aviso(service, type)], [show(despues)]),
  ]);
}

describe("updated por tipo de oferta", () => {
  it("subscription: un idioma de audio nuevo es un evento changed[audio_languages]", async () => {
    const base = await conCatalogo();
    const { clasificacion } = await unUpdated(base, "netflix", "subscription", [
      { ...NETFLIX, audios: ["spa", "eng"] },
      COMPRA,
      ALQUILER,
    ]);
    expect(clasificacion.porResultado.evento).toBe(1);
    expect(clasificacion.porGrupo["netflix/subscription"]?.resultados).toEqual({
      evento: 1,
    });
    expect(clasificacion.eventos.deAvisos).toEqual({ changed: 1 });
    expect(clasificacion.eventos.camposDeAvisos).toEqual({ audio_languages: 1 });
    expect(clasificacion.camposCambiados).toEqual({ audio_languages: 1 });
    expect(base.eventos()).toHaveLength(1);
  });

  it("rent: el precio baja 3.99 → 2.99, evento changed[price]", async () => {
    const base = await conCatalogo();
    const { clasificacion } = await unUpdated(base, "apple", "rent", [
      NETFLIX,
      COMPRA,
      { ...ALQUILER, price: { amount: "2.99", currency: "EUR" } },
    ]);
    expect(clasificacion.porGrupo["apple/rent"]?.resultados).toEqual({ evento: 1 });
    expect(clasificacion.eventos.camposDeAvisos).toEqual({ price: 1 });
    expect(clasificacion.precios).toMatchObject({ cambios: 1, bajan: 1, suben: 0 });
    expect(clasificacion.precios.muestra[0]).toMatchObject({
      grupo: "apple/rent",
      antes: { importe: "3.99", moneda: "EUR" },
      despues: { importe: "2.99", moneda: "EUR" },
    });
  });

  it("buy: el precio sube 9.99 → 13.99, evento changed[price]; lo demás, intacto", async () => {
    const base = await conCatalogo();
    const { clasificacion } = await unUpdated(base, "apple", "buy", [
      NETFLIX,
      { ...COMPRA, price: { amount: "13.99", currency: "EUR" } },
      ALQUILER,
    ]);
    expect(clasificacion.porGrupo["apple/buy"]?.resultados).toEqual({ evento: 1 });
    expect(clasificacion.precios).toMatchObject({ cambios: 1, suben: 1 });
    expect(clasificacion.porGrupo["apple/buy"]?.preciosCambiados).toBe(1);
    // Solo la oferta nombrada cambió: las acompañantes no dan evento.
    expect(clasificacion.eventos.deAcompanantes).toEqual({});
    expect(base.eventos()).toHaveLength(1);
  });

  it("buy: el mismo precio es un no-op, sin evento", async () => {
    const base = await conCatalogo();
    const { clasificacion, informe } = await unUpdated(base, "apple", "buy", [
      NETFLIX,
      COMPRA,
      ALQUILER,
    ]);
    expect(clasificacion.porResultado.no_op).toBe(1);
    expect(clasificacion.porResultado.evento).toBe(0);
    expect(informe.eventosEscritos).toBe(0);
    expect(base.eventos()).toHaveLength(0);
  });

  it("buy con dos calidades: si cambia la que no es la más barata, se persiste sin evento", async () => {
    const UHD: OpcionCruda = {
      ...COMPRA,
      quality: "uhd",
      price: { amount: "13.99", currency: "EUR" },
    };
    const base = await conCatalogo([COMPRA, UHD]);
    const { clasificacion } = await unUpdated(base, "apple", "buy", [
      COMPRA,
      { ...UHD, price: { amount: "11.99", currency: "EUR" } },
    ]);
    // El agregado es el MIN: 9.99 antes y después.
    expect(clasificacion.porResultado.cambio_sin_efecto_en_agregado).toBe(1);
    expect(clasificacion.camposCambiados).toEqual({ price: 1 });
    expect(base.eventos()).toHaveLength(0);
    const uhd = foto(base).opciones.find(
      (o) => o.link === L_APPLE && o.quality === "uhd",
    );
    expect(uhd?.priceAmount).toBe("11.99");
  });

  it("moneda: el mismo importe en otra moneda se clasifica como cambio de moneda", async () => {
    const base = await conCatalogo();
    const { clasificacion } = await unUpdated(base, "apple", "buy", [
      NETFLIX,
      { ...COMPRA, price: { amount: "9.99", currency: "USD" } },
      ALQUILER,
    ]);
    expect(clasificacion.camposCambiados).toEqual({ currency: 1 });
    expect(clasificacion.precios.cambiosDeMoneda).toBe(1);
    // El agregado compara importe y moneda: sí es un evento de precio.
    expect(clasificacion.eventos.camposDeAvisos).toEqual({ price: 1 });
  });
});

describe("updated por campo", () => {
  it("calidad hd → uhd con el mismo link: la nueva entra y la vieja NO sale", async () => {
    const base = await conCatalogo();
    const { clasificacion, informe } = await unUpdated(base, "apple", "buy", [
      NETFLIX,
      { ...COMPRA, quality: "uhd" },
      ALQUILER,
    ]);
    expect(clasificacion.porResultado.evento).toBe(1);
    expect(clasificacion.camposCambiados).toMatchObject({ quality: 1, options: 1 });
    expect(clasificacion.eventos.camposDeAvisos).toEqual({ options: 1, quality: 1 });
    // ⚠️ Sin interpretar ausencias, la opción hd sigue activa: es lo que mide
    // `opcionesQueSobrevivenSinVerse`, y la decisión que queda pendiente.
    expect(clasificacion.opcionesQueSobrevivenSinVerse).toBe(1);
    const hd = foto(base).opciones.find(
      (o) => o.link === L_APPLE && o.quality === "hd" && o.priceAmount === "9.99",
    );
    expect(hd?.missingStreak).toBe(0);
    expect(informe.opcionesMarcadasAusentes).toBe(0);
  });

  it("subtítulos: uno nuevo es changed[subtitle_languages]", async () => {
    const base = await conCatalogo();
    const { clasificacion } = await unUpdated(base, "netflix", "subscription", [
      { ...NETFLIX, subtitulos: ["spa", "eng"] },
      COMPRA,
      ALQUILER,
    ]);
    expect(clasificacion.eventos.camposDeAvisos).toEqual({ subtitle_languages: 1 });
  });

  it("idiomas reordenados: el mismo conjunto en otro orden es solo metadatos, sin evento", async () => {
    const base = await conCatalogo([{ ...NETFLIX, audios: ["spa", "eng"] }]);
    const { clasificacion } = await unUpdated(base, "netflix", "subscription", [
      { ...NETFLIX, audios: ["eng", "spa"] },
    ]);
    expect(clasificacion.porResultado.solo_metadatos).toBe(1);
    expect(clasificacion.camposCambiados).toEqual({ language_order: 1 });
    expect(base.eventos()).toHaveLength(0);
  });

  it("link: el nuevo entra y el viejo sigue activo; evento changed[options]", async () => {
    const base = await conCatalogo();
    const { clasificacion } = await unUpdated(base, "apple", "buy", [
      NETFLIX,
      { ...COMPRA, link: L_APPLE_2 },
      ALQUILER,
    ]);
    expect(clasificacion.camposCambiados).toMatchObject({ link: 1, options: 1 });
    expect(clasificacion.eventos.camposDeAvisos).toEqual({ options: 1 });
    expect(clasificacion.opcionesQueSobrevivenSinVerse).toBe(1);
    expect(base.opcion(L_APPLE_2)).toBeDefined();
  });

  it("expires_at: una fecha de salida nueva es changed[expires_at]", async () => {
    const base = await conCatalogo();
    const { clasificacion } = await unUpdated(base, "netflix", "subscription", [
      { ...NETFLIX, expiresOn: seg(T2) + 10 * 86_400 },
      COMPRA,
      ALQUILER,
    ]);
    expect(clasificacion.eventos.camposDeAvisos).toEqual({ expires_at: 1 });
    expect(clasificacion.camposCambiados).toEqual({ expires_at: 1 });
  });

  it("available_since: otra fecha de alta es changed[available_since]", async () => {
    const base = await conCatalogo([
      { ...NETFLIX, availableSince: seg(T0) - 86_400 * 400 },
    ]);
    const { clasificacion } = await unUpdated(base, "netflix", "subscription", [
      { ...NETFLIX, availableSince: seg(T0) - 86_400 * 300 },
    ]);
    expect(clasificacion.eventos.camposDeAvisos).toEqual({ available_since: 1 });
  });

  it("video_link: se persiste, pero es solo metadatos y no hay evento", async () => {
    const base = await conCatalogo([{ ...NETFLIX, videoLink: "https://play.test/a" }]);
    const { clasificacion } = await unUpdated(base, "netflix", "subscription", [
      { ...NETFLIX, videoLink: "https://play.test/b" },
    ]);
    expect(clasificacion.porResultado.solo_metadatos).toBe(1);
    expect(clasificacion.camposCambiados).toEqual({ video_link: 1 });
    expect(base.eventos()).toHaveLength(0);
    expect(base.opcion(L_NETFLIX)?.videoLink).toBe("https://play.test/b");
  });
});

describe("lo que updated no hace", () => {
  it("before == after: no-op, ningún evento y ninguna opción nueva", async () => {
    const base = await conCatalogo();
    const antes = foto(base, false);
    const { clasificacion, informe } = await unUpdated(base, "apple", "buy", [
      NETFLIX,
      COMPRA,
      ALQUILER,
    ]);
    expect(clasificacion.porResultado.no_op).toBe(1);
    expect(informe.eventos).toEqual({});
    expect(foto(base, false).opciones).toEqual(antes.opciones);
  });

  it("no incrementa missing_streak ni borra: la opción que el snapshot ya no lista sigue igual", async () => {
    const base = await conCatalogo([NETFLIX, { ...NETFLIX, link: `${L_NETFLIX}-b` }]);
    const { informe } = await unUpdated(base, "netflix", "subscription", [NETFLIX]);
    const b = base.opcion(`${L_NETFLIX}-b`);
    expect(b?.missingStreak).toBe(0);
    expect(informe.opcionesMarcadasAusentes).toBe(0);
    expect(informe.opcionesReconciliadas).toBe(0);
    expect(base.sentencias.some((s) => s.startsWith("DELETE"))).toBe(false);
    expect(foto(base).opciones).toHaveLength(2);
  });

  it("una segunda observación con la ausencia tampoco la retira", async () => {
    const base = await conCatalogo([NETFLIX, { ...NETFLIX, link: `${L_NETFLIX}-b` }]);
    await unUpdated(base, "netflix", "subscription", [NETFLIX], T1);
    await unUpdated(base, "netflix", "subscription", [NETFLIX], T2);
    expect(base.opcion(`${L_NETFLIX}-b`)?.missingStreak).toBe(0);
    expect(base.eventos()).toHaveLength(0);
  });

  it("no crea una oferta que ni la base ni el snapshot conocen", async () => {
    const base = await conCatalogo([NETFLIX]);
    const ofertas = foto(base).ofertas.length;
    const { clasificacion } = await unUpdated(base, "apple", "buy", [NETFLIX]);
    expect(clasificacion.porResultado.sin_oferta).toBe(1);
    expect(foto(base).ofertas).toHaveLength(ofertas);
  });

  it("una oferta que la base no tenía y el snapshot sí: línea base, sin evento", async () => {
    const base = await conCatalogo([NETFLIX]);
    const { clasificacion } = await unUpdated(base, "apple", "buy", [NETFLIX, COMPRA]);
    expect(clasificacion.porResultado.linea_base).toBe(1);
    expect(base.opcion(L_APPLE)?.priceAmount).toBe("9.99");
    expect(base.eventos()).toHaveLength(0);
  });

  it("no toca un título que no está en la base", async () => {
    const base = crearBaseEnMemoria();
    const { clasificacion, informe } = await unUpdated(base, "apple", "buy", [COMPRA]);
    expect(clasificacion.porResultado.fuera_de_catalogo).toBe(1);
    expect(informe.titulosFueraDeCatalogo).toBe(1);
    const estado = foto(base);
    expect(estado.titulos).toEqual([]);
    expect(estado.ofertas).toEqual([]);
  });

  it("deltas, sin las opciones de updated, sigue escribiendo títulos nuevos y sin detalle", async () => {
    const base = crearBaseEnMemoria();
    const red = crearTransporteFalso([
      pagina([{ ...aviso("apple", "buy"), changeType: "new" }], [show([COMPRA])]),
    ]);
    const informe = await ejecutarDeltas({
      ejecutor: base.ejecutor,
      peticion: { transporte: red.transporte, apiKey: "k" },
      tipos: ["new"],
      ventana: null,
      ahora: T1,
      maximoDePaginas: 10,
      transaccion: transaccionPorPagina(base.ejecutor),
    });
    expect(informe.detalle).toBeNull();
    expect(informe.titulosFueraDeCatalogo).toBe(0);
    expect(foto(base).titulos).toEqual([IMDB]);
    expect(informe.eventos).toEqual({ added: 1 });
  });
});

describe("orden temporal e idempotencia", () => {
  it("fuera de orden: una observación más vieja que la aplicada no escribe nada", async () => {
    const base = crearBaseEnMemoria();
    await sembrar(base, T2, [show([COMPRA])]);
    const { clasificacion } = await unUpdated(
      base,
      "apple",
      "buy",
      [{ ...COMPRA, price: { amount: "4.99", currency: "EUR" } }],
      T1,
    );
    expect(clasificacion.porResultado.fuera_de_orden).toBe(1);
    expect(base.opcion(L_APPLE)?.priceAmount).toBe("9.99");
    expect(base.eventos()).toHaveLength(0);
  });

  it("la misma observación dos veces: la segunda no escribe nada", async () => {
    const base = await conCatalogo();
    const despues = [
      NETFLIX,
      { ...COMPRA, price: { amount: "4.99", currency: "EUR" } },
      ALQUILER,
    ];
    await unUpdated(base, "apple", "buy", despues);
    const tras1 = foto(base);
    const { clasificacion, informe } = await unUpdated(base, "apple", "buy", despues);
    expect(clasificacion.porResultado.misma_observacion).toBe(1);
    expect(informe.eventosEscritos).toBe(0);
    expect(foto(base)).toEqual(tras1);
  });

  it("dos avisos de la misma oferta en una página: el segundo es un repetido", async () => {
    const base = await conCatalogo();
    const { clasificacion } = await observarUpdated(base, T1, [
      pagina(
        [aviso("apple", "buy"), aviso("apple", "buy", { timestamp: seg(T0) + 7200 })],
        [show([NETFLIX, COMPRA, ALQUILER])],
      ),
    ]);
    expect(clasificacion.avisos).toBe(2);
    expect(clasificacion.porResultado).toMatchObject({ no_op: 1, repetido: 1 });
  });

  it("las ofertas que el snapshot trae sin aviso también se comparan, y se cuentan aparte", async () => {
    const base = await conCatalogo();
    const { clasificacion } = await unUpdated(base, "apple", "buy", [
      { ...NETFLIX, audios: ["spa", "eng"] },
      COMPRA,
      ALQUILER,
    ]);
    expect(clasificacion.porResultado.no_op).toBe(1);
    expect(clasificacion.eventos.deAvisos).toEqual({});
    expect(clasificacion.eventos.deAcompanantes).toEqual({ changed: 1 });
    expect(clasificacion.eventos.camposDeAcompanantes).toEqual({ audio_languages: 1 });
  });
});

describe("paginación", () => {
  it("varias páginas: la segunda se pide con el cursor de la primera", async () => {
    const base = await conCatalogo();
    const { clasificacion, informe, red } = await observarUpdated(base, T1, [
      pagina([aviso("apple", "buy")], [show([NETFLIX, COMPRA, ALQUILER])], {
        hasMore: true,
        nextCursor: "1790000000:1",
      }),
      pagina([aviso("apple", "rent")], [show([NETFLIX, COMPRA, ALQUILER])]),
    ]);
    expect(informe.paginas).toBe(2);
    expect(new URL(red.urls[0] ?? "").searchParams.get("cursor")).toBeNull();
    expect(new URL(red.urls[1] ?? "").searchParams.get("cursor")).toBe("1790000000:1");
    // El título ya se observó en la página 1 con el mismo `ahora`: en la 2 es
    // la misma observación.
    expect(clasificacion.porResultado).toMatchObject({
      no_op: 1,
      misma_observacion: 1,
    });
  });

  it("cursor sin progreso: cierra con cursor_sin_progreso sin pedir otra página", async () => {
    const base = await conCatalogo();
    const repetida = pagina(
      [aviso("apple", "buy")],
      [show([NETFLIX, COMPRA, ALQUILER])],
      {
        hasMore: true,
        nextCursor: "1790000000:1",
      },
    );
    const red = crearTransporteFalso([repetida, repetida, repetida]);
    await expect(
      ejecutarDeltas({
        ejecutor: base.ejecutor,
        peticion: { transporte: red.transporte, apiKey: "k" },
        tipos: ["updated"],
        ventana: null,
        ahora: T1,
        maximoDePaginas: 10,
        transaccion: transaccionPorPagina(base.ejecutor),
        interpretarAusencias: false,
        soloTitulosConocidos: true,
        detallarOfertas: true,
      }),
    ).rejects.toThrow(/cursor ya usado/);
    expect(red.urls).toHaveLength(2);
  });
});
