/**
 * El checkpoint de `expiring` y su estrategia **horizonte hacia delante**.
 * Funciones puras: sin red y sin base de datos.
 */
import { describe, expect, it } from "vitest";

import { ArranqueDenegado } from "../../jobs/ops/contratos.ts";
import type { RegistroDePagina } from "../../jobs/pipelines/deltas/index.ts";
import { ventanaEnSegundos } from "../../jobs/pipelines/deltas/manifiesto.ts";
import {
  MARGEN_DE_RELOJ_MS,
  construirUrl,
  ventanaHaciaDelante,
} from "../../jobs/pipelines/deltas/origen.ts";
import {
  HORIZONTE_POR_DEFECTO_DIAS,
  avanzarCheckpointDeExpiring,
  checkpointDeExpiringV1,
  checkpointInicialDeExpiring,
  leerCheckpointDeExpiring,
  planificarExpiring,
} from "../../jobs/pipelines/expiring/checkpoint.ts";
import { estrategiaDeExpiring } from "../../jobs/pipelines/expiring/job.ts";
import { crearLibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";

const T = new Date("2026-09-24T10:00:00.000Z");
const CURSOR = "1790632740:1047936342";

function pagina(extra: Partial<RegistroDePagina> = {}): RegistroDePagina {
  return {
    tipo: "expiring",
    pagina: 1,
    cursorDeEntrada: null,
    hayMas: false,
    cursorSiguiente: null,
    avisos: 25,
    ultimoTimestamp: new Date("2026-10-01T21:59:00.000Z"),
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
  });

  it("[ahora − 60 s, ahora + 31 días], desde la primera página", () => {
    const cp = planificarExpiring(T);
    expect(cp).toEqual({
      v: 1,
      estrategia: "horizonte",
      horizonteDias: 31,
      ventana: {
        from: Math.floor((T.getTime() - MARGEN_DE_RELOJ_MS) / 1000),
        to: Math.floor((T.getTime() + 31 * 86_400_000) / 1000),
      },
      tipos: ["expiring"],
      pendiente: { changeType: "expiring", cursorDeEntrada: null },
      ultimoTimestampConfirmado: null,
      paginasConfirmadas: 0,
      reanudaDe: null,
    });
    expect(cp.ventana).toEqual(ventanaEnSegundos(ventanaHaciaDelante(T, 31)));
  });

  it("nunca más de 31 días, aunque se pidan más", () => {
    const cp = planificarExpiring(T, 60);
    expect(cp.horizonteDias).toBe(31);
    expect(cp.ventana.to - cp.ventana.from).toBe(31 * 86_400 + 60);
  });

  it("la URL es la medida: change_type=expiring, ventana e include_unknown_dates=false", () => {
    const cp = planificarExpiring(T);
    const url = new URL(
      construirUrl({
        base: "https://api.test/v4",
        tipo: "expiring",
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
      change_type: "expiring",
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
  it("con hasMore: la pendiente es la página siguiente, con el nextCursor", () => {
    const cp = avanzarCheckpointDeExpiring(
      planificarExpiring(T),
      pagina({ hayMas: true, cursorSiguiente: CURSOR }),
    );
    expect(cp.pendiente).toEqual({ changeType: "expiring", cursorDeEntrada: CURSOR });
    expect(cp.paginasConfirmadas).toBe(1);
    expect(cp.ultimoTimestampConfirmado).toBe("2026-10-01T21:59:00.000Z");
  });

  it("sin hasMore: pendiente = null, el recorrido del horizonte terminó", () => {
    const cp = avanzarCheckpointDeExpiring(planificarExpiring(T), pagina());
    expect(cp.pendiente).toBeNull();
  });

  it("hasMore sin cursor no se interpreta como «hay más»", () => {
    const cp = avanzarCheckpointDeExpiring(
      planificarExpiring(T),
      pagina({ hayMas: true, cursorSiguiente: null }),
    );
    expect(cp.pendiente).toBeNull();
  });

  it("una página de otra lista no puede avanzarlo", () => {
    expect(() =>
      avanzarCheckpointDeExpiring(planificarExpiring(T), pagina({ tipo: "new" })),
    ).toThrow(/no recorre la lista "new"/);
  });
});

describe("📏 fila 44: el primer recorrido real, completo en 6 páginas", () => {
  /** El `ultimoTimestamp` de cada página del manifiesto real, en orden. */
  const PAGINAS = [
    ["2026-09-29T21:59:59.000Z", "1790719199:2098173092"],
    ["2026-09-30T21:59:00.000Z", "1790805540:2313233524"],
    ["2026-09-30T21:59:59.000Z", "1790805599:1617006456"],
    ["2026-10-02T21:59:59.000Z", "1790978399:253535307"],
    ["2026-10-15T21:59:00.000Z", "1792101540:2313142960"],
    ["2026-10-23T21:59:00.000Z", null],
  ] as const;

  const recorrido = () => {
    let cp = checkpointInicialDeExpiring({
      ventana: { from: 1790251506, to: 1792929966 },
      horizonteDias: 31,
    });
    PAGINAS.forEach(([ultimo, siguiente], i) => {
      cp = avanzarCheckpointDeExpiring(
        cp,
        pagina({
          pagina: i + 1,
          hayMas: siguiente !== null,
          cursorSiguiente: siguiente,
          ultimoTimestamp: new Date(ultimo),
        }),
      );
    });
    return cp;
  };

  it("reproduce el checkpoint que quedó en la fila, valor a valor", () => {
    // Literal, en el orden en que lo devolvió PostgreSQL (jsonb).
    expect(recorrido()).toEqual({
      v: 1,
      tipos: ["expiring"],
      ventana: { from: 1790251506, to: 1792929966 },
      pendiente: null,
      reanudaDe: null,
      estrategia: "horizonte",
      horizonteDias: 31,
      paginasConfirmadas: 6,
      ultimoTimestampConfirmado: "2026-10-23T21:59:00.000Z",
    });
  });

  it("⚖️ completo: ultimoTimestampConfirmado es la salida MÁS LEJANA observada, no el fin del horizonte", () => {
    const cp = recorrido();
    const ultima = Date.parse(cp.ultimoTimestampConfirmado ?? "");
    expect(cp.pendiente).toBeNull();
    // Dentro de la ventana y por debajo de su fin: del 23-oct 21:59 al
    // 25-oct 12:06 no sale nada. No es un corte; es que no hay avisos.
    expect(ultima).toBeLessThanOrEqual(cp.ventana.to * 1000);
    expect(ultima).toBeGreaterThanOrEqual(cp.ventana.from * 1000);
    expect(new Date(cp.ventana.to * 1000).toISOString()).toBe(
      "2026-10-25T12:06:06.000Z",
    );
  });
});

describe("el formato v1 es estricto", () => {
  const valido = planificarExpiring(T);

  it("una clave de más lo invalida", () => {
    expect(checkpointDeExpiringV1.safeParse({ ...valido, extra: 1 }).success).toBe(
      false,
    );
  });

  it("un tipo que no es expiring lo invalida", () => {
    expect(
      checkpointDeExpiringV1.safeParse({ ...valido, tipos: ["new"] }).success,
    ).toBe(false);
  });

  it("reanudaDe distinto de null lo invalida: un recorrido nunca reanuda otro", () => {
    expect(checkpointDeExpiringV1.safeParse({ ...valido, reanudaDe: 7 }).success).toBe(
      false,
    );
  });

  it("un checkpoint de deltas no pasa por uno de expiring", () => {
    expect(() =>
      leerCheckpointDeExpiring(
        {
          v: 1,
          ventana: valido.ventana,
          tipos: ["removed", "new"],
          pendiente: null,
          ultimoTimestampConfirmado: null,
          paginasConfirmadas: 0,
          reanudaDe: null,
        },
        3,
      ),
    ).toThrow(ArranqueDenegado);
  });

  it("una versión desconocida se rechaza como tal", () => {
    try {
      leerCheckpointDeExpiring({ ...valido, v: 2 }, 3);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ArranqueDenegado);
      expect((error as ArranqueDenegado).motivo).toBe("checkpoint_version_desconocida");
    }
  });

  it("lo que se construye se puede leer después", () => {
    expect(leerCheckpointDeExpiring(structuredClone(valido), 1)).toEqual(valido);
  });
});

describe("la estrategia horizonte", () => {
  it("no interpreta ausencias", () => {
    expect(estrategiaDeExpiring().interpretarAusencias).toBe(false);
    expect(estrategiaDeExpiring().pipeline).toBe("expiring");
  });

  it("planifica sin leer nada: ningún recorrido depende de otro", async () => {
    const libro = crearLibroEnMemoria();
    const cp = await estrategiaDeExpiring(undefined, "historico").planificar(
      libro.ejecutor,
      T,
    );
    expect(cp).toEqual(planificarExpiring(T));
    expect(libro.filas).toHaveLength(0);
  });

  it("con ventana fija acepta el recorrido grabado, pero se niega a reanudar", () => {
    const e = estrategiaDeExpiring();
    const v = { from: 100, to: 200 };
    expect(e.fijo(v)).toEqual(
      checkpointInicialDeExpiring({ ventana: v, horizonteDias: 31 }),
    );
    expect(() => e.fijo(v, { tipo: "expiring", cursor: CURSOR })).toThrow(/no reanuda/);
  });
});
