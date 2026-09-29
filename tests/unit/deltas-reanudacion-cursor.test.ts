/**
 * **Reanudación desde un cursor REAL**, dentro de un mismo `changeType`.
 *
 * El ensayo contra Neon falla en la segunda petición global, que es la página
 * 1 de `new`: reanuda con `cursor = null` y no demuestra nada sobre cursores.
 * Aquí la lista `new` tiene tres páginas encadenadas:
 *
 *   página 1  cursor = ∅  → devuelve nextCursor = A     ✅ se confirma
 *   página 2  cursor = A  → devuelve nextCursor = B     ❌ escribe estado y falla
 *   página 3  cursor = B  → fin
 *
 * Lo que tiene que pasar:
 *
 *   · la transacción de la página 2 se revierte entera;
 *   · el punto de reanudación es `cursorDeEntrada = A`, el de la página que
 *     falló, **nunca B**, que es el `nextCursor` que ella devolvió;
 *   · reanudar vuelve a pedir la página 2 con `cursor = A`, y después la 3;
 *   · el resultado final es idéntico al de una pasada limpia, sin eventos
 *     perdidos ni duplicados.
 *
 * Sin API y sin Neon: transporte servido por cursor, base en memoria con
 * transacciones reales y libro de `ops` en memoria.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { crearLibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import { leerPresupuesto } from "../../jobs/ops/presupuesto.ts";
import type { FuenteDeCuota, Transporte } from "../../jobs/ops/transporte.ts";
import {
  ejecutarJobDeDeltas,
  transaccionPorPagina,
} from "../../jobs/pipelines/deltas/job.ts";
import {
  crearRegistroLocal,
  leerManifiesto,
  planDeReanudacion,
} from "../../jobs/pipelines/deltas/manifiesto.ts";
import type { VentanaDeConsulta } from "../../jobs/pipelines/deltas/origen.ts";
import { ventanaHaciaAtras } from "../../jobs/pipelines/deltas/origen.ts";
import type { BaseEnMemoria } from "./base-en-memoria.ts";
import { crearBaseEnMemoria } from "./base-en-memoria.ts";
import { respuestaCruda, showCrudo } from "./ayudas-deltas.ts";

const T = new Date("2026-09-24T08:00:00.000Z");
/** Mismo día en Madrid: mismo bucket de eventos. */
const T_MAS_MEDIA_HORA = new Date(T.getTime() + 30 * 60_000);
const VENTANA = ventanaHaciaAtras(T);
const CURSOR_A = "1790000000:111";
const CURSOR_B = "1790000600:222";

/**
 * Una página de `new`: un título con la oferta de Netflix que el aviso nombra
 * (→ `added`) y una de Prime que no nombra nadie (→ línea base, sin evento).
 */
function paginaNew(id: string, timestamp: number, nextCursor?: string) {
  return respuestaCruda({
    cambios: [
      {
        changeType: "new",
        showId: id,
        service: "netflix",
        type: "subscription",
        link: `https://netflix.test/${id}`,
        timestamp,
      },
    ],
    shows: [
      showCrudo({
        id,
        imdbId: `tt${id.padStart(7, "0")}`,
        opciones: [
          {
            service: "netflix",
            type: "subscription",
            link: `https://netflix.test/${id}`,
          },
          { service: "prime", type: "subscription", link: `https://prime.test/${id}` },
        ],
      }),
    ],
    hasMore: nextCursor !== undefined,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  });
}

const BASE_TS = Math.floor(T.getTime() / 1000) - 20 * 3600;
/** La lista `new` completa, servida POR CURSOR: el orden de llamada no importa. */
const LISTA: ReadonlyMap<string, Record<string, unknown>> = new Map([
  ["", paginaNew("21", BASE_TS, CURSOR_A)],
  [CURSOR_A, paginaNew("22", BASE_TS + 600, CURSOR_B)],
  [CURSOR_B, paginaNew("23", BASE_TS + 1200)],
]);

const CUOTA = {
  "x-quota-used": "120",
  "x-quota-granted": "1000",
  "x-quota-reset": "2026-10-01T00:00:00Z",
};

/** Sirve la página que corresponde al `cursor` de la query, pasando por la cuota. */
function servidorPorCursor() {
  const pedidas: URL[] = [];
  const crear = (fuente: FuenteDeCuota): Transporte => {
    return async (url) => {
      await fuente.pedirCuota();
      const u = new URL(url);
      pedidas.push(u);
      const cuerpo = LISTA.get(u.searchParams.get("cursor") ?? "");
      if (cuerpo === undefined) throw new Error(`cursor desconocido: ${url}`);
      return new Response(JSON.stringify(cuerpo), {
        status: 200,
        headers: { "content-type": "application/json", ...CUOTA },
      });
    };
  };
  return { crear, pedidas };
}

async function correr(
  base: BaseEnMemoria,
  entrada: {
    readonly ahora: Date;
    readonly ventana?: VentanaDeConsulta;
    readonly reanudarEn?: { tipo: "new"; cursor: string | null };
  },
) {
  const directorio = mkdtempSync(join(tmpdir(), "deltas-cursor-"));
  const ventana = entrada.ventana ?? VENTANA;
  const servidor = servidorPorCursor();
  const libro = crearLibroEnMemoria();
  const salida = await ejecutarJobDeDeltas({
    ejecutorOps: libro.ejecutor,
    ejecutorDatos: base.ejecutor,
    transaccion: transaccionPorPagina(base.ejecutor),
    presupuesto: leerPresupuesto({ STREAMING_API_PER_RUN_CAPS: "deltas=4" }),
    crearLlamada: servidor.crear,
    apiKey: "k",
    plan: {
      origen: "fijo",
      ventana,
      ...(entrada.reanudarEn === undefined ? {} : { reanudarEn: entrada.reanudarEn }),
    },
    tipos: ["new"],
    ahora: entrada.ahora,
    crearRegistro: (cabecera) =>
      crearRegistroLocal(directorio, {
        modo: entrada.reanudarEn === undefined ? "ensayo" : "reanudacion",
        ...cabecera,
        // El manifiesto de estos tests no registra de dónde se reanuda.
        reanudaDe: null,
      }),
    vincularEventos: false,
  });
  const cursores = servidor.pedidas.map((u) => u.searchParams.get("cursor"));
  return { salida, directorio, cursores, pedidas: servidor.pedidas, libro };
}

/** La primera ejecución: la página 2 escribe su estado y falla antes del evento. */
async function primeraConFallo() {
  const base = crearBaseEnMemoria();
  let insercionesDeEventos = 0;
  base.fallarUnaVezEn(
    (t) =>
      t.startsWith("INSERT INTO external_availability_events") &&
      ++insercionesDeEventos === 2,
  );
  const primera = await correr(base, { ahora: T });
  return { base, primera };
}

describe("fallo en la página 2 de una misma lista, pedida con cursor A", () => {
  it("se piden página 1 (sin cursor) y página 2 (cursor A); la ejecución falla", async () => {
    const { primera } = await primeraConFallo();
    expect(primera.cursores).toEqual([null, CURSOR_A]);
    expect(primera.salida.resultado.ejecutado && primera.salida.resultado.estado).toBe(
      "failed",
    );
    // Las dos requests salieron y las dos cuentan: la cuota no se devuelve.
    expect(primera.salida.contadores.reservasConcedidas).toBe(2);
    expect(primera.libro.filas[0]?.requestsMade).toBe(2);
  });

  it("la página 2 llegó a escribir estado y su transacción se revirtió ENTERA", async () => {
    const { base } = await primeraConFallo();
    // Dentro de la transacción de la página 2 hubo escritura de opciones…
    const ultimoBegin = base.sentencias.lastIndexOf("BEGIN");
    const transaccion2 = base.sentencias.slice(ultimoBegin);
    expect(
      transaccion2.some((s) =>
        s.startsWith("INSERT INTO external_availability_options"),
      ),
    ).toBe(true);
    expect(transaccion2.at(-1)).toBe("ROLLBACK");
    // …pero no sobrevive nada: ni su título, ni sus opciones, ni su evento.
    const foto = base.foto() as { titulos: string[]; eventos: unknown[] };
    expect(foto.titulos).toEqual(["tt0000021"]);
    expect(base.opcion("https://netflix.test/22")).toBeUndefined();
    expect(foto.eventos).toHaveLength(1);
  });

  it("el punto de reanudación es cursorDeEntrada = A, NUNCA el nextCursor B de la página que falló", async () => {
    const { primera } = await primeraConFallo();
    expect(primera.salida.reanudacion).toEqual({
      changeType: "new",
      from: Math.floor(VENTANA.desde.getTime() / 1000),
      to: Math.floor(VENTANA.hasta.getTime() / 1000),
      cursorDeEntrada: CURSOR_A,
      // El timestamp de lo CONFIRMADO: el de la página 1, no el de la 2.
      ultimoTimestamp: new Date(BASE_TS * 1000).toISOString(),
    });
    expect(primera.salida.reanudacion?.cursorDeEntrada).not.toBe(CURSOR_B);
  });

  it("el manifiesto separa el cursor de ENTRADA del nextCursor DEVUELTO", async () => {
    const { primera } = await primeraConFallo();
    const m = leerManifiesto(primera.directorio);
    // La respuesta de la página 2 se guardó —con el B que devolvió— antes de fallar…
    expect(m.respuestas.map((r) => [r.cursorDeEntrada, r.nextCursorDevuelto])).toEqual([
      [null, CURSOR_A],
      [CURSOR_A, CURSOR_B],
    ]);
    // …pero solo la página 1 figura como confirmada…
    expect(m.paginas.map((p) => [p.pagina, p.cursorDeEntrada, p.nextCursor])).toEqual([
      [1, null, CURSOR_A],
    ]);
    // …y el punto de reanudación es la entrada de la 2, no su salida.
    expect(m.estado).toBe("failed");
    expect(m.reanudacion?.cursorDeEntrada).toBe(CURSOR_A);
    expect(planDeReanudacion(m).reanudarEn).toEqual({ tipo: "new", cursor: CURSOR_A });
  });
});

describe("reanudación desde el cursor A", () => {
  async function reanudar(ahora: Date) {
    const { base, primera } = await primeraConFallo();
    const plan = planDeReanudacion(leerManifiesto(primera.directorio));
    const segunda = await correr(base, {
      ahora,
      ventana: plan.ventana,
      reanudarEn: { tipo: "new", cursor: plan.reanudarEn.cursor },
    });
    return { base, primera, segunda };
  }

  it("vuelve a pedir la página 2 con cursor = A, y después la 3 con B", async () => {
    const { segunda } = await reanudar(T_MAS_MEDIA_HORA);
    expect(segunda.cursores).toEqual([CURSOR_A, CURSOR_B]);
    expect(segunda.salida.resultado.ejecutado && segunda.salida.resultado.estado).toBe(
      "succeeded",
    );
    expect(segunda.salida.reanudacion).toBeNull();
  });

  it("con LA MISMA ventana: from y to idénticos a los de la ejecución original", async () => {
    const { primera, segunda } = await reanudar(T_MAS_MEDIA_HORA);
    const ventanas = [...primera.pedidas, ...segunda.pedidas].map((u) => [
      u.searchParams.get("from"),
      u.searchParams.get("to"),
    ]);
    expect(new Set(ventanas.map((v) => JSON.stringify(v))).size).toBe(1);
  });

  it("resultado final IDÉNTICO a una pasada limpia en el mismo instante", async () => {
    const { base } = await reanudar(T);
    const limpia = crearBaseEnMemoria();
    const pasada = await correr(limpia, { ahora: T });
    expect(pasada.cursores).toEqual([null, CURSOR_A, CURSOR_B]);
    // Estado completo, instantes de observación incluidos.
    expect(base.foto()).toEqual(limpia.foto());
  });

  it("reanudando más tarde, el estado es el mismo; solo difieren los instantes de observación", async () => {
    const { base } = await reanudar(T_MAS_MEDIA_HORA);
    const limpia = crearBaseEnMemoria();
    await correr(limpia, { ahora: T });
    expect(base.foto({ instantes: false })).toEqual(limpia.foto({ instantes: false }));
  });

  it("sin eventos perdidos ni duplicados: uno `added` por página, cada uno una vez", async () => {
    const { base } = await reanudar(T_MAS_MEDIA_HORA);
    const eventos = base.eventos();
    expect(eventos.map((e) => e.eventType)).toEqual(["added", "added", "added"]);
    expect(
      new Set(eventos.map((e) => `${String(e.availabilityId)}|${e.digest}`)).size,
    ).toBe(3);
    const ofertas = (base.foto() as { eventos: { oferta: string }[] }).eventos.map(
      (e) => e.oferta,
    );
    expect(ofertas).toEqual([
      "tt0000021|netflix|subscription|",
      "tt0000022|netflix|subscription|",
      "tt0000023|netflix|subscription|",
    ]);
  });

  it("reanudar con el nextCursor de la página que falló (B) PERDERÍA la página 2", async () => {
    // El contrafactual que justifica todo lo anterior: si el punto fuera B, la
    // página 2 no se volvería a pedir y su título y su alta desaparecerían.
    const { base } = await primeraConFallo();
    const erronea = await correr(base, {
      ahora: T_MAS_MEDIA_HORA,
      reanudarEn: { tipo: "new", cursor: CURSOR_B },
    });
    expect(erronea.cursores).toEqual([CURSOR_B]);
    expect(base.opcion("https://netflix.test/22")).toBeUndefined();
    expect(base.eventos()).toHaveLength(2);
  });
});
