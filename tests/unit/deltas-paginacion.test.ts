/**
 * Construcción de la URL y recorrido del cursor. Sin red: el transporte es un
 * doble, igual que en producción es el único que sabe salir a internet.
 */
import { describe, expect, it } from "vitest";

import { PresupuestoAgotado } from "../../jobs/ops/contratos.ts";
import type { Transporte } from "../../jobs/ops/transporte.ts";
import {
  BASE_POR_DEFECTO,
  CATALOGOS_MVP,
  MARGEN_DE_RELOJ_MS,
  VENTANA_MAXIMA_DIAS,
  calcularVentana,
  construirUrl,
  recorrerCambios,
  ventanaHaciaAtras,
  ventanaHaciaDelante,
} from "../../jobs/pipelines/deltas/origen.ts";
import { crearTransporteFalso, respuestaCruda, showCrudo } from "./ayudas-deltas.ts";

const AHORA = new Date("2026-09-22T10:00:00.000Z");

describe("la URL de /changes", () => {
  const url = (extra: Partial<Parameters<typeof construirUrl>[0]> = {}) =>
    new URL(
      construirUrl({
        base: BASE_POR_DEFECTO,
        tipo: "new",
        cursor: null,
        ventana: null,
        idioma: "es",
        ...extra,
      }),
    );

  it("pide solo las seis plataformas del MVP, con `hbo` y no `max`", () => {
    expect(url().searchParams.get("catalogs")).toBe(CATALOGOS_MVP);
    expect(CATALOGOS_MVP).toContain("hbo");
    expect(CATALOGOS_MVP).not.toContain("max");
  });

  it("fija país, tipo de elemento e idioma", () => {
    const q = url().searchParams;
    expect(q.get("country")).toBe("es");
    expect(q.get("item_type")).toBe("show");
    expect(q.get("output_language")).toBe("es");
    expect(q.get("change_type")).toBe("new");
  });

  it("sin ventana no envía from/to ni include_unknown_dates", () => {
    const q = url().searchParams;
    expect(q.get("from")).toBeNull();
    expect(q.get("include_unknown_dates")).toBeNull();
  });

  it("expiring/upcoming con ventana envían include_unknown_dates=false (📏 aceptado)", () => {
    for (const tipo of ["expiring", "upcoming"] as const) {
      const q = url({ tipo, ventana: ventanaHaciaDelante(AHORA, 31) }).searchParams;
      expect(q.get("include_unknown_dates")).toBe("false");
      expect(q.get("from")).toMatch(/^\d+$/);
      expect(q.get("to")).toMatch(/^\d+$/);
    }
  });

  it("new/removed NO lo envían: la query medida (raw/053-054) no lo llevaba", () => {
    for (const tipo of ["new", "removed"] as const) {
      const q = url({ tipo, ventana: ventanaHaciaAtras(AHORA) }).searchParams;
      expect(q.get("include_unknown_dates")).toBeNull();
      expect(q.get("from")).toMatch(/^\d+$/);
      expect(q.get("to")).toMatch(/^\d+$/);
    }
  });

  it("new/removed llevan EXACTAMENTE los parámetros de la query medida", () => {
    // spike-1/probe-daily.mjs: country, change_type, item_type, catalogs,
    // from, to, output_language. Ni uno más.
    const q = url({ tipo: "removed", ventana: ventanaHaciaAtras(AHORA) }).searchParams;
    expect([...q.keys()].sort()).toEqual(
      [
        "catalogs",
        "change_type",
        "country",
        "from",
        "item_type",
        "output_language",
        "to",
      ].sort(),
    );
  });

  it("el cursor solo viaja cuando existe", () => {
    expect(url().searchParams.get("cursor")).toBeNull();
    expect(url({ cursor: "1787578334:2787037446" }).searchParams.get("cursor")).toBe(
      "1787578334:2787037446",
    );
  });
});

describe("la ventana y el desfase de reloj", () => {
  it("resta un minuto de margen: 2 segundos bastaron para un HTTP 400", () => {
    const ventana = calcularVentana(AHORA, 1);
    const esperado = AHORA.getTime() - 86_400_000 + MARGEN_DE_RELOJ_MS;
    expect(ventana.desde.getTime()).toBe(esperado);
  });

  it("nunca pide más de 31 días hacia atrás", () => {
    const ventana = calcularVentana(AHORA, 90);
    const dias = (AHORA.getTime() - ventana.desde.getTime()) / 86_400_000;
    expect(dias).toBeLessThanOrEqual(VENTANA_MAXIMA_DIAS);
  });

  it("la ventana de new/removed es la medida: from = ahora − 24 h, to = ahora", () => {
    // 📏 spike-1/daily.json: from_epoch 1789908346, to_epoch 1789994746,
    // exactamente 86.400 s y con `to` en el instante de la consulta.
    const ventana = ventanaHaciaAtras(AHORA);
    expect(ventana.hasta.getTime()).toBe(AHORA.getTime());
    expect(ventana.hasta.getTime() - ventana.desde.getTime()).toBe(86_400_000);
    const q = new URL(
      construirUrl({
        base: BASE_POR_DEFECTO,
        tipo: "new",
        cursor: null,
        ventana,
        idioma: "es",
      }),
    ).searchParams;
    expect(Number(q.get("to")) - Number(q.get("from"))).toBe(86_400);
    expect(Number(q.get("to"))).toBe(Math.floor(AHORA.getTime() / 1000));
  });

  it("la ventana de expiring/upcoming mira HACIA DELANTE", () => {
    // 📏 Es la forma que funcionó en `raw/023` y `raw/024`: from = ahora,
    // to = ahora + 31 días. La hacia atrás abarcaría 62 días a caballo de
    // los dos lados, que nunca se ha probado — y un 400 cuesta una request.
    const ventana = ventanaHaciaDelante(AHORA, VENTANA_MAXIMA_DIAS);
    expect(ventana.desde.getTime()).toBe(AHORA.getTime() - MARGEN_DE_RELOJ_MS);
    expect(ventana.hasta.getTime()).toBe(
      AHORA.getTime() + VENTANA_MAXIMA_DIAS * 86_400_000,
    );
    // Y no se cuela ni un segundo en el pasado más allá del margen.
    const diasAtras = (AHORA.getTime() - ventana.desde.getTime()) / 86_400_000;
    expect(diasAtras).toBeLessThan(1);
  });
});

describe("recorrido del cursor", () => {
  const pagina = (hasMore: boolean, cursor?: string) =>
    respuestaCruda({
      cambios: [
        {
          changeType: "new",
          showId: "1",
          service: "netflix",
          type: "subscription",
          link: "https://netflix.test/1",
          timestamp: 1787357748,
        },
      ],
      shows: [showCrudo({ id: "1", imdbId: "tt1" })],
      hasMore,
      ...(cursor === undefined ? {} : { nextCursor: cursor }),
    });

  it("encadena páginas por el cursor y para en hasMore=false", async () => {
    const falso = crearTransporteFalso([pagina(true, "c1"), pagina(false)]);
    const paginas = [];
    for await (const p of recorrerCambios(
      { transporte: falso.transporte, apiKey: "k" },
      { tipo: "new", ventana: null, maximoDePaginas: 10 },
    )) {
      paginas.push(p);
    }

    expect(paginas).toHaveLength(2);
    expect(new URL(falso.urls[0] ?? "").searchParams.get("cursor")).toBeNull();
    expect(new URL(falso.urls[1] ?? "").searchParams.get("cursor")).toBe("c1");
  });

  it("pide cuota una vez por PÁGINA, no por aviso", async () => {
    const falso = crearTransporteFalso([pagina(false)]);
    for await (const _p of recorrerCambios(
      { transporte: falso.transporte, apiKey: "k" },
      { tipo: "new", ventana: null, maximoDePaginas: 10 },
    )) {
      // Solo se consume el generador.
    }
    expect(falso.cuotasPedidas()).toBe(1);
  });

  it("hasMore sin cursor: entrega la página y FALLA, sin pedir otra", async () => {
    // Antes paraba en silencio y el recorrido pasaba por completo. Ahora es
    // `cursor_sin_progreso` (`origen.ts`, `exigirProgreso`).
    const falso = crearTransporteFalso([pagina(true), pagina(false)]);
    let vistas = 0;
    await expect(async () => {
      for await (const _p of recorrerCambios(
        { transporte: falso.transporte, apiKey: "k" },
        { tipo: "new", ventana: null, maximoDePaginas: 10 },
      )) {
        vistas++;
      }
    }).rejects.toMatchObject({ name: "FalloOperativo", motivo: "cursor_sin_progreso" });
    expect(vistas).toBe(1);
    expect(falso.cuotasPedidas()).toBe(1);
  });

  it("respeta el máximo de páginas", async () => {
    const falso = crearTransporteFalso([
      pagina(true, "c1"),
      pagina(true, "c2"),
      pagina(true, "c3"),
    ]);
    let vistas = 0;
    for await (const _p of recorrerCambios(
      { transporte: falso.transporte, apiKey: "k" },
      { tipo: "new", ventana: null, maximoDePaginas: 2 },
    )) {
      vistas++;
    }
    expect(vistas).toBe(2);
  });

  it("deja subir PresupuestoAgotado sin capturarlo", async () => {
    // `ejecutarJob` es quien lo convierte en `budget_stopped`. Si el pipeline
    // lo capturara, un corte de cuota se leería como una ejecución correcta.
    const transporte: Transporte = () =>
      Promise.reject(
        new PresupuestoAgotado({
          motivo: "tope_por_ejecucion",
          pipeline: "deltas",
          consumido: 5,
          techo: 5,
        }),
      );

    await expect(async () => {
      for await (const _p of recorrerCambios(
        { transporte, apiKey: "k" },
        { tipo: "new", ventana: null, maximoDePaginas: 10 },
      )) {
        // No debería llegar ninguna página.
      }
    }).rejects.toThrow(PresupuestoAgotado);
  });

  it("un HTTP no-2xx lanza en vez de seguir paginando a ciegas", async () => {
    const transporte: Transporte = () =>
      Promise.resolve(new Response("límite de ventana", { status: 400 }));

    await expect(async () => {
      for await (const _p of recorrerCambios(
        { transporte, apiKey: "k" },
        { tipo: "new", ventana: null, maximoDePaginas: 10 },
      )) {
        // No debería llegar ninguna página.
      }
    }).rejects.toThrow(/respondió 400/);
  });
});
