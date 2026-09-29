/**
 * El checkpoint de `upcoming` y su estrategia **horizonte hacia delante**.
 * Funciones puras: sin red y sin base de datos.
 */
import { describe, expect, it } from "vitest";

import { ArranqueDenegado } from "../../jobs/ops/contratos.ts";
import { crearLibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import type { RegistroDePagina } from "../../jobs/pipelines/deltas/index.ts";
import {
  MARGEN_DE_RELOJ_MS,
  construirUrl,
  ventanaHaciaDelante,
} from "../../jobs/pipelines/deltas/origen.ts";
import { ventanaEnSegundos } from "../../jobs/pipelines/deltas/manifiesto.ts";
import {
  leerCheckpointDeExpiring,
  planificarExpiring,
} from "../../jobs/pipelines/expiring/checkpoint.ts";
import {
  HORIZONTE_POR_DEFECTO_DIAS,
  PIPELINE_UPCOMING,
  avanzarCheckpointDeUpcoming,
  checkpointDeUpcomingV1,
  checkpointInicialDeUpcoming,
  leerCheckpointDeUpcoming,
  planificarUpcoming,
} from "../../jobs/pipelines/upcoming/checkpoint.ts";
import { estrategiaDeUpcoming } from "../../jobs/pipelines/upcoming/job.ts";

const T = new Date("2026-09-24T10:00:00.000Z");
/** 📏 El `nextCursor` real de `raw/024`. */
const CURSOR = "1790665200:0";

function pagina(extra: Partial<RegistroDePagina> = {}): RegistroDePagina {
  return {
    tipo: "upcoming",
    pagina: 1,
    cursorDeEntrada: null,
    hayMas: false,
    cursorSiguiente: null,
    avisos: 25,
    ultimoTimestamp: new Date("2026-09-29T07:00:00.000Z"),
    eventos: {},
    eventosEscritos: 0,
    filasPorTabla: {},
    multiLinkOffers: 0,
    farFutureExpiries: 0,
    ...extra,
  };
}

describe("el plan de un recorrido nuevo", () => {
  it("horizonte por defecto: 31 días, el máximo de /changes", () => {
    expect(HORIZONTE_POR_DEFECTO_DIAS).toBe(31);
    expect(PIPELINE_UPCOMING).toBe("upcoming");
  });

  it("[ahora − 60 s, ahora + 31 días], desde la primera página", () => {
    expect(planificarUpcoming(T)).toEqual({
      v: 1,
      estrategia: "horizonte",
      horizonteDias: 31,
      ventana: {
        from: Math.floor((T.getTime() - MARGEN_DE_RELOJ_MS) / 1000),
        to: Math.floor((T.getTime() + 31 * 86_400_000) / 1000),
      },
      tipos: ["upcoming"],
      pendiente: { changeType: "upcoming", cursorDeEntrada: null },
      ultimoTimestampConfirmado: null,
      paginasConfirmadas: 0,
      reanudaDe: null,
    });
  });

  it("no pasa de 31 días aunque se pidan más", () => {
    const cp = planificarUpcoming(T, 45);
    expect(cp.horizonteDias).toBe(31);
    expect(cp.ventana).toEqual(ventanaEnSegundos(ventanaHaciaDelante(T, 31)));
  });

  it("📏 la URL es la de raw/024 más include_unknown_dates=false", () => {
    const cp = planificarUpcoming(T);
    const url = new URL(
      construirUrl({
        base: "https://api.test/v4",
        tipo: "upcoming",
        cursor: null,
        ventana: {
          desde: new Date(cp.ventana.from * 1000),
          hasta: new Date(cp.ventana.to * 1000),
        },
        idioma: "es",
      }),
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      country: "es",
      change_type: "upcoming",
      item_type: "show",
      catalogs: "netflix,prime,disney,hbo,apple,skyshowtime",
      output_language: "es",
      from: String(cp.ventana.from),
      to: String(cp.ventana.to),
      include_unknown_dates: "false",
    });
  });
});

describe("avanzar tras una página confirmada", () => {
  const inicial = planificarUpcoming(T);

  it("con hasMore y cursor, la pendiente es la siguiente página", () => {
    const cp = avanzarCheckpointDeUpcoming(
      inicial,
      pagina({ hayMas: true, cursorSiguiente: CURSOR }),
    );
    expect(cp).toMatchObject({
      pendiente: { changeType: "upcoming", cursorDeEntrada: CURSOR },
      paginasConfirmadas: 1,
      ultimoTimestampConfirmado: "2026-09-29T07:00:00.000Z",
    });
  });

  it("sin hasMore el recorrido termina: pendiente = null", () => {
    const cp = avanzarCheckpointDeUpcoming(inicial, pagina());
    expect(cp.pendiente).toBeNull();
  });

  it("hasMore sin cursor no puede seguir: también termina", () => {
    expect(
      avanzarCheckpointDeUpcoming(inicial, pagina({ hayMas: true })).pendiente,
    ).toBeNull();
  });

  it("una página vacía se confirma y no inventa una fecha", () => {
    const cp = avanzarCheckpointDeUpcoming(
      inicial,
      pagina({ avisos: 0, ultimoTimestamp: null }),
    );
    expect(cp.ultimoTimestampConfirmado).toBeNull();
    expect(cp.paginasConfirmadas).toBe(1);
  });

  it("no acepta páginas de otra lista", () => {
    expect(() =>
      avanzarCheckpointDeUpcoming(inicial, pagina({ tipo: "expiring" })),
    ).toThrow(/upcoming no recorre la lista "expiring"/);
  });
});

describe("el formato v1 es estricto y no se cruza con el de expiring", () => {
  const valido = planificarUpcoming(T);

  it("una clave de más lo invalida", () => {
    expect(checkpointDeUpcomingV1.safeParse({ ...valido, extra: 1 }).success).toBe(
      false,
    );
  });

  it("reanudaDe distinto de null lo invalida: un recorrido nunca reanuda otro", () => {
    expect(checkpointDeUpcomingV1.safeParse({ ...valido, reanudaDe: 7 }).success).toBe(
      false,
    );
  });

  it("un checkpoint de expiring no pasa por uno de upcoming", () => {
    expect(() => leerCheckpointDeUpcoming(planificarExpiring(T), 3)).toThrow(
      ArranqueDenegado,
    );
  });

  it("ni uno de upcoming por uno de expiring", () => {
    expect(() => leerCheckpointDeExpiring(valido, 3)).toThrow(ArranqueDenegado);
  });

  it("una versión desconocida se rechaza como tal", () => {
    try {
      leerCheckpointDeUpcoming({ ...valido, v: 2 }, 3);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ArranqueDenegado);
      expect((error as ArranqueDenegado).motivo).toBe("checkpoint_version_desconocida");
    }
  });

  it("lo que se construye se puede leer después", () => {
    expect(leerCheckpointDeUpcoming(structuredClone(valido), 1)).toEqual(valido);
  });
});

describe("la estrategia horizonte de upcoming", () => {
  it("no interpreta ausencias", () => {
    expect(estrategiaDeUpcoming().interpretarAusencias).toBe(false);
    expect(estrategiaDeUpcoming().pipeline).toBe("upcoming");
  });

  it("planifica sin leer nada: ningún recorrido depende de otro", async () => {
    const libro = crearLibroEnMemoria();
    const cp = await estrategiaDeUpcoming(undefined, "historico").planificar(
      libro.ejecutor,
      T,
    );
    expect(cp).toEqual(planificarUpcoming(T));
    expect(libro.filas).toHaveLength(0);
  });

  it("con ventana fija acepta el recorrido grabado, pero se niega a reanudar", () => {
    const e = estrategiaDeUpcoming();
    const v = { from: 100, to: 200 };
    expect(e.fijo(v)).toEqual(
      checkpointInicialDeUpcoming({ ventana: v, horizonteDias: 31 }),
    );
    expect(() => e.fijo(v, { tipo: "upcoming", cursor: CURSOR })).toThrow(
      /upcoming no reanuda/,
    );
  });
});
