/**
 * `updated` contra **datos reales**, sin red:
 *
 *   · 📏 `updated-dia-pagina-{1,2}.json` — recortes de `raw/055` y `raw/056`:
 *     las dos páginas de una ventana real de 24 h (2026-09-20 → 21), pedida
 *     la segunda con el cursor de la primera.
 *   · 📏 `updated-sin-ventana.json` — recorte de `raw/022`: la página 1 sin
 *     `from`/`to` (avisos del 22 al 24 de agosto).
 *   · 📏 `updated-pares-reales.json` — el mismo show observado el 21 y el 24 de
 *     septiembre. De 322 ofertas vistas en dos días distintos solo cambiaron
 *     10: 8 `video_link` de Max, 1 precio de Apple y 1 subtítulos de Disney+.
 *     Aquí están un ejemplo de cada.
 *
 * ⚠️ Un aviso `updated` no dice qué cambió, y el corpus no tiene el «antes» de
 * ninguno: todos los snapshots de ese día son **posteriores** a sus avisos.
 * Estos tests fijan la forma y la distribución reales; qué cambia se mide con
 * los pares.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { foto, observarUpdated, sembrar } from "./ayudas-updated.ts";
import { crearBaseEnMemoria } from "./base-en-memoria.ts";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "changes");

interface Cambio {
  readonly changeType: string;
  readonly showId: string;
  readonly service: { readonly id: string };
  readonly streamingOptionType: string;
  readonly addon?: { readonly id: string };
  readonly link?: string;
  readonly timestamp: number;
}
interface Pagina {
  readonly meta: {
    readonly ventana: { readonly from: number; readonly to: number } | null;
    readonly cursorDeEntrada: string | null;
  };
  readonly body: {
    readonly changes: readonly Cambio[];
    readonly shows: Readonly<Record<string, { readonly id: string }>>;
    readonly hasMore: boolean;
    readonly nextCursor?: string;
  };
}
interface Par {
  readonly nombre: string;
  readonly antes: {
    readonly observadoEn: string;
    readonly show: { readonly id: string };
  };
  readonly despues: {
    readonly observadoEn: string;
    readonly show: { readonly id: string };
  };
}

const leer = <T>(nombre: string): T =>
  JSON.parse(readFileSync(join(FIXTURES, nombre), "utf8")) as T;

const P1 = leer<Pagina>("updated-dia-pagina-1.json");
const P2 = leer<Pagina>("updated-dia-pagina-2.json");
const SIN_VENTANA = leer<Pagina>("updated-sin-ventana.json");
const PARES = leer<{ readonly pares: readonly Par[] }>(
  "updated-pares-reales.json",
).pares;

/** El fin de la ventana medida: el `ahora` de aquella ejecución. */
const AHORA = new Date((P1.meta.ventana?.to ?? 0) * 1000);
const UNA_HORA_ANTES = new Date(AHORA.getTime() - 3_600_000);

const DIA = [P1.body, P2.body] as unknown as Record<string, unknown>[];

function recuento(cambios: readonly Cambio[], clave: (c: Cambio) => string) {
  const r: Record<string, number> = {};
  for (const c of cambios) r[clave(c)] = (r[clave(c)] ?? 0) + 1;
  return r;
}

describe("la forma real de updated (raw/055–056)", () => {
  const cambios = [...P1.body.changes, ...P2.body.changes];

  it("40 avisos en 24 h, en dos páginas unidas por su cursor", () => {
    expect(cambios).toHaveLength(40);
    expect(P1.body.hasMore).toBe(true);
    expect(P2.meta.cursorDeEntrada).toBe(P1.body.nextCursor);
    expect(P2.body.hasMore).toBe(false);
  });

  it("todos traen su show y su link; ninguno trae campos, ni antes, ni después", () => {
    for (const c of cambios) {
      const pagina = P1.body.changes.includes(c) ? P1 : P2;
      expect(pagina.body.shows[c.showId]).toBeDefined();
      expect(c.link).toBeDefined();
      expect(Object.keys(c).sort()).toEqual(
        [
          "changeType",
          "itemType",
          "link",
          "service",
          "showId",
          "showType",
          "streamingOptionType",
          "timestamp",
          ...(c.addon === undefined ? [] : ["addon"]),
        ].sort(),
      );
    }
  });

  it("31 de 40 son de Apple: 25 buy, 5 rent y 1 addon", () => {
    expect(recuento(cambios, (c) => c.service.id)).toEqual({
      apple: 31,
      skyshowtime: 5,
      netflix: 4,
    });
    expect(
      recuento(cambios, (c) => `${c.service.id}/${c.streamingOptionType}`),
    ).toEqual({
      "apple/buy": 25,
      "apple/rent": 5,
      "apple/addon": 1,
      "skyshowtime/subscription": 5,
      "netflix/subscription": 4,
    });
  });

  it("22 de los 25 buy de Apple llegan en 16 minutos: un lote, no 22 cambios sueltos", () => {
    const compras = cambios
      .filter((c) => c.service.id === "apple" && c.streamingOptionType === "buy")
      .map((c) => c.timestamp)
      .sort((a, b) => a - b);
    const lote = compras.filter((t) => t >= 1789928880 && t <= 1789929860);
    expect(lote).toHaveLength(22);
    expect(Math.max(...lote) - Math.min(...lote)).toBeLessThanOrEqual(16 * 60);
  });

  it("raw/022 (agosto) no tiene Apple: Prime 13, SkyShowtime 8 y Netflix 4", () => {
    expect(recuento(SIN_VENTANA.body.changes, (c) => c.service.id)).toEqual({
      prime: 13,
      skyshowtime: 8,
      netflix: 4,
    });
    expect(recuento(SIN_VENTANA.body.changes, (c) => c.streamingOptionType)).toEqual({
      subscription: 15,
      buy: 4,
      addon: 3,
      rent: 3,
    });
  });
});

describe("el pipeline sobre el día real", () => {
  it("sin catálogo: los 40 son fuera de catálogo y no se escribe ni un título", async () => {
    const base = crearBaseEnMemoria();
    const { clasificacion, informe } = await observarUpdated(base, AHORA, DIA);
    expect(clasificacion.avisos).toBe(40);
    expect(clasificacion.porResultado.fuera_de_catalogo).toBe(40);
    expect(informe.titulosFueraDeCatalogo).toBe(38);
    expect(foto(base).titulos).toEqual([]);
  });

  it("con esos mismos shows ya en la base: todo es no-op, sin un evento", async () => {
    const base = crearBaseEnMemoria();
    await sembrar(base, UNA_HORA_ANTES, [
      ...Object.values(P1.body.shows),
      ...Object.values(P2.body.shows),
    ]);
    const antes = foto(base, false);
    const { clasificacion, informe } = await observarUpdated(base, AHORA, DIA);
    expect(clasificacion.porResultado.no_op).toBe(40);
    expect(clasificacion.porResultado.evento).toBe(0);
    expect(clasificacion.camposCambiados).toEqual({});
    expect(informe.eventos).toEqual({});
    expect(foto(base, false).opciones).toEqual(antes.opciones);
    expect(clasificacion.porGrupo["apple/buy"]).toMatchObject({
      avisos: 25,
      resultados: { no_op: 25 },
      preciosCambiados: 0,
    });
  });

  it("idempotencia sobre el día real: la segunda pasada es la misma observación", async () => {
    const base = crearBaseEnMemoria();
    await sembrar(base, UNA_HORA_ANTES, [
      ...Object.values(P1.body.shows),
      ...Object.values(P2.body.shows),
    ]);
    await observarUpdated(base, AHORA, DIA);
    const tras1 = foto(base);
    const { clasificacion } = await observarUpdated(base, AHORA, DIA);
    expect(clasificacion.porResultado.misma_observacion).toBe(40);
    expect(foto(base)).toEqual(tras1);
  });
});

describe("los pares reales: qué cambia de verdad entre dos observaciones", () => {
  /** El par como aviso `updated` sobre la oferta que cambió. */
  async function observarPar(par: Par, oferta: { service: string; type: string }) {
    const base = crearBaseEnMemoria();
    await sembrar(base, new Date(par.antes.observadoEn), [par.antes.show]);
    const ahora = new Date(par.despues.observadoEn);
    return observarUpdated(base, ahora, [
      {
        changes: [
          {
            changeType: "updated",
            itemType: "show",
            showId: par.despues.show.id,
            showType: "movie",
            service: { id: oferta.service, name: oferta.service },
            streamingOptionType: oferta.type,
            timestamp: Math.floor(ahora.getTime() / 1000) - 3600,
          },
        ],
        shows: { [par.despues.show.id]: par.despues.show },
        hasMore: false,
      },
    ]);
  }
  const par = (prefijo: string): Par => {
    const p = PARES.find((x) => x.nombre.startsWith(prefijo));
    if (p === undefined) throw new Error(`sin par ${prefijo}`);
    return p;
  };

  it("Título ficticio 112, Apple buy: 9.99 → 4.99 EUR es un evento changed[price]", async () => {
    const { clasificacion } = await observarPar(par("Título ficticio 112"), {
      service: "apple",
      type: "buy",
    });
    expect(clasificacion.porResultado.evento).toBe(1);
    expect(clasificacion.eventos.camposDeAvisos).toEqual({ price: 1 });
    expect(clasificacion.precios).toMatchObject({ cambios: 1, bajan: 1 });
    expect(clasificacion.precios.muestra[0]).toMatchObject({
      antes: { importe: "9.99", moneda: "EUR" },
      despues: { importe: "4.99", moneda: "EUR" },
    });
    expect(clasificacion.eventos.deAcompanantes).toEqual({});
  });

  it("Título ficticio 095, Max: solo cambia video_link; se persiste y no hay evento", async () => {
    const { clasificacion, informe } = await observarPar(par("Título ficticio 095"), {
      service: "hbo",
      type: "subscription",
    });
    expect(clasificacion.porResultado.solo_metadatos).toBe(1);
    expect(clasificacion.camposCambiados).toEqual({ video_link: 1 });
    expect(informe.eventos).toEqual({});
  });

  it("Título ficticio 045, Disney+: subtítulos nuevos son changed[subtitle_languages]", async () => {
    const { clasificacion } = await observarPar(par("Título ficticio 045"), {
      service: "disney",
      type: "subscription",
    });
    expect(clasificacion.porResultado.evento).toBe(1);
    expect(clasificacion.eventos.camposDeAvisos).toEqual({ subtitle_languages: 1 });
  });
});
