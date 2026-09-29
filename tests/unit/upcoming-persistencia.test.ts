/**
 * **Los anuncios de `upcoming` persisten como anuncios** (ADR 0007): el job
 * entero, con la base en memoria y sin red.
 *
 *   · Un anuncio escribe **una** fila en `external_availability_announcements`
 *     por oferta —título, plataforma, país, tipo, addon—, con o sin `link`.
 *   · **Ni una opción, ni una oferta padre, ni un evento** salen de un anuncio.
 *   · La fecha y el link son atributos: se actualizan en la misma fila.
 *
 * 📏 Con dos fuentes: las tres páginas **reales y completas** de la fila 50
 * (`upcoming-fila50-completa.json`) y páginas sintéticas para los casos que
 * la fila 50 no trae —aplazamientos, ciclos nuevos, conflictos—.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { crearLibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import type { LibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import { leerPresupuesto } from "../../jobs/ops/presupuesto.ts";
import type { FuenteDeCuota, Transporte } from "../../jobs/ops/transporte.ts";
import { transaccionPorPagina } from "../../jobs/pipelines/deltas/job.ts";
import { claveDeOferta } from "../../jobs/pipelines/seed/filas.ts";
import { SQL_ANUNCIOS_NO_OBSERVADOS } from "../../jobs/pipelines/upcoming/horizonte.ts";
import { ejecutarJobDeUpcoming } from "../../jobs/pipelines/upcoming/job.ts";
import { conexionDeDatos } from "./ayudas-checkpoint.ts";
import { respuestaCruda, showCrudo } from "./ayudas-deltas.ts";
import type { BaseEnMemoria } from "./base-en-memoria.ts";
import { crearBaseEnMemoria } from "./base-en-memoria.ts";

const DIA = 86_400_000;
const T = new Date("2026-09-24T10:00:00.000Z");
const en = (dias: number, desde = T) => new Date(desde.getTime() + dias * DIA);
const seg = (d: Date) => Math.floor(d.getTime() / 1000);
const iso = (d: Date) => new Date(seg(d) * 1000).toISOString();

const CUOTA = {
  "x-quota-used": "122",
  "x-quota-granted": "1000",
  "x-quota-reset": "2026-10-01T00:00:00Z",
};

// ── Dobles ───────────────────────────────────────────────────────────────────

type Listas = ReadonlyMap<string, unknown>;

interface Mundo {
  readonly libro: LibroEnMemoria;
  readonly base: BaseEnMemoria;
}

const crearMundo = (): Mundo => ({
  libro: crearLibroEnMemoria(),
  base: crearBaseEnMemoria(),
});

async function ejecutar(
  mundo: Mundo,
  entrada: {
    readonly listas: Listas;
    readonly ahora?: Date;
    readonly tope?: number;
    /** `false` = ensayo o reproducción: la fila de la ejecución no es real. */
    readonly vincular?: boolean;
  },
) {
  const datos = conexionDeDatos(mundo.base, mundo.libro);
  const crear =
    (fuente: FuenteDeCuota): Transporte =>
    async (url) => {
      await fuente.pedirCuota();
      const u = new URL(url);
      const clave = `${u.searchParams.get("change_type") ?? "?"}|${u.searchParams.get("cursor") ?? ""}`;
      const cuerpo = entrada.listas.get(clave);
      if (cuerpo === undefined) throw new Error(`sin página para ${clave}`);
      return new Response(JSON.stringify(cuerpo), {
        status: 200,
        headers: { "content-type": "application/json", ...CUOTA },
      });
    };
  const salida = await ejecutarJobDeUpcoming({
    // El destino histórico, declarado: el régimen por defecto es el estricto.
    regimen: "historico",
    ejecutorOps: mundo.libro.ejecutor,
    ejecutorDatos: datos.ejecutor,
    transaccion: transaccionPorPagina(datos.ejecutor),
    presupuesto: leerPresupuesto({
      STREAMING_API_PER_RUN_CAPS: `upcoming=${String(entrada.tope ?? 12)}`,
    }),
    crearLlamada: crear,
    apiKey: "k",
    plan: { origen: "persistente" },
    ahora: entrada.ahora ?? T,
    crearRegistro: null,
    vincularEventos: entrada.vincular ?? true,
  });
  const runId = salida.resultado.ejecutado ? salida.resultado.runId : -1;
  return { salida, runId };
}

const estado = (s: { resultado: { ejecutado: boolean } }) => {
  const r = s.resultado as { ejecutado: boolean; estado?: string };
  return r.ejecutado ? r.estado : "no_ejecutado";
};

const imdb = (id: string) => `tt${id.padStart(7, "0")}`;

/** Un aviso `upcoming` con su show. `link: null` = sin enlace. */
function anuncio(entrada: {
  readonly id: string;
  readonly estreno: Date;
  readonly servicio?: string;
  readonly link?: string | null;
  readonly opciones?: Parameters<typeof showCrudo>[0]["opciones"];
}) {
  const servicio = entrada.servicio ?? "netflix";
  const link =
    entrada.link === undefined
      ? `https://${servicio}.test/${entrada.id}`
      : entrada.link;
  return {
    cambio: {
      changeType: "upcoming",
      showId: entrada.id,
      service: servicio,
      type: "subscription",
      ...(link === null ? {} : { link }),
      timestamp: seg(entrada.estreno),
    },
    show: showCrudo({
      id: entrada.id,
      imdbId: imdb(entrada.id),
      opciones: entrada.opciones ?? [],
    }),
  };
}

function paginaDe(
  avisos: readonly ReturnType<typeof anuncio>[],
  nextCursor?: string,
): Record<string, unknown> {
  return respuestaCruda({
    cambios: avisos.map((a) => a.cambio),
    shows: avisos.map((a) => a.show),
    hasMore: nextCursor !== undefined,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  });
}

const soloPagina = (avisos: readonly ReturnType<typeof anuncio>[]): Listas =>
  new Map([["upcoming|", paginaDe(avisos)]]);

const clave = (id: string, plataforma = "netflix") =>
  claveDeOferta(imdb(id), plataforma, "subscription", null);

interface FotoDisponibilidad {
  readonly ofertas: readonly unknown[];
  readonly opciones: readonly unknown[];
  readonly eventos: readonly unknown[];
}
const disponibilidad = (base: BaseEnMemoria) => {
  const f = base.foto() as FotoDisponibilidad;
  return { ofertas: f.ofertas, opciones: f.opciones, eventos: f.eventos };
};

// ── 1 · Un anuncio nuevo ─────────────────────────────────────────────────────

describe("un anuncio nuevo es una fila de anuncios, y nada más", () => {
  it("con link: fecha, link, first_* = esta observación y el run que lo vio", async () => {
    const mundo = crearMundo();
    const { salida, runId } = await ejecutar(mundo, {
      listas: soloPagina([anuncio({ id: "1", estreno: en(10) })]),
    });
    expect(estado(salida)).toBe("succeeded");
    expect(mundo.base.anuncios()).toEqual([
      {
        imdbId: imdb("1"),
        platformId: "netflix",
        offerType: "subscription",
        addon: null,
        announcedFor: iso(en(10)),
        firstAnnouncedFor: iso(en(10)),
        link: "https://netflix.test/1",
        firstSeenAt: T.toISOString(),
        lastSeenAt: T.toISOString(),
        lastSeenRunId: runId,
      },
    ]);
    expect(salida.anunciosGuardados).toMatchObject({ observados: 1, nuevos: 1 });
  });

  it("⚖️ no sintetiza opción, no crea oferta padre y no emite evento", async () => {
    const mundo = crearMundo();
    const { salida } = await ejecutar(mundo, {
      listas: soloPagina([anuncio({ id: "1", estreno: en(10) })]),
    });
    expect(disponibilidad(mundo.base)).toEqual({
      ofertas: [],
      opciones: [],
      eventos: [],
    });
    expect(salida.informe?.eventos).toEqual({});
    expect(salida.informe?.descartes).toEqual([]);
    // El título sí: su identidad es un dato real.
    expect((mundo.base.foto() as { titulos: string[] }).titulos).toEqual([imdb("1")]);
  });

  it("📏 sin link: se guarda con link NULL, sin descarte y sin inventar nada", async () => {
    const mundo = crearMundo();
    const { salida } = await ejecutar(mundo, {
      listas: soloPagina([
        anuncio({ id: "2", estreno: en(4), servicio: "prime", link: null }),
      ]),
    });
    expect(mundo.base.anuncios()).toMatchObject([
      { imdbId: imdb("2"), platformId: "prime", link: null, announcedFor: iso(en(4)) },
    ]);
    expect(salida.informe?.descartes).toEqual([]);
    expect(salida.anunciosGuardados).toMatchObject({ nuevos: 1, sinEnlace: 1 });
    expect(salida.anuncios?.sinEnlace.total).toBe(1);
  });
});

// ── 2 · 📏 La fila 50, completa ──────────────────────────────────────────────

describe("📏 las tres páginas reales de la fila 50", () => {
  const FILA_50 = JSON.parse(
    readFileSync(
      join(
        import.meta.dirname,
        "..",
        "fixtures",
        "changes",
        "upcoming-fila50-completa.json",
      ),
      "utf8",
    ),
  ) as {
    readonly meta: { readonly ahora: string };
    readonly paginas: readonly {
      readonly changes: readonly {
        readonly showId: string;
        readonly service: { readonly id: string };
        readonly link?: string;
        readonly timestamp: number;
      }[];
      readonly shows: Readonly<Record<string, { readonly imdbId: string }>>;
      readonly nextCursor?: string;
    }[];
  };
  const T50 = new Date(FILA_50.meta.ahora);
  const listas: Listas = new Map([
    ["upcoming|", FILA_50.paginas[0]],
    [`upcoming|${FILA_50.paginas[0]?.nextCursor ?? "?"}`, FILA_50.paginas[1]],
    [`upcoming|${FILA_50.paginas[1]?.nextCursor ?? "?"}`, FILA_50.paginas[2]],
  ]);

  it("63 avisos, 9 repetidos de frontera → 54 anuncios, 0 conflictos", async () => {
    const mundo = crearMundo();
    const { salida } = await ejecutar(mundo, { listas, ahora: T50 });
    expect(estado(salida)).toBe("succeeded");
    expect(salida.anuncios).toMatchObject({ avisos: 63, repetidos: 9 });
    expect(mundo.base.anuncios()).toHaveLength(54);
    expect(salida.anunciosGuardados).toMatchObject({
      observados: 63,
      nuevos: 54,
      mismaObservacion: 9,
      conflictos: [],
    });
  });

  it("📏 Prime: los 3 anuncios sin link quedan guardados con link NULL", async () => {
    const mundo = crearMundo();
    await ejecutar(mundo, { listas, ahora: T50 });
    const prime = mundo.base.anuncios().filter((a) => a.platformId === "prime");
    expect(prime).toHaveLength(3);
    expect(prime.every((a) => a.link === null)).toBe(true);
    expect(mundo.base.anuncios().filter((a) => a.link === null)).toHaveLength(3);
  });

  it("cada anuncio guarda la fecha del proveedor, y hbo es max", async () => {
    const mundo = crearMundo();
    await ejecutar(mundo, { listas, ahora: T50 });
    const guardados = new Map(
      mundo.base
        .anuncios()
        .map((a) => [`${a.imdbId}|${a.platformId}`, a.announcedFor] as const),
    );
    for (const p of FILA_50.paginas) {
      for (const c of p.changes) {
        const plataforma = c.service.id === "hbo" ? "max" : c.service.id;
        const fecha = guardados.get(
          `${p.shows[c.showId]?.imdbId ?? "?"}|${plataforma}`,
        );
        expect(fecha).toBe(new Date(c.timestamp * 1000).toISOString());
      }
    }
    expect(mundo.base.anuncios().some((a) => a.platformId === "hbo")).toBe(false);
  });

  it("⚖️ ni un evento: antes eran 50 `announced` y 1 `added` falso", async () => {
    const mundo = crearMundo();
    const { salida } = await ejecutar(mundo, { listas, ahora: T50 });
    expect(salida.informe?.eventos).toEqual({});
    expect(disponibilidad(mundo.base).eventos).toEqual([]);
    // 📏 `tt9000044` «Título ficticio 068»: ya disponible en Netflix, anunciada igual.
    expect(salida.informe?.anunciosSobreOfertaDisponible).toBe(1);
    expect(mundo.base.anuncios().filter((a) => a.imdbId === "tt9000044")).toHaveLength(
      1,
    );
  });

  it("repetirla con el mismo ahora no cambia nada: 63 veces la misma observación", async () => {
    const mundo = crearMundo();
    await ejecutar(mundo, { listas, ahora: T50 });
    const antes = mundo.base.foto();
    const { salida } = await ejecutar(mundo, { listas, ahora: T50 });
    expect(mundo.base.foto()).toEqual(antes);
    expect(salida.anunciosGuardados).toMatchObject({
      observados: 63,
      mismaObservacion: 63,
      nuevos: 0,
    });
    expect(salida.horizonte?.desaparecidas).toBe(0);
  });
});

// ── 3 · Observaciones sucesivas de la misma identidad ────────────────────────

describe("la misma oferta observada otra vez", () => {
  it("repetida entre dos páginas: la segunda es la misma observación", async () => {
    const mundo = crearMundo();
    const a = anuncio({ id: "3", estreno: en(5) });
    const { salida } = await ejecutar(mundo, {
      listas: new Map([
        ["upcoming|", paginaDe([a], "c1")],
        ["upcoming|c1", paginaDe([a])],
      ]),
    });
    expect(mundo.base.anuncios()).toHaveLength(1);
    expect(salida.anunciosGuardados).toMatchObject({
      observados: 2,
      nuevos: 1,
      mismaObservacion: 1,
      conflictos: [],
    });
  });

  it("al día siguiente, igual: misma fila, solo avanzan last_seen_at y el run", async () => {
    const mundo = crearMundo();
    const listas = soloPagina([anuncio({ id: "4", estreno: en(10) })]);
    const primera = await ejecutar(mundo, { listas });
    const segunda = await ejecutar(mundo, { listas, ahora: en(1) });
    expect(segunda.runId).not.toBe(primera.runId);
    expect(mundo.base.anuncios()).toEqual([
      expect.objectContaining({
        announcedFor: iso(en(10)),
        firstAnnouncedFor: iso(en(10)),
        firstSeenAt: T.toISOString(),
        lastSeenAt: en(1).toISOString(),
        lastSeenRunId: segunda.runId,
      }),
    ]);
    expect(segunda.salida.anunciosGuardados).toMatchObject({ sinCambios: 1 });
  });

  it("aplazamiento: la fecha cambia en la MISMA fila; la primera fecha se conserva", async () => {
    const mundo = crearMundo();
    await ejecutar(mundo, {
      listas: soloPagina([anuncio({ id: "5", estreno: en(10) })]),
    });
    const { salida } = await ejecutar(mundo, {
      listas: soloPagina([anuncio({ id: "5", estreno: en(15) })]),
      ahora: en(1),
    });
    expect(mundo.base.anuncios()).toEqual([
      expect.objectContaining({
        announcedFor: iso(en(15)),
        firstAnnouncedFor: iso(en(10)),
        firstSeenAt: T.toISOString(),
        lastSeenAt: en(1).toISOString(),
      }),
    ]);
    expect(salida.anunciosGuardados).toMatchObject({
      actualizados: 1,
      fechasCambiadas: 1,
    });
    // Un aplazamiento no es un cambio de disponibilidad.
    expect(salida.informe?.eventos).toEqual({});
    expect(salida.horizonte?.desaparecidas).toBe(0);
  });

  it("⚖️ link 1 · mismo ciclo: un NULL posterior no borra el link conocido", async () => {
    const mundo = crearMundo();
    await ejecutar(mundo, {
      listas: soloPagina([anuncio({ id: "6", estreno: en(10) })]),
    });
    const { salida, runId } = await ejecutar(mundo, {
      listas: soloPagina([anuncio({ id: "6", estreno: en(10), link: null })]),
      ahora: en(1),
    });
    expect(mundo.base.anuncios()).toEqual([
      expect.objectContaining({
        link: "https://netflix.test/6",
        lastSeenAt: en(1).toISOString(),
        lastSeenRunId: runId,
      }),
    ]);
    expect(salida.anunciosGuardados).toMatchObject({
      sinCambios: 1,
      enlacesCambiados: 0,
      enlacesConservados: 1,
    });
  });

  it("⚖️ link 2 · mismo ciclo: un link no nulo posterior sí lo actualiza", async () => {
    const mundo = crearMundo();
    await ejecutar(mundo, {
      listas: soloPagina([anuncio({ id: "7", estreno: en(10) })]),
    });
    const { salida } = await ejecutar(mundo, {
      listas: soloPagina([
        anuncio({ id: "7", estreno: en(10), link: "https://netflix.test/7-bis" }),
      ]),
      ahora: en(1),
    });
    expect(mundo.base.anuncios()[0]?.link).toBe("https://netflix.test/7-bis");
    expect(salida.anunciosGuardados).toMatchObject({
      actualizados: 1,
      enlacesCambiados: 1,
    });
    // Y donde solo había NULL (📏 Prime), también.
    const prime = crearMundo();
    await ejecutar(prime, {
      listas: soloPagina([
        anuncio({ id: "8", estreno: en(10), servicio: "prime", link: null }),
      ]),
    });
    await ejecutar(prime, {
      listas: soloPagina([anuncio({ id: "8", estreno: en(10), servicio: "prime" })]),
      ahora: en(1),
    });
    expect(prime.base.anuncios()[0]?.link).toBe("https://prime.test/8");
  });

  it("⚖️ link 3 · ciclo nuevo: no hereda el link del ciclo anterior, aunque llegue NULL", async () => {
    const mundo = crearMundo();
    await ejecutar(mundo, {
      listas: soloPagina([
        anuncio({ id: "9", estreno: en(2), link: "https://netflix.test/9-t1" }),
      ]),
    });
    const { salida } = await ejecutar(mundo, {
      listas: soloPagina([anuncio({ id: "9", estreno: en(30), link: null })]),
      ahora: en(5),
    });
    expect(mundo.base.anuncios()).toEqual([
      expect.objectContaining({
        link: null,
        announcedFor: iso(en(30)),
        firstAnnouncedFor: iso(en(30)),
        firstSeenAt: en(5).toISOString(),
      }),
    ]);
    expect(salida.anunciosGuardados).toMatchObject({ nuevosCiclos: 1 });
  });

  it("fuera de orden: una observación más vieja no toca la fila", async () => {
    const mundo = crearMundo();
    await ejecutar(mundo, {
      listas: soloPagina([anuncio({ id: "7", estreno: en(12) })]),
      ahora: en(1),
    });
    const antes = mundo.base.anuncios();
    const { salida } = await ejecutar(mundo, {
      listas: soloPagina([anuncio({ id: "7", estreno: en(9), link: null })]),
      ahora: T,
    });
    expect(mundo.base.anuncios()).toEqual(antes);
    expect(salida.anunciosGuardados).toMatchObject({ fueraDeOrden: 1 });
  });

  it("ciclo nuevo: si la fecha anterior ya pasó, first_* se reinician", async () => {
    const mundo = crearMundo();
    await ejecutar(mundo, {
      listas: soloPagina([anuncio({ id: "18", estreno: en(2) })]),
    });
    const { salida, runId } = await ejecutar(mundo, {
      listas: soloPagina([
        anuncio({ id: "18", estreno: en(30), link: "https://netflix.test/8-t2" }),
      ]),
      ahora: en(5),
    });
    expect(mundo.base.anuncios()).toEqual([
      expect.objectContaining({
        announcedFor: iso(en(30)),
        firstAnnouncedFor: iso(en(30)),
        link: "https://netflix.test/8-t2",
        firstSeenAt: en(5).toISOString(),
        lastSeenAt: en(5).toISOString(),
        lastSeenRunId: runId,
      }),
    ]);
    expect(salida.anunciosGuardados).toMatchObject({ nuevosCiclos: 1 });
  });
});

// ── 4 · Conflictos ───────────────────────────────────────────────────────────

describe("dos fechas futuras para la misma oferta en la misma ejecución", () => {
  it("en la misma página: se conserva la primera y se reporta la segunda", async () => {
    const mundo = crearMundo();
    const { salida } = await ejecutar(mundo, {
      listas: soloPagina([
        anuncio({ id: "9", estreno: en(10) }),
        anuncio({ id: "9", estreno: en(11) }),
      ]),
    });
    expect(estado(salida)).toBe("succeeded");
    expect(mundo.base.anuncios().map((a) => a.announcedFor)).toEqual([iso(en(10))]);
    expect(salida.anunciosGuardados?.conflictos).toEqual([
      {
        clave: clave("9"),
        vigente: { anunciadoPara: iso(en(10)), enlace: "https://netflix.test/9" },
        descartado: { anunciadoPara: iso(en(11)), enlace: "https://netflix.test/9" },
      },
    ]);
  });

  it("entre páginas: la segunda página no pisa lo que confirmó la primera", async () => {
    const mundo = crearMundo();
    const { salida } = await ejecutar(mundo, {
      listas: new Map([
        ["upcoming|", paginaDe([anuncio({ id: "10", estreno: en(10) })], "c1")],
        ["upcoming|c1", paginaDe([anuncio({ id: "10", estreno: en(20) })])],
      ]),
    });
    expect(mundo.base.anuncios().map((a) => a.announcedFor)).toEqual([iso(en(10))]);
    expect(salida.anunciosGuardados?.conflictos).toHaveLength(1);
    expect(salida.anunciosGuardados?.conflictos[0]?.descartado.anunciadoPara).toBe(
      iso(en(20)),
    );
  });

  it("reproducirla da el mismo conflicto y deja la misma fila", async () => {
    const mundo = crearMundo();
    const listas = soloPagina([
      anuncio({ id: "11", estreno: en(10) }),
      anuncio({ id: "11", estreno: en(11) }),
    ]);
    const original = await ejecutar(mundo, { listas });
    const antes = mundo.base.foto();
    const replay = await ejecutar(mundo, { listas, vincular: false });
    expect(mundo.base.foto()).toEqual(antes);
    expect(replay.salida.anunciosGuardados?.conflictos).toEqual(
      original.salida.anunciosGuardados?.conflictos,
    );
  });
});

// ── 5 · Desapariciones ───────────────────────────────────────────────────────

describe("desapariciones: solo con el recorrido completo, y solo se cuentan", () => {
  async function conocidos(mundo: Mundo) {
    return ejecutar(mundo, {
      listas: soloPagina([
        anuncio({ id: "20", estreno: en(10) }),
        anuncio({ id: "21", estreno: en(12) }),
        anuncio({ id: "22", estreno: en(14), servicio: "skyshowtime" }),
      ]),
    });
  }

  it("completo: cuenta el no observado por su run; SkyShowtime va aparte", async () => {
    const mundo = crearMundo();
    await conocidos(mundo);
    const antes = mundo.base.anuncios();
    const { salida } = await ejecutar(mundo, {
      listas: soloPagina([anuncio({ id: "20", estreno: en(10) })]),
      ahora: en(1),
    });
    expect(salida.horizonte).toEqual({
      completo: true,
      desaparecidas: 1,
      muestra: [clave("21")],
      fueraDeCobertura: 1,
    });
    // Medir no es actuar: el 21 y el 22 siguen tal cual.
    const despues = mundo.base.anuncios();
    expect(despues.find((a) => a.imdbId === imdb("21"))).toEqual(
      antes.find((a) => a.imdbId === imdb("21")),
    );
    expect(despues.find((a) => a.imdbId === imdb("22"))).toEqual(
      antes.find((a) => a.imdbId === imdb("22")),
    );
    expect(salida.informe?.eventos).toEqual({});
  });

  it("incompleto (corte de tope): desaparecidas = null, y la página confirmada queda", async () => {
    const mundo = crearMundo();
    await conocidos(mundo);
    const { salida } = await ejecutar(mundo, {
      tope: 1,
      ahora: en(1),
      listas: new Map([
        ["upcoming|", paginaDe([anuncio({ id: "20", estreno: en(11) })], "c1")],
        ["upcoming|c1", paginaDe([anuncio({ id: "21", estreno: en(12) })])],
      ]),
    });
    expect(estado(salida)).toBe("budget_stopped");
    expect(salida.horizonte).toEqual({
      completo: false,
      desaparecidas: null,
      muestra: [],
      fueraDeCobertura: null,
    });
    // La página 1 se confirmó: su aplazamiento ya está escrito.
    expect(
      mundo.base.anuncios().find((a) => a.imdbId === imdb("20"))?.announcedFor,
    ).toBe(iso(en(11)));
    // El corte no deja informe: los guardados de la ejecución no se afirman.
    expect(salida.anunciosGuardados).toBeNull();
  });

  it("un anuncio vencido no cuenta: su fecha ya no cae en el horizonte", async () => {
    const mundo = crearMundo();
    await ejecutar(mundo, {
      listas: soloPagina([anuncio({ id: "23", estreno: en(1) })]),
    });
    const { salida } = await ejecutar(mundo, {
      listas: soloPagina([anuncio({ id: "24", estreno: en(10) })]),
      ahora: en(2),
    });
    expect(salida.horizonte?.desaparecidas).toBe(0);
  });

  it("el SQL lleva las dos condiciones que la base en memoria imita", () => {
    // La base en memoria reimplementa la consulta: esto ata su lógica al texto.
    const sql = SQL_ANUNCIOS_NO_OBSERVADOS.replace(/\s+/g, " ");
    expect(sql).toContain("vigente.last_seen_at < $4::timestamptz");
    expect(sql).toContain("vigente.last_seen_run_id IS DISTINCT FROM $5::bigint");
    expect(sql).toContain("vigente.announced_for >= $2::timestamptz");
    expect(sql).toContain("vigente.announced_for <= $3::timestamptz");
    expect(sql).not.toMatch(/DELETE|UPDATE|INSERT/);
  });

  it("⚖️ una reproducción (run NULL) no cuenta como desaparecido lo que ya vio la original", async () => {
    const mundo = crearMundo();
    const listas = soloPagina([
      anuncio({ id: "25", estreno: en(10) }),
      anuncio({ id: "26", estreno: en(12) }),
    ]);
    await ejecutar(mundo, { listas });
    const { salida } = await ejecutar(mundo, { listas, vincular: false });
    // Con solo `last_seen_run_id IS DISTINCT FROM NULL`, serían 2.
    expect(salida.horizonte?.desaparecidas).toBe(0);
    expect(salida.anunciosGuardados).toMatchObject({ mismaObservacion: 2 });
  });

  it("en un ensayo (run NULL), lo observado queda con run NULL y no desaparece", async () => {
    const mundo = crearMundo();
    await conocidos(mundo);
    const { salida } = await ejecutar(mundo, {
      listas: soloPagina([anuncio({ id: "20", estreno: en(10) })]),
      ahora: en(1),
      vincular: false,
    });
    expect(mundo.base.anuncios().find((a) => a.imdbId === imdb("20"))).toMatchObject({
      lastSeenAt: en(1).toISOString(),
      lastSeenRunId: null,
    });
    expect(salida.horizonte).toMatchObject({
      desaparecidas: 1,
      muestra: [clave("21")],
    });
  });
});

// ── 6 · Idempotencia ─────────────────────────────────────────────────────────

describe("idempotencia", () => {
  const listas = new Map([
    [
      "upcoming|",
      paginaDe(
        [
          anuncio({ id: "30", estreno: en(3) }),
          anuncio({ id: "31", estreno: en(9), servicio: "prime", link: null }),
        ],
        "c1",
      ),
    ],
    [
      "upcoming|c1",
      paginaDe([anuncio({ id: "32", estreno: en(20), servicio: "hbo" })]),
    ],
  ]);

  it("el mismo recorrido dos veces con el mismo ahora: base idéntica", async () => {
    const mundo = crearMundo();
    await ejecutar(mundo, { listas });
    const antes = mundo.base.foto();
    await ejecutar(mundo, { listas });
    expect(mundo.base.foto()).toEqual(antes);
  });

  it("un corte y un recorrido nuevo dejan los mismos anuncios que uno limpio", async () => {
    const limpio = crearMundo();
    await ejecutar(limpio, { listas });
    const cortado = crearMundo();
    await ejecutar(cortado, { listas, tope: 1 });
    await ejecutar(cortado, { listas });
    const sinRun = (m: Mundo) =>
      m.base.anuncios().map((a) => ({ ...a, lastSeenRunId: "—" }));
    expect(sinRun(cortado)).toEqual(sinRun(limpio));
  });

  it("una página que falla al escribir su anuncio revierte entera, anuncio incluido", async () => {
    const mundo = crearMundo();
    mundo.base.fallarUnaVezEn((t) =>
      t.startsWith("INSERT INTO external_availability_announcements"),
    );
    const { salida } = await ejecutar(mundo, {
      listas: soloPagina([anuncio({ id: "33", estreno: en(3) })]),
    });
    expect(estado(salida)).toBe("failed");
    expect(mundo.base.anuncios()).toEqual([]);
    expect((mundo.base.foto() as { titulos: string[] }).titulos).toEqual([]);
  });
});

// ── 7 · deltas y expiring no escriben anuncios ───────────────────────────────

describe("solo `upcoming` escribe anuncios", () => {
  it("una oferta real del snapshot se sigue escribiendo como estado, sin evento", async () => {
    // El show anunciado ya lista otra oferta disponible (Prime): es catálogo
    // observado, línea base. El anuncio (Netflix) va a su tabla.
    const mundo = crearMundo();
    const { salida } = await ejecutar(mundo, {
      listas: soloPagina([
        anuncio({
          id: "40",
          estreno: en(6),
          opciones: [
            {
              service: "prime",
              type: "subscription",
              link: "https://prime.test/40",
              quality: "hd",
              availableSince: seg(en(-100)),
            },
          ],
        }),
      ]),
    });
    expect(salida.informe?.ofertasDeLineaBase).toBe(1);
    expect(salida.informe?.eventos).toEqual({});
    expect(mundo.base.opcion("https://prime.test/40")).toBeDefined();
    expect(mundo.base.opcion("https://netflix.test/40")).toBeUndefined();
    expect(mundo.base.anuncios().map((a) => a.platformId)).toEqual(["netflix"]);
  });
});
