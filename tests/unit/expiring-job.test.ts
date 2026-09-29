/**
 * El job de `expiring` en modo REAL (`vincularEventos: true`), **sin red y sin
 * base de datos**: el libro y la base en memoria, como en
 * `deltas-checkpoint.test.ts`.
 *
 * Dos fuentes de datos:
 *
 *   · 📏 **Recortes del Spike 1** (`tests/fixtures/changes/expiring-*.json`, de
 *     `raw/023` y `raw/026`): la forma real de `/changes?change_type=expiring`.
 *   · Páginas sintéticas para lo que el Spike no capturó: cortes de tope,
 *     cambios de fecha y ofertas que desaparecen del horizonte.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { crearLibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import type { LibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import { leerPresupuesto } from "../../jobs/ops/presupuesto.ts";
import type { FuenteDeCuota, Transporte } from "../../jobs/ops/transporte.ts";
import { transaccionPorPagina } from "../../jobs/pipelines/deltas/job.ts";
import { ventanaEnSegundos } from "../../jobs/pipelines/deltas/manifiesto.ts";
import { ventanaHaciaDelante } from "../../jobs/pipelines/deltas/origen.ts";
import { ejecutarJobDeExpiring } from "../../jobs/pipelines/expiring/job.ts";
import { claveDeOferta } from "../../jobs/pipelines/seed/filas.ts";
import { plataformaDesdeFuente } from "../../jobs/pipelines/seed/plataformas.ts";
import { conexionDeDatos } from "./ayudas-checkpoint.ts";
import { respuestaCruda, showCrudo } from "./ayudas-deltas.ts";
import type { BaseEnMemoria } from "./base-en-memoria.ts";
import { crearBaseEnMemoria } from "./base-en-memoria.ts";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "changes");
const DIA = 86_400_000;

const CUOTA = {
  "x-quota-used": "120",
  "x-quota-granted": "1000",
  "x-quota-reset": "2026-10-01T00:00:00Z",
};

interface Fixture {
  readonly meta: { readonly ts_utc: string };
  readonly body: {
    readonly changes: readonly {
      readonly showId: string;
      readonly service: { readonly id: string };
      readonly streamingOptionType: string;
      readonly addon?: { readonly id: string };
      readonly link?: string;
      readonly timestamp: number;
    }[];
    readonly shows: Readonly<Record<string, { readonly imdbId: string }>>;
    readonly nextCursor?: string;
  };
}

function fixture(nombre: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURES, nombre), "utf8")) as Fixture;
}

const PAGINA_1 = fixture("expiring-pagina-1.json");
const PAGINA_PRIME = fixture("expiring-prime-completa.json");
/** El instante de la captura de `raw/023`: el `ahora` del recorrido medido. */
const T_SPIKE = new Date(PAGINA_1.meta.ts_utc);

const T = new Date("2026-09-24T10:00:00.000Z");
const en = (dias: number, desde = T) => new Date(desde.getTime() + dias * DIA);
const seg = (d: Date) => Math.floor(d.getTime() / 1000);

// ── Dobles ───────────────────────────────────────────────────────────────────

type Listas = ReadonlyMap<string, unknown>;

/** Sirve por `(change_type, cursor)`, pasando por la fuente de cuota como el real. */
function servidor(listas: Listas) {
  const urls: URL[] = [];
  const crear =
    (fuente: FuenteDeCuota): Transporte =>
    async (url) => {
      await fuente.pedirCuota();
      const u = new URL(url);
      urls.push(u);
      const clave = `${u.searchParams.get("change_type") ?? "?"}|${u.searchParams.get("cursor") ?? ""}`;
      const cuerpo = listas.get(clave);
      if (cuerpo === undefined) throw new Error(`sin página para ${clave}`);
      return new Response(JSON.stringify(cuerpo), {
        status: 200,
        headers: { "content-type": "application/json", ...CUOTA },
      });
    };
  return { crear, urls };
}

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
    readonly tope?: number | null;
  },
) {
  const datos = conexionDeDatos(mundo.base, mundo.libro);
  const red = servidor(entrada.listas);
  const tope = entrada.tope === undefined ? 12 : entrada.tope;
  const salida = await ejecutarJobDeExpiring({
    // El destino histórico, declarado: el régimen por defecto es el estricto.
    regimen: "historico",
    ejecutorOps: mundo.libro.ejecutor,
    ejecutorDatos: datos.ejecutor,
    transaccion: transaccionPorPagina(datos.ejecutor),
    // `null` = el presupuesto del repositorio, sin inyectar nada.
    presupuesto: leerPresupuesto(
      tope === null ? {} : { STREAMING_API_PER_RUN_CAPS: `expiring=${String(tope)}` },
    ),
    crearLlamada: red.crear,
    apiKey: "k",
    plan: { origen: "persistente" },
    ahora: entrada.ahora ?? T,
    crearRegistro: null,
    vincularEventos: true,
  });
  const runId = salida.resultado.ejecutado ? salida.resultado.runId : -1;
  const fila = mundo.libro.filas.find((f) => f.id === runId);
  return { salida, red, fila };
}

const estado = (s: { resultado: { ejecutado: boolean } }) => {
  const r = s.resultado as { ejecutado: boolean; estado?: string };
  return r.ejecutado ? r.estado : "no_ejecutado";
};

/** Un aviso `expiring` sintético con su show. */
function aviso(entrada: {
  readonly id: string;
  readonly sale: Date;
  readonly links?: readonly string[];
}) {
  const links = entrada.links ?? [`https://netflix.test/${entrada.id}`];
  return {
    cambio: {
      changeType: "expiring",
      showId: entrada.id,
      service: "netflix",
      type: "subscription",
      link: links[0] ?? "",
      timestamp: seg(entrada.sale),
    },
    show: showCrudo({
      id: entrada.id,
      imdbId: `tt${entrada.id.padStart(7, "0")}`,
      opciones: links.map((link) => ({
        service: "netflix",
        type: "subscription",
        link,
        quality: "hd",
        expiresOn: seg(entrada.sale),
      })),
    }),
  };
}

function paginaDe(
  avisos: readonly ReturnType<typeof aviso>[],
  nextCursor?: string,
): Record<string, unknown> {
  return respuestaCruda({
    cambios: avisos.map((a) => a.cambio),
    shows: avisos.map((a) => a.show),
    hasMore: nextCursor !== undefined,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  });
}

/** Las opciones de la foto de la base, con su oferta como `imdb|plataforma|tipo|addon`. */
function opcionesDe(base: BaseEnMemoria) {
  return (
    base.foto() as {
      opciones: { oferta: string; link: string; expiresAt: string | null }[];
    }
  ).opciones;
}

/** La clave natural de una oferta sintética, como la construye `claveDeOferta`. */
const clave = (id: string) =>
  claveDeOferta(`tt${id.padStart(7, "0")}`, "netflix", "subscription", null);

// ── 1 · Recorrido completo sobre los recortes del Spike 1 ───────────────────

describe("recorrido completo con los recortes del Spike 1", () => {
  const listas: Listas = new Map<string, unknown>([
    ["expiring|", PAGINA_1.body],
    [`expiring|${PAGINA_1.body.nextCursor ?? "?"}`, PAGINA_PRIME.body],
  ]);

  it("dos páginas, dos requests, succeeded y horizonte completo", async () => {
    const mundo = crearMundo();
    const { salida, red, fila } = await ejecutar(mundo, { listas, ahora: T_SPIKE });

    expect(estado(salida)).toBe("succeeded");
    expect(salida.contadores.reservasConcedidas).toBe(2);
    expect(fila?.pipeline).toBe("expiring");
    expect(fila?.requestsMade).toBe(2);
    expect(salida.checkpoint).toMatchObject({ pendiente: null, paginasConfirmadas: 2 });
    expect(fila?.checkpoint).toEqual(salida.checkpoint);
    expect(salida.horizonte?.completo).toBe(true);
    expect(typeof salida.horizonte?.desaparecidas).toBe("number");

    // La query de las dos páginas: ventana hacia delante e include_unknown_dates.
    const v = ventanaEnSegundos(ventanaHaciaDelante(T_SPIKE, 31));
    for (const u of red.urls) {
      expect(u.searchParams.get("change_type")).toBe("expiring");
      expect(u.searchParams.get("include_unknown_dates")).toBe("false");
      expect(u.searchParams.get("from")).toBe(String(v.from));
      expect(u.searchParams.get("to")).toBe(String(v.to));
    }
    expect(red.urls[1]?.searchParams.get("cursor")).toBe(PAGINA_1.body.nextCursor);
  });

  it("sobre una base vacía no hay ni un evento: todo es línea base", async () => {
    const mundo = crearMundo();
    const { salida } = await ejecutar(mundo, { listas, ahora: T_SPIKE });
    expect(salida.informe?.eventos).toEqual({});
    expect(salida.informe?.eventosEscritos).toBe(0);
    expect(salida.informe?.ofertasDeLineaBase).toBeGreaterThan(0);
    expect(mundo.base.eventos()).toEqual([]);
  });

  it("📏 cada opción nombrada queda con expires_at == timestamp del aviso", async () => {
    const mundo = crearMundo();
    await ejecutar(mundo, { listas, ahora: T_SPIKE });
    const opciones = opcionesDe(mundo.base);
    let comprobados = 0;
    for (const pagina of [PAGINA_1.body, PAGINA_PRIME.body]) {
      for (const a of pagina.changes) {
        // 📏 Por oferta Y enlace, nunca solo por enlace: en `raw/023` dos
        // addons de Prime (`flixolees` y `shadowzes`) comparten el mismo
        // deeplink del título 5000072. Es el caso del ADR 0005.
        const oferta = [
          pagina.shows[a.showId]?.imdbId,
          plataformaDesdeFuente(a.service.id),
          a.streamingOptionType,
          a.addon?.id ?? "",
        ].join("|");
        const opcion = opciones.find((o) => o.oferta === oferta && o.link === a.link);
        expect(opcion, `sin opción para ${oferta}`).toBeDefined();
        expect(opcion?.expiresAt).toBe(new Date(a.timestamp * 1000).toISOString());
        comprobados++;
      }
    }
    expect(comprobados).toBe(10);
  });

  it("📏 dos addons con el mismo enlace son dos ofertas, y solo sale la nombrada", async () => {
    const mundo = crearMundo();
    await ejecutar(mundo, { listas, ahora: T_SPIKE });
    const imdb = PAGINA_1.body.shows["5000072"]?.imdbId ?? "?";
    const delTitulo = opcionesDe(mundo.base).filter((o) =>
      o.oferta.startsWith(`${imdb}|prime|addon|`),
    );
    expect(delTitulo.map((o) => [o.oferta.split("|")[3], o.expiresAt]).sort()).toEqual([
      ["flixolees", null],
      ["shadowzes", new Date(1790028000 * 1000).toISOString()],
    ]);
  });

  it("repetir el recorrido con el mismo ahora no cambia nada", async () => {
    const mundo = crearMundo();
    await ejecutar(mundo, { listas, ahora: T_SPIKE });
    const antes = mundo.base.foto();
    const { salida } = await ejecutar(mundo, { listas, ahora: T_SPIKE });
    expect(estado(salida)).toBe("succeeded");
    expect(salida.informe?.eventos).toEqual({});
    expect(mundo.base.foto()).toEqual(antes);
  });
});

// ── 2 · Ninguna ausencia se interpreta ───────────────────────────────────────

describe("expiring no interpreta ausencias", () => {
  it("una opción que falta en el snapshot NO sube su missing_streak", async () => {
    const mundo = crearMundo();
    const dos = aviso({
      id: "1",
      sale: en(10),
      links: ["https://netflix.test/1-a", "https://netflix.test/1-b"],
    });
    await ejecutar(mundo, { listas: new Map([["expiring|", paginaDe([dos])]]) });

    // Al día siguiente el snapshot solo trae uno de los dos enlaces.
    const uno = aviso({ id: "1", sale: en(10), links: ["https://netflix.test/1-a"] });
    await ejecutar(mundo, {
      listas: new Map([["expiring|", paginaDe([uno])]]),
      ahora: en(1),
    });
    expect(mundo.base.opcion("https://netflix.test/1-b")?.missingStreak).toBe(0);
    expect(mundo.base.opcion("https://netflix.test/1-a")?.missingStreak).toBe(0);
  });

  it("un aplazamiento de la fecha es `changed` en expires_at, nunca una baja", async () => {
    const mundo = crearMundo();
    // Primero la oferta existe (línea base); luego cambia su fecha de salida.
    await ejecutar(mundo, {
      listas: new Map([["expiring|", paginaDe([aviso({ id: "2", sale: en(10) })])]]),
    });
    const { salida } = await ejecutar(mundo, {
      listas: new Map([["expiring|", paginaDe([aviso({ id: "2", sale: en(15) })])]]),
      ahora: en(1),
    });
    expect(salida.informe?.eventos).toEqual({ changed: 1 });
    expect(mundo.base.opcion("https://netflix.test/2")?.expiresAt).toEqual(
      new Date(seg(en(15)) * 1000),
    );
  });
});

// ── 3 · La medición del horizonte ────────────────────────────────────────────

describe("las desaparecidas solo se miden con el recorrido completo", () => {
  it("completo: cuenta la oferta que ya no aparece, y no la toca", async () => {
    const mundo = crearMundo();
    await ejecutar(mundo, {
      listas: new Map([
        [
          "expiring|",
          paginaDe([
            aviso({ id: "3", sale: en(10) }),
            aviso({ id: "4", sale: en(12) }),
          ]),
        ],
      ]),
    });
    const antes = mundo.base.opcion("https://netflix.test/4");

    const { salida } = await ejecutar(mundo, {
      listas: new Map([["expiring|", paginaDe([aviso({ id: "3", sale: en(10) })])]]),
      ahora: en(1),
    });
    expect(salida.horizonte).toEqual({
      completo: true,
      desaparecidas: 1,
      muestra: [clave("4")],
    });
    // Medir no es actuar: la oferta 4 sigue exactamente igual.
    expect(mundo.base.opcion("https://netflix.test/4")).toEqual(antes);
    expect(salida.informe?.eventos).toEqual({});
  });

  it("incompleto (corte de tope con hasMore): desaparecidas = null, no cero", async () => {
    const mundo = crearMundo();
    const { salida, red } = await ejecutar(mundo, {
      tope: 1,
      listas: new Map([
        ["expiring|", paginaDe([aviso({ id: "5", sale: en(3) })], "c1")],
        ["expiring|c1", paginaDe([aviso({ id: "6", sale: en(9) })])],
      ]),
    });
    expect(estado(salida)).toBe("budget_stopped");
    expect(red.urls).toHaveLength(1);
    expect(salida.checkpoint?.pendiente).toEqual({
      changeType: "expiring",
      cursorDeEntrada: "c1",
    });
    expect(salida.horizonte).toEqual({
      completo: false,
      desaparecidas: null,
      muestra: [],
    });
  });
});

// ── 4 · El tope de la medición: 12, y sin ampliarlo ──────────────────────────

describe("tope de 12 requests", () => {
  /** 13 páginas: la 12 sigue con hasMore=true. */
  const trece: Listas = new Map(
    Array.from({ length: 13 }, (_, i) => [
      `expiring|${i === 0 ? "" : `c${String(i)}`}`,
      paginaDe(
        [aviso({ id: String(100 + i), sale: en(1 + i) })],
        i < 12 ? `c${String(i + 1)}` : undefined,
      ),
    ]),
  );

  it("con hasMore al llegar a 12: se detiene, 12 requests, y lo deja dicho", async () => {
    const mundo = crearMundo();
    const { salida, red, fila } = await ejecutar(mundo, { listas: trece, tope: 12 });
    expect(estado(salida)).toBe("budget_stopped");
    expect(red.urls).toHaveLength(12);
    expect(fila?.requestsMade).toBe(12);
    expect(salida.checkpoint).toMatchObject({
      paginasConfirmadas: 12,
      pendiente: { changeType: "expiring", cursorDeEntrada: "c12" },
    });
    expect(salida.reanudacion?.cursorDeEntrada).toBe("c12");
    expect(salida.horizonte?.completo).toBe(false);
  });

  it("si la lista cabe justa en 12, cierra succeeded y completo", async () => {
    const doce: Listas = new Map(
      Array.from({ length: 12 }, (_, i) => [
        `expiring|${i === 0 ? "" : `c${String(i)}`}`,
        paginaDe(
          [aviso({ id: String(200 + i), sale: en(1 + i) })],
          i < 11 ? `c${String(i + 1)}` : undefined,
        ),
      ]),
    );
    const { salida, red } = await ejecutar(crearMundo(), { listas: doce, tope: 12 });
    expect(estado(salida)).toBe("succeeded");
    expect(red.urls).toHaveLength(12);
    expect(salida.horizonte?.completo).toBe(true);
  });

  it("tras un corte, el siguiente recorrido empieza desde el principio", async () => {
    const mundo = crearMundo();
    await ejecutar(mundo, { listas: trece, tope: 12 });
    const { salida, red } = await ejecutar(mundo, {
      listas: trece,
      tope: 1,
      ahora: en(2),
    });
    expect(red.urls[0]?.searchParams.get("cursor")).toBeNull();
    expect(salida.checkpoint?.reanudaDe).toBeNull();
    expect(salida.checkpoint?.ventana).toEqual(
      ventanaEnSegundos(ventanaHaciaDelante(en(2), 31)),
    );
  });

  it("sin tope inyectado gobierna el del REPOSITORIO: 12, y la 13.ª no sale", async () => {
    const { salida, red, fila } = await ejecutar(crearMundo(), {
      listas: trece,
      tope: null,
    });
    expect(estado(salida)).toBe("budget_stopped");
    expect(red.urls).toHaveLength(12);
    expect(fila?.requestsMade).toBe(12);
    expect(salida.contadores.reservasConcedidas).toBe(12);
    const corte = (salida.resultado.ejecutado &&
      salida.resultado.metricas.errorSamples[0]) as Record<string, unknown>;
    expect(corte).toMatchObject({
      motivo: "tope_por_ejecucion",
      consumido: 12,
      techo: 12,
    });
  });
});
