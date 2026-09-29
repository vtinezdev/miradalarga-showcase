/**
 * **Guarda contra un cursor sin progreso** en el motor común de `/changes`
 * (`deltas/origen.ts`, `exigirProgreso`): la comparten `deltas`, `expiring` y
 * `upcoming`.
 *
 * 📏 Por qué (fila 50, 2026-09-24): los cursores de `upcoming` son
 * `timestamp:0` y vuelven a servir los avisos del instante de la frontera —9
 * repetidos entre las páginas 1 y 2—. Con más de 25 avisos en un mismo
 * instante, el cursor siguiente sería el mismo y el recorrido pediría la misma
 * página hasta agotar su tope. El solapamiento de avisos no es falta de
 * progreso; repetir un cursor, sí.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { crearLibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import { leerPresupuesto } from "../../jobs/ops/presupuesto.ts";
import type { FuenteDeCuota, Transporte } from "../../jobs/ops/transporte.ts";
import {
  ejecutarJobDeDeltas,
  transaccionPorPagina,
} from "../../jobs/pipelines/deltas/job.ts";
import { recorrerCambios } from "../../jobs/pipelines/deltas/origen.ts";
import { ejecutarJobDeExpiring } from "../../jobs/pipelines/expiring/job.ts";
import { clasificar } from "../../jobs/pipelines/programado.ts";
import { ejecutarJobDeUpcoming } from "../../jobs/pipelines/upcoming/job.ts";
import { conexionDeDatos } from "./ayudas-checkpoint.ts";
import { respuestaCruda, showCrudo } from "./ayudas-deltas.ts";
import { crearBaseEnMemoria } from "./base-en-memoria.ts";

const T = new Date("2026-09-24T15:49:45.017Z");
const seg = (d: Date) => Math.floor(d.getTime() / 1000);
const en = (dias: number) => new Date(T.getTime() + dias * 86_400_000);

const FRONTERA = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "..",
      "fixtures",
      "changes",
      "upcoming-fila50-frontera.json",
    ),
    "utf8",
  ),
) as {
  readonly meta: { readonly ahora: string };
  readonly paginas: readonly {
    readonly changes: readonly unknown[];
    readonly nextCursor?: string;
  }[];
};

/** Una página de `tipo` con un aviso, y su cursor siguiente. */
function pagina(tipo: string, id: string, siguiente: string | null, hasMore = true) {
  const link = `https://netflix.test/${id}`;
  return respuestaCruda({
    cambios: [
      {
        changeType: tipo,
        showId: id,
        service: "netflix",
        type: "subscription",
        link,
        timestamp: seg(en(3)),
      },
    ],
    shows: [
      showCrudo({
        id,
        imdbId: `tt${id.padStart(7, "0")}`,
        opciones:
          tipo === "upcoming"
            ? []
            : [
                {
                  service: "netflix",
                  type: "subscription",
                  link,
                  expiresOn: seg(en(3)),
                },
              ],
      }),
    ],
    hasMore,
    ...(siguiente === null ? {} : { nextCursor: siguiente }),
  });
}

/** Sirve por `(change_type, cursor)`, pasando por la cuota; cuenta requests. */
function servidor(listas: ReadonlyMap<string, unknown>) {
  const urls: URL[] = [];
  const crear =
    (fuente: FuenteDeCuota): Transporte =>
    async (url) => {
      await fuente.pedirCuota();
      const u = new URL(url);
      urls.push(u);
      const cuerpo = listas.get(
        `${u.searchParams.get("change_type") ?? "?"}|${u.searchParams.get("cursor") ?? ""}`,
      );
      if (cuerpo === undefined) throw new Error(`sin página para ${url}`);
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
  return { crear, urls };
}

/** Consume un recorrido; devuelve cuántas páginas entregó y el error, si hubo. */
async function recorrer(listas: ReadonlyMap<string, unknown>, cursorInicial?: string) {
  const red = servidor(listas);
  const fuente: FuenteDeCuota = {
    pipeline: "upcoming",
    pedirCuota: () => Promise.resolve(),
  };
  let paginas = 0;
  let error: unknown = null;
  try {
    for await (const _p of recorrerCambios(
      { transporte: red.crear(fuente), apiKey: "k" },
      {
        tipo: "upcoming",
        ventana: null,
        maximoDePaginas: 12,
        ...(cursorInicial === undefined ? {} : { cursorInicial }),
      },
    )) {
      paginas++;
    }
  } catch (e) {
    error = e;
  }
  return { paginas, error, requests: red.urls.length, red };
}

// ── El motor ─────────────────────────────────────────────────────────────────

describe("recorrerCambios: el cursor tiene que progresar", () => {
  it("A → A: el cursor siguiente es el MISMO con el que se pidió la página", async () => {
    const r = await recorrer(
      new Map([
        ["upcoming|", pagina("upcoming", "1", "A")],
        ["upcoming|A", pagina("upcoming", "2", "A")],
      ]),
    );
    expect(r.error).toMatchObject({
      name: "FalloOperativo",
      motivo: "cursor_sin_progreso",
      contexto: {
        cursor_de_entrada: "A",
        cursor_siguiente: "A",
        paginas_del_recorrido: 2,
      },
    });
    // Las dos páginas pagadas se entregan; la tercera NO se pide.
    expect(r.paginas).toBe(2);
    expect(r.requests).toBe(2);
  });

  it("A → B → A: un ciclo de dos cursores", async () => {
    const r = await recorrer(
      new Map([
        ["upcoming|", pagina("upcoming", "1", "A")],
        ["upcoming|A", pagina("upcoming", "2", "B")],
        ["upcoming|B", pagina("upcoming", "3", "A")],
      ]),
    );
    expect(r.error).toMatchObject({
      motivo: "cursor_sin_progreso",
      contexto: { cursor_de_entrada: "B", cursor_siguiente: "A" },
    });
    expect(r.paginas).toBe(3);
    expect(r.requests).toBe(3);
  });

  it("al reanudar, el cursor de partida ya cuenta como visto", async () => {
    const r = await recorrer(
      new Map([["upcoming|A", pagina("upcoming", "2", "A")]]),
      "A",
    );
    expect(r.error).toMatchObject({ motivo: "cursor_sin_progreso" });
    expect(r.requests).toBe(1);
  });

  it("hasMore con un cursor vacío tampoco es progreso", async () => {
    const r = await recorrer(new Map([["upcoming|", pagina("upcoming", "1", "  ")]]));
    expect(r.error).toMatchObject({ motivo: "cursor_sin_progreso" });
    expect(r.requests).toBe(1);
  });

  it("paginación normal: A → B → fin, sin error", async () => {
    const r = await recorrer(
      new Map([
        ["upcoming|", pagina("upcoming", "1", "A")],
        ["upcoming|A", pagina("upcoming", "2", "B")],
        ["upcoming|B", pagina("upcoming", "3", null, false)],
      ]),
    );
    expect(r.error).toBeNull();
    expect(r.paginas).toBe(3);
    expect(r.requests).toBe(3);
  });

  it("📏 fila 50: los 9 avisos repetidos se aceptan, porque el cursor SÍ progresa", async () => {
    const [p1, p2, p3] = FRONTERA.paginas;
    const r = await recorrer(
      new Map<string, unknown>([
        ["upcoming|", p1],
        [`upcoming|${p1?.nextCursor ?? "?"}`, p2],
        [`upcoming|${p2?.nextCursor ?? "?"}`, p3],
      ]),
    );
    expect(p1?.nextCursor).toBe("1790838000:0");
    expect(p2?.nextCursor).toBe("1791504000:0");
    expect(r.error).toBeNull();
    expect(r.paginas).toBe(3);
    expect(r.red.urls.map((u) => u.searchParams.get("cursor"))).toEqual([
      null,
      "1790838000:0",
      "1791504000:0",
    ]);
  });
});

// ── Los tres jobs ────────────────────────────────────────────────────────────

function mundo() {
  const libro = crearLibroEnMemoria();
  const base = crearBaseEnMemoria();
  const datos = conexionDeDatos(base, libro);
  return { libro, base, datos };
}

function comunes(
  m: ReturnType<typeof mundo>,
  pipeline: string,
  listas: ReadonlyMap<string, unknown>,
) {
  const red = servidor(listas);
  return {
    red,
    opciones: {
      ejecutorOps: m.libro.ejecutor,
      ejecutorDatos: m.datos.ejecutor,
      transaccion: transaccionPorPagina(m.datos.ejecutor),
      presupuesto: leerPresupuesto({ STREAMING_API_PER_RUN_CAPS: `${pipeline}=12` }),
      crearLlamada: red.crear,
      apiKey: "k",
      ahora: T,
      crearRegistro: null,
      vincularEventos: true,
    },
  };
}

const CICLO = (tipo: string) =>
  new Map([
    [`${tipo}|`, pagina(tipo, "1", "A")],
    [`${tipo}|A`, pagina(tipo, "2", "B")],
    [`${tipo}|B`, pagina(tipo, "3", "A")],
  ]);

describe("upcoming: el ciclo es un fallo operativo, no un corte de presupuesto", () => {
  it("failed con cursor_sin_progreso, sin request extra, horizonte incompleto", async () => {
    const m = mundo();
    const { red, opciones } = comunes(m, "upcoming", CICLO("upcoming"));
    const salida = await ejecutarJobDeUpcoming({
      // El destino histórico, declarado: el régimen por defecto es el estricto.
      regimen: "historico",
      ...opciones,
      plan: { origen: "persistente" },
    });

    expect(salida.resultado).toMatchObject({ ejecutado: true, estado: "failed" });
    const muestras = salida.resultado.ejecutado
      ? salida.resultado.metricas.errorSamples
      : [];
    expect(muestras[0]).toMatchObject({
      motivo: "cursor_sin_progreso",
      cursor_de_entrada: "B",
      cursor_siguiente: "A",
    });
    expect(clasificar(salida.resultado)).toEqual({
      codigo: 1,
      nivel: "error",
      motivo: "cursor_sin_progreso",
    });
    expect(red.urls).toHaveLength(3);
    expect(salida.contadores.reservasConcedidas).toBe(3);
    // La página con el cursor repetido se confirmó: el checkpoint apunta a él.
    expect(salida.checkpoint).toMatchObject({
      paginasConfirmadas: 3,
      pendiente: { changeType: "upcoming", cursorDeEntrada: "A" },
    });
    expect(salida.horizonte).toEqual({
      completo: false,
      desaparecidas: null,
      muestra: [],
      fueraDeCobertura: null,
    });
    expect(salida.anuncios?.completo).toBe(false);
    // Ninguna ausencia interpretada: ni una racha subida.
    expect(m.base.sentencias.some((s) => s.includes("SET missing_streak = $2"))).toBe(
      false,
    );
    const fila = m.libro.filas.find(
      (f) => salida.resultado.ejecutado && f.id === salida.resultado.runId,
    );
    expect(fila?.status).toBe("failed");
    expect(fila?.requestsMade).toBe(3);
  });

  it("antes: hasMore sin cursor cerraba succeeded como horizonte COMPLETO; ahora falla", async () => {
    const m = mundo();
    const { red, opciones } = comunes(
      m,
      "upcoming",
      new Map([["upcoming|", pagina("upcoming", "1", null)]]),
    );
    const salida = await ejecutarJobDeUpcoming({
      // El destino histórico, declarado: el régimen por defecto es el estricto.
      regimen: "historico",
      ...opciones,
      plan: { origen: "persistente" },
    });
    expect(salida.resultado).toMatchObject({ estado: "failed" });
    expect(red.urls).toHaveLength(1);
    expect(salida.horizonte?.desaparecidas).toBeNull();
  });
});

describe("expiring y deltas usan la misma guarda", () => {
  it("expiring: failed cursor_sin_progreso, desaparecidas null", async () => {
    const m = mundo();
    const { red, opciones } = comunes(m, "expiring", CICLO("expiring"));
    const salida = await ejecutarJobDeExpiring({
      // El destino histórico, declarado: el régimen por defecto es el estricto.
      regimen: "historico",
      ...opciones,
      plan: { origen: "persistente" },
    });
    expect(clasificar(salida.resultado).motivo).toBe("cursor_sin_progreso");
    expect(red.urls).toHaveLength(3);
    expect(salida.horizonte).toEqual({
      completo: false,
      desaparecidas: null,
      muestra: [],
    });
  });

  it("deltas: failed cursor_sin_progreso en su lista, sin request extra", async () => {
    const m = mundo();
    const { red, opciones } = comunes(m, "deltas", CICLO("new"));
    const salida = await ejecutarJobDeDeltas({
      ...opciones,
      plan: { origen: "persistente", sinCheckpoint: "ventana_de_validacion" },
      tipos: ["new"],
    });
    expect(clasificar(salida.resultado)).toMatchObject({
      codigo: 1,
      motivo: "cursor_sin_progreso",
    });
    expect(red.urls).toHaveLength(3);
  });
});
