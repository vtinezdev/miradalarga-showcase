/**
 * **Un `upcoming` sobre una oferta que YA está disponible** no toca su
 * disponibilidad ni produce `added`; su anuncio se guarda igual, en
 * `external_availability_announcements` (ADR 0007), y se cuenta.
 *
 * 📏 El caso real (`ops_sync_runs` fila 50, 2026-09-24): `tt9000044`
 * («Título ficticio 068»), Netflix `subscription`. El snapshot ya lista la oferta
 * disponible **desde 2022-11-10** con el link `…/title/81506535`; el aviso
 * trae **otro** link, `…/title/70196154`, y fecha futura (07-oct). Antes se
 * sintetizaba una segunda opción y el aviso, como «alta», fechaba hoy un
 * `added` de 2022. Fixture: `upcoming-imborrable.json`, recorte del crudo real.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { crearLibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import { leerPresupuesto } from "../../jobs/ops/presupuesto.ts";
import type { FuenteDeCuota, Transporte } from "../../jobs/ops/transporte.ts";
import { ejecutarDeltas } from "../../jobs/pipelines/deltas/index.ts";
import { transaccionPorPagina } from "../../jobs/pipelines/deltas/job.ts";
import { ejecutarJobDeUpcoming } from "../../jobs/pipelines/upcoming/job.ts";
import { conexionDeDatos } from "./ayudas-checkpoint.ts";
import { respuestaCruda, showCrudo } from "./ayudas-deltas.ts";
import type { BaseEnMemoria } from "./base-en-memoria.ts";
import { crearBaseEnMemoria } from "./base-en-memoria.ts";

const IMBORRABLE = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "..", "fixtures", "changes", "upcoming-imborrable.json"),
    "utf8",
  ),
) as { readonly meta: { readonly ahora: string }; readonly body: unknown };

/** El `ahora` real de la fila 50. */
const T50 = new Date(IMBORRABLE.meta.ahora);
const DIA = 86_400_000;
const en = (dias: number, desde = T50) => new Date(desde.getTime() + dias * DIA);
const seg = (d: Date) => Math.floor(d.getTime() / 1000);

const LINK_REAL = "https://www.netflix.com/ficticio/0096";
const LINK_DEL_AVISO = "https://www.netflix.com/ficticio/0091";
const OFERTA = "tt9000044|netflix|subscription|";

interface Mundo {
  readonly libro: ReturnType<typeof crearLibroEnMemoria>;
  readonly base: BaseEnMemoria;
}
const crearMundo = (): Mundo => ({
  libro: crearLibroEnMemoria(),
  base: crearBaseEnMemoria(),
});

async function upcoming(mundo: Mundo, cuerpo: unknown, ahora: Date) {
  const datos = conexionDeDatos(mundo.base, mundo.libro);
  const crear =
    (fuente: FuenteDeCuota): Transporte =>
    async () => {
      await fuente.pedirCuota();
      return new Response(JSON.stringify(cuerpo), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-quota-used": "1",
          "x-quota-granted": "1000",
          "x-quota-reset": "2026-10-01T00:00:00Z",
        },
      });
    };
  const salida = await ejecutarJobDeUpcoming({
    // El destino histórico, declarado: el régimen por defecto es el estricto.
    regimen: "historico",
    ejecutorOps: mundo.libro.ejecutor,
    ejecutorDatos: datos.ejecutor,
    transaccion: transaccionPorPagina(datos.ejecutor),
    presupuesto: leerPresupuesto({ STREAMING_API_PER_RUN_CAPS: "upcoming=12" }),
    crearLlamada: crear,
    apiKey: "k",
    plan: { origen: "persistente" },
    ahora,
    crearRegistro: null,
    vincularEventos: true,
  });
  expect(salida.resultado).toMatchObject({ ejecutado: true, estado: "succeeded" });
  return salida;
}

interface Foto {
  readonly opciones: readonly {
    readonly oferta: string;
    readonly link: string;
    readonly availableSince: string | null;
  }[];
  readonly eventos: readonly { readonly oferta: string; readonly tipo: string }[];
}
const foto = (base: BaseEnMemoria, instantes = true) =>
  base.foto({ instantes }) as Foto;
const deLaOferta = (f: Foto) => f.opciones.filter((o) => o.oferta === OFERTA);

describe("📏 tt9000044 «Título ficticio 068»: upcoming sobre una oferta ya disponible", () => {
  it("sobre una base vacía: ni opción sintética, ni `added`, ni `announced`; línea base", async () => {
    const mundo = crearMundo();
    const salida = await upcoming(mundo, IMBORRABLE.body, T50);

    expect(deLaOferta(foto(mundo.base))).toEqual([
      expect.objectContaining({
        link: LINK_REAL,
        availableSince: "2022-11-10T16:06:32.000Z",
      }),
    ]);
    expect(foto(mundo.base).opciones.some((o) => o.link === LINK_DEL_AVISO)).toBe(
      false,
    );
    expect(salida.informe?.eventos).toEqual({});
    expect(foto(mundo.base).eventos).toEqual([]);
    expect(salida.informe?.ofertasDeLineaBase).toBe(1);
  });

  it("⚖️ y su anuncio queda registrado, con el link y la fecha del aviso", async () => {
    const mundo = crearMundo();
    await upcoming(mundo, IMBORRABLE.body, T50);
    expect(mundo.base.anuncios()).toMatchObject([
      {
        imdbId: "tt9000044",
        platformId: "netflix",
        offerType: "subscription",
        link: LINK_DEL_AVISO,
      },
    ]);
    // El anuncio no es la disponibilidad: la opción real sigue siendo la única.
    expect(deLaOferta(foto(mundo.base)).map((o) => o.link)).toEqual([LINK_REAL]);
  });

  it("el aviso sigue contado: informe, resumen de anuncios y ninguna ausencia", async () => {
    const salida = await upcoming(crearMundo(), IMBORRABLE.body, T50);
    expect(salida.informe?.avisos).toBe(1);
    expect(salida.informe?.anunciosSobreOfertaDisponible).toBe(1);
    expect(salida.anuncios).toMatchObject({ avisos: 1, yaEnElCatalogo: 1 });
    expect(salida.anuncios?.porPlataforma.netflix).toBe(1);
    expect(salida.horizonte).toMatchObject({ completo: true, desaparecidas: 0 });
  });

  it("con la oferta ya en la base, una observación posterior no toca nada", async () => {
    const mundo = crearMundo();
    await upcoming(mundo, IMBORRABLE.body, T50);
    const antes = foto(mundo.base, false);
    const salida = await upcoming(mundo, IMBORRABLE.body, en(1));
    expect(foto(mundo.base, false)).toEqual(antes);
    expect(salida.informe?.eventos).toEqual({});
  });
});

describe("disponible solo en la base: el snapshot del anuncio no la lista", () => {
  const REAL = "https://netflix.test/serie/real";

  async function conOfertaDisponible(mundo: Mundo) {
    await ejecutarDeltas({
      ejecutor: mundo.base.ejecutor,
      peticion: {
        transporte: () =>
          Promise.resolve(
            new Response(
              JSON.stringify(
                respuestaCruda({
                  cambios: [
                    {
                      changeType: "new",
                      showId: "5",
                      service: "netflix",
                      type: "subscription",
                      link: REAL,
                      timestamp: seg(en(-10)),
                    },
                  ],
                  shows: [
                    showCrudo({
                      id: "5",
                      imdbId: "tt0000005",
                      opciones: [
                        {
                          service: "netflix",
                          type: "subscription",
                          link: REAL,
                          availableSince: seg(en(-10)),
                        },
                      ],
                    }),
                  ],
                }),
              ),
              { status: 200 },
            ),
          ),
        apiKey: "k",
      },
      tipos: ["new"],
      ventana: null,
      ahora: en(-1),
      maximoDePaginas: 1,
    });
  }

  const anuncio = (link: string) =>
    respuestaCruda({
      cambios: [
        {
          changeType: "upcoming",
          showId: "5",
          service: "netflix",
          type: "subscription",
          link,
          timestamp: seg(en(12)),
        },
      ],
      shows: [showCrudo({ id: "5", imdbId: "tt0000005", opciones: [] })],
    });

  it("con OTRO link: ni fantasma ni evento", async () => {
    const mundo = crearMundo();
    await conOfertaDisponible(mundo);
    const antes = foto(mundo.base, false);
    const salida = await upcoming(
      mundo,
      anuncio("https://netflix.test/serie/otra"),
      T50,
    );
    expect(foto(mundo.base, false).opciones).toEqual(antes.opciones);
    // Solo el `added` que dejó `deltas` al darla de alta.
    expect(foto(mundo.base).eventos).toEqual(antes.eventos);
    expect(salida.informe?.eventos).toEqual({});
    expect(salida.informe?.anunciosSobreOfertaDisponible).toBe(1);
    expect(mundo.base.anuncios()).toMatchObject([
      { imdbId: "tt0000005", link: "https://netflix.test/serie/otra" },
    ]);
  });
});

describe("una oferta que NO está disponible", () => {
  const anuncio = (id: string, estreno: Date) =>
    respuestaCruda({
      cambios: [
        {
          changeType: "upcoming",
          showId: id,
          service: "netflix",
          type: "subscription",
          link: `https://netflix.test/${id}`,
          timestamp: seg(estreno),
        },
      ],
      shows: [showCrudo({ id, imdbId: `tt${id.padStart(7, "0")}`, opciones: [] })],
    });

  it("una oferta realmente nueva: su anuncio, sin provisional y sin `announced`", async () => {
    const mundo = crearMundo();
    const salida = await upcoming(mundo, anuncio("8", en(9)), T50);
    expect(salida.informe?.eventos).toEqual({});
    expect(salida.informe?.anunciosSobreOfertaDisponible).toBe(0);
    expect(foto(mundo.base).opciones).toEqual([]);
    expect(mundo.base.anuncios()).toMatchObject([
      {
        link: "https://netflix.test/8",
        announcedFor: new Date(seg(en(9)) * 1000).toISOString(),
      },
    ]);
  });

  it("un aplazamiento cambia la fecha del anuncio, sin evento de disponibilidad", async () => {
    const mundo = crearMundo();
    await upcoming(mundo, anuncio("9", en(9)), T50);
    const salida = await upcoming(mundo, anuncio("9", en(14)), en(1));
    expect(salida.informe?.eventos).toEqual({});
    expect(mundo.base.anuncios()).toMatchObject([
      {
        announcedFor: new Date(seg(en(14)) * 1000).toISOString(),
        firstAnnouncedFor: new Date(seg(en(9)) * 1000).toISOString(),
      },
    ]);
  });

  it("y la observación fuera de orden sigue sin escribir", async () => {
    const mundo = crearMundo();
    await upcoming(mundo, anuncio("10", en(9)), en(1));
    const antes = foto(mundo.base);
    const salida = await upcoming(mundo, anuncio("10", en(20)), T50);
    expect(foto(mundo.base)).toEqual(antes);
    expect(salida.informe?.eventos).toEqual({});
  });
});
