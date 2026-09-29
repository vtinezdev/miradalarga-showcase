/**
 * El job de `deltas` antes de su primera ejecución real. **Sin red y sin base
 * de datos.**
 *
 * Cada bloque corresponde a una condición de la aprobación del 2026-09-23:
 *
 *   · transacción por página, y fallo entre el estado y el evento;
 *   · línea base sin `added` falso;
 *   · corte y reanudación conservando ventana y cursor;
 *   · guardia de cuota externa con cabeceras del proveedor.
 *
 * Lo que aquí NO se puede demostrar —el comportamiento real de PostgreSQL con
 * `SAVEPOINT`, triggers y `ON CONFLICT`— lo cubre `pnpm api:run:deltas --ensayo`.
 */
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { EjecutorSql } from "../../jobs/ops/contratos.ts";
import {
  buscarCorteVigente,
  crearGuardiaDeCuotaExterna,
  leerCuotaDelProveedor,
} from "../../jobs/ops/cuota-proveedor.ts";
import { crearLibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import type { LibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import {
  calcularCiclo,
  leerPresupuesto,
  TOPE_POR_EJECUCION_POR_DEFECTO,
} from "../../jobs/ops/presupuesto.ts";
import type { FuenteDeCuota, Transporte } from "../../jobs/ops/transporte.ts";
import { verificarCuadre } from "../../jobs/pipelines/deltas/auditoria.ts";
import { ejecutarDeltas } from "../../jobs/pipelines/deltas/index.ts";
import {
  ejecutarJobDeDeltas,
  transaccionConSavepoint,
  transaccionPorPagina,
} from "../../jobs/pipelines/deltas/job.ts";
import {
  crearRegistroLocal,
  leerManifiesto,
  planDeReanudacion,
} from "../../jobs/pipelines/deltas/manifiesto.ts";
import { ventanaHaciaAtras } from "../../jobs/pipelines/deltas/origen.ts";
import {
  crearEjecutorFalso,
  crearTransporteFalso,
  respuestaCruda,
  showCrudo,
} from "./ayudas-deltas.ts";

const AHORA = new Date("2026-09-23T10:00:00.000Z");
const HACE_UNA_HORA = Math.floor(AHORA.getTime() / 1000) - 3600;
const VENTANA = ventanaHaciaAtras(AHORA);

// ── Páginas de prueba ────────────────────────────────────────────────────────

/** `removed` de Netflix sobre un título que la base no conoce. Prime sigue. */
const paginaRemoved = (extra: { hasMore?: boolean; nextCursor?: string } = {}) =>
  respuestaCruda({
    cambios: [
      {
        changeType: "removed",
        showId: "1",
        service: "netflix",
        type: "subscription",
        link: "https://netflix.test/1",
        timestamp: HACE_UNA_HORA,
      },
    ],
    shows: [
      showCrudo({
        id: "1",
        imdbId: "tt0000001",
        opciones: [
          { service: "prime", type: "subscription", link: "https://prime.test/1" },
        ],
      }),
    ],
    ...extra,
  });

/**
 * `new` de Netflix sobre un título que la base no conoce. El snapshot trae
 * además una oferta de Prime **que ningún aviso nombra**.
 */
const paginaNew = (
  id: string,
  extra: { hasMore?: boolean; nextCursor?: string; timestamp?: number } = {},
) =>
  respuestaCruda({
    cambios: [
      {
        changeType: "new",
        showId: id,
        service: "netflix",
        type: "subscription",
        link: `https://netflix.test/${id}`,
        timestamp: extra.timestamp ?? HACE_UNA_HORA,
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
    ...(extra.hasMore === undefined ? {} : { hasMore: extra.hasMore }),
    ...(extra.nextCursor === undefined ? {} : { nextCursor: extra.nextCursor }),
  });

// ── Dobles ──────────────────────────────────────────────────────────────────

/**
 * Ejecutor de datos con **semántica transaccional mínima**: lo escrito entre
 * `BEGIN` y `COMMIT` pasa a `confirmadas`; lo escrito antes de un `ROLLBACK`
 * se descarta. Y puede fallar a propósito.
 */
function ejecutorTransaccional(
  opciones: { fallarEn?: (texto: string) => boolean } = {},
) {
  const bd = crearEjecutorFalso();
  const control: string[] = [];
  const confirmadas: string[] = [];
  let enCurso: string[] = [];

  const ejecutor: EjecutorSql = {
    async ejecutar<T>(texto: string, valores?: readonly unknown[]) {
      const t = texto.trim();
      if (t === "BEGIN" || t.startsWith("SAVEPOINT")) {
        control.push(t);
        enCurso = [];
        return [] as readonly T[];
      }
      if (t === "COMMIT" || t.startsWith("RELEASE")) {
        control.push(t);
        confirmadas.push(...enCurso);
        enCurso = [];
        return [] as readonly T[];
      }
      if (t === "ROLLBACK" || t.startsWith("ROLLBACK TO")) {
        control.push(t);
        enCurso = [];
        return [] as readonly T[];
      }
      if (opciones.fallarEn?.(t) === true) throw new Error("fallo inyectado");
      enCurso.push(t);
      return bd.ejecutor.ejecutar<T>(texto, valores);
    },
  };
  return { ejecutor, control, confirmadas: () => confirmadas };
}

interface Servida {
  readonly cuerpo: Record<string, unknown>;
  readonly cabeceras?: Record<string, string>;
}

const CUOTA_HOLGADA = {
  "x-quota-used": "120",
  "x-quota-granted": "1000",
  "x-quota-reset": "2026-10-01T00:00:00Z",
};

/** El fin del ciclo del libro para `AHORA`: el 1 de octubre, 00:00 UTC. */
const FIN_DEL_CICLO = new Date("2026-10-01T00:00:00.000Z");

/** Sirve respuestas en orden **pasando por la fuente de cuota**, como el real. */
function llamadaServida(servidas: readonly Servida[]) {
  const urls: string[] = [];
  const crear = (fuente: FuenteDeCuota): Transporte => {
    return async (url) => {
      await fuente.pedirCuota();
      urls.push(url);
      const s = servidas[urls.length - 1] ?? { cuerpo: { changes: [], shows: {} } };
      return new Response(JSON.stringify(s.cuerpo), {
        status: 200,
        headers: {
          "content-type": "application/json",
          ...(s.cabeceras ?? CUOTA_HOLGADA),
        },
      });
    };
  };
  return { crear, urls };
}

function presupuestoConTope(tope: number) {
  return leerPresupuesto({ STREAMING_API_PER_RUN_CAPS: `deltas=${String(tope)}` });
}

function directorioTemporal(): string {
  return mkdtempSync(join(tmpdir(), "deltas-job-"));
}

async function correrJob(entrada: {
  readonly servidas: readonly Servida[];
  readonly tope: number;
  readonly datos?: EjecutorSql;
  readonly directorio?: string;
  readonly reanudarEn?: { tipo: "removed" | "new"; cursor: string | null };
  readonly ventana?: typeof VENTANA;
  /** Un libro con historia: para que una ejecución vea lo que dejó otra. */
  readonly libro?: LibroEnMemoria;
}) {
  const libro = entrada.libro ?? crearLibroEnMemoria();
  const red = llamadaServida(entrada.servidas);
  const datos = entrada.datos ?? ejecutorTransaccional().ejecutor;
  const directorio = entrada.directorio ?? directorioTemporal();
  const ventana = entrada.ventana ?? VENTANA;
  const salida = await ejecutarJobDeDeltas({
    ejecutorOps: libro.ejecutor,
    ejecutorDatos: datos,
    transaccion: transaccionPorPagina(datos),
    presupuesto: presupuestoConTope(entrada.tope),
    crearLlamada: red.crear,
    apiKey: "k",
    plan: {
      origen: "fijo",
      ventana,
      ...(entrada.reanudarEn === undefined ? {} : { reanudarEn: entrada.reanudarEn }),
    },
    ahora: AHORA,
    crearRegistro: (cabecera) =>
      crearRegistroLocal(directorio, { modo: "ensayo", ...cabecera }),
    vincularEventos: false,
  });
  return { salida, libro, red, directorio };
}

// ── 0 · El tope aprobado, congelado ──────────────────────────────────────────

describe("el tope por ejecución de `deltas` es 4, y solo el de `deltas`", () => {
  it("congelado en 4 (Paso 5, 2026-09-23): 2 medidos por día, 4 como cerrojo", () => {
    // Cambiarlo exige tocar este test: el número tiene que decidirse, no
    // deslizarse. Ver el comentario de TOPE_POR_EJECUCION_POR_DEFECTO.
    expect(TOPE_POR_EJECUCION_POR_DEFECTO.deltas).toBe(4);
    expect(leerPresupuesto({}).topePorEjecucion.deltas).toBe(4);
  });

  it("cumple el invariante tope ≤ techo mensual", () => {
    const p = leerPresupuesto({});
    expect(p.topePorEjecucion.deltas).toBeLessThanOrEqual(
      p.techoMensualPorPipeline.deltas,
    );
  });

  it("con tope 0, el job no puede hacer ni una request", async () => {
    const { salida } = await correrJob({
      servidas: [{ cuerpo: paginaRemoved() }],
      tope: 0,
    });
    expect(salida.contadores.reservasConcedidas).toBe(0);
    expect(salida.resultado.ejecutado && salida.resultado.estado).toBe(
      "budget_stopped",
    );
  });
});

// ── 1 · Transacción por página ───────────────────────────────────────────────

describe("una transacción por página", () => {
  it("cada página confirma estado, reconciliación y eventos en su propio BEGIN/COMMIT", async () => {
    const datos = ejecutorTransaccional();
    const { salida } = await correrJob({
      servidas: [{ cuerpo: paginaRemoved() }, { cuerpo: paginaNew("2") }],
      tope: 4,
      datos: datos.ejecutor,
    });
    expect(salida.resultado.ejecutado && salida.resultado.estado).toBe("succeeded");
    expect(datos.control).toEqual(["BEGIN", "COMMIT", "BEGIN", "COMMIT"]);
    // Todo lo escrito quedó dentro de alguna transacción confirmada.
    expect(
      datos.confirmadas().some((t) => t.includes("external_availability_events")),
    ).toBe(true);
  });

  it("el ensayo usa SAVEPOINT/RELEASE, y ROLLBACK TO si falla", async () => {
    const sentencias: string[] = [];
    const ejecutor: EjecutorSql = {
      ejecutar<T>(texto: string) {
        sentencias.push(texto);
        return Promise.resolve([] as readonly T[]);
      },
    };
    const tx = transaccionConSavepoint(ejecutor);
    await tx(() => Promise.resolve(1));
    await expect(tx(() => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(sentencias).toEqual([
      "SAVEPOINT deltas_pagina",
      "RELEASE SAVEPOINT deltas_pagina",
      "SAVEPOINT deltas_pagina",
      "ROLLBACK TO SAVEPOINT deltas_pagina",
      "RELEASE SAVEPOINT deltas_pagina",
    ]);
  });
});

describe("fallo DESPUÉS de escribir el estado y ANTES del evento", () => {
  const correr = async () => {
    const datos = ejecutorTransaccional({
      fallarEn: (t) => t.startsWith("INSERT INTO external_availability_events"),
    });
    const r = await correrJob({
      servidas: [
        { cuerpo: respuestaCruda({ cambios: [], shows: [] }) },
        { cuerpo: paginaNew("2") },
      ],
      tope: 4,
      datos: datos.ejecutor,
    });
    return { ...r, datos };
  };

  it("la página se revierte ENTERA: ni estado ni evento quedan confirmados", async () => {
    const { datos, libro } = await correr();
    // `removed` llega vacía y aun así abre transacción —su cursor tiene que
    // quedar confirmado (ADR 0006)—; la de `new` se revierte.
    expect(datos.control).toEqual(["BEGIN", "COMMIT", "BEGIN", "ROLLBACK"]);
    // El estado SÍ se llegó a escribir dentro de la transacción…
    // …pero nada de ella sobrevive: ni títulos ni opciones ni eventos.
    expect(datos.confirmadas()).toEqual([]);
    // El checkpoint confirmó `removed` y apunta a la primera de `new`.
    expect(libro.filas[0]?.checkpoint).toMatchObject({
      pendiente: { changeType: "new", cursorDeEntrada: null },
      paginasConfirmadas: 1,
    });
  });

  it("la ejecución cierra `failed`, la cuota gastada sigue contada", async () => {
    const { salida, libro } = await correr();
    expect(salida.resultado.ejecutado && salida.resultado.estado).toBe("failed");
    // Dos requests salieron (removed vacía + new) y las dos siguen contadas,
    // aunque la segunda página se revirtiera: la cuota no se devuelve.
    expect(salida.contadores.reservasConcedidas).toBe(2);
    expect(libro.filas[0]?.requestsMade).toBe(2);
  });

  it("el punto de reanudación NO avanza: la página se vuelve a pedir", async () => {
    const { salida, directorio } = await correr();
    // `removed` se agotó (página vacía) y `new` falló en su primera página.
    expect(salida.reanudacion?.changeType).toBe("new");
    expect(salida.reanudacion?.cursorDeEntrada).toBeNull();
    // Y el crudo se guardó antes de procesarse: se puede reproducir sin cuota.
    const ficheros = readdirSync(directorio).filter((f) => f.endsWith("-new.json"));
    expect(ficheros).toHaveLength(1);
  });
});

// ── 2 · Línea base sin `added` falso ─────────────────────────────────────────

describe("línea base: un título nuevo trae ofertas que nadie anunció", () => {
  async function correr(
    pagina: Record<string, unknown>,
    tipo: "new" | "removed" | "updated",
  ) {
    const bd = crearEjecutorFalso();
    const red = crearTransporteFalso([pagina]);
    return ejecutarDeltas({
      ejecutor: bd.ejecutor,
      peticion: { transporte: red.transporte, apiKey: "k" },
      tipos: [tipo],
      ventana: VENTANA,
      ahora: AHORA,
      maximoDePaginas: 5,
    });
  }

  it("`new` sin estado previo: `added` SOLO para la oferta que el aviso nombra", async () => {
    const informe = await correr(paginaNew("2"), "new");
    expect(informe.eventos).toEqual({ added: 1 });
    // La de Prime se escribe como estado, pero no se fecha como alta de hoy.
    expect(informe.ofertasDeLineaBase).toBe(1);
  });

  it("`removed` sin estado previo: ningún evento, ni `removed` ni `added`", async () => {
    const informe = await correr(paginaRemoved(), "removed");
    expect(informe.eventos).toEqual({});
    expect(informe.retiradasSinEstadoPrevio).toBe(1);
    expect(informe.ofertasDeLineaBase).toBe(1);
  });

  it("`removed` que el snapshot aún lista, sin estado previo: tampoco es un alta", async () => {
    const pagina = respuestaCruda({
      cambios: [
        {
          changeType: "removed",
          showId: "3",
          service: "netflix",
          type: "subscription",
          link: "https://netflix.test/3-viejo",
          timestamp: HACE_UNA_HORA,
        },
      ],
      shows: [
        showCrudo({
          id: "3",
          imdbId: "tt0000003",
          opciones: [
            {
              service: "netflix",
              type: "subscription",
              link: "https://netflix.test/3",
            },
          ],
        }),
      ],
    });
    const informe = await correr(pagina, "removed");
    expect(informe.eventos).toEqual({});
    expect(informe.retiradasSinEstadoPrevio).toBe(1);
  });

  it("`updated` sin estado previo: dice que la oferta YA existía, no hay alta", async () => {
    const pagina = paginaNew("4");
    const cambios = pagina.changes as { changeType: string }[];
    for (const c of cambios) c.changeType = "updated";
    const informe = await correr(pagina, "updated");
    expect(informe.eventos).toEqual({});
    expect(informe.ofertasDeLineaBase).toBe(2);
  });

  it("con estado previo, el aviso no hace falta: se compara como siempre", async () => {
    // La oferta de Prime ya existía con otra calidad: es un `changed` legítimo.
    const bd = crearEjecutorFalso([
      {
        imdb_id: "tt0000002",
        availability_id: 77,
        platform_id: "prime",
        offer_type: "subscription",
        addon: null,
        option_id: 501,
        link: "https://prime.test/2",
        quality: "hd",
        price_amount: null,
        price_currency: null,
        audio_languages: ["spa"],
        subtitle_languages: ["spa"],
        available_since: null,
        expires_at: null,
        first_seen_at: new Date("2026-09-01T00:00:00Z"),
        missing_streak: 0,
      },
    ]);
    const red = crearTransporteFalso([paginaNew("2")]);
    const informe = await ejecutarDeltas({
      ejecutor: bd.ejecutor,
      peticion: { transporte: red.transporte, apiKey: "k" },
      tipos: ["new"],
      ventana: VENTANA,
      ahora: AHORA,
      maximoDePaginas: 5,
    });
    expect(informe.eventos).toEqual({ added: 1, changed: 1 });
    expect(informe.ofertasDeLineaBase).toBe(0);
  });
});

// ── 3 · Corte y reanudación ──────────────────────────────────────────────────

describe("corte por tope y reanudación exacta", () => {
  // removed: 1 página · new: 2 páginas → 3 requests. Con tope 2, la tercera
  // se deniega y quedan avisos de `new` sin ver.
  const servidas: Servida[] = [
    { cuerpo: paginaRemoved() },
    { cuerpo: paginaNew("2", { hasMore: true, nextCursor: "1790000000:42" }) },
    { cuerpo: paginaNew("5", { timestamp: HACE_UNA_HORA + 60 }) },
  ];

  it("cierra `budget_stopped` y el punto conserva tipo, ventana, cursor y timestamp", async () => {
    const { salida } = await correrJob({ servidas, tope: 2 });
    expect(salida.resultado.ejecutado && salida.resultado.estado).toBe(
      "budget_stopped",
    );
    expect(salida.contadores.reservasConcedidas).toBe(2);
    expect(salida.reanudacion).toEqual({
      changeType: "new",
      from: Math.floor(VENTANA.desde.getTime() / 1000),
      to: Math.floor(VENTANA.hasta.getTime() / 1000),
      cursorDeEntrada: "1790000000:42",
      ultimoTimestamp: new Date(HACE_UNA_HORA * 1000).toISOString(),
    });
  });

  it("error_samples guarda el punto de reanudación DENTRO de la muestra del corte", async () => {
    const { salida, libro } = await correrJob({ servidas, tope: 2 });
    const muestras = libro.filas[0]?.errorSamples ?? [];
    expect(muestras).toHaveLength(1);
    expect(muestras[0]?.motivo).toBe("tope_por_ejecucion");
    expect(muestras[0]?.reanudacion).toEqual(salida.reanudacion);
  });

  it("el manifiesto local guarda lo mismo, y las páginas con su cursor", async () => {
    const { salida, directorio } = await correrJob({ servidas, tope: 2 });
    const m = leerManifiesto(directorio);
    expect(m.estado).toBe("budget_stopped");
    expect(m.reanudacion).toEqual(salida.reanudacion);
    expect(m.requests.reservadas).toBe(2);
    expect(
      m.paginas.map((p) => [p.changeType, p.pagina, p.nextCursor, p.hasMore]),
    ).toEqual([
      ["removed", 1, null, false],
      ["new", 1, "1790000000:42", true],
    ]);
    // El crudo de cada respuesta, tal cual llegó.
    const crudo = JSON.parse(
      readFileSync(join(directorio, "002-new.json"), "utf8"),
    ) as {
      nextCursor: string;
    };
    expect(crudo.nextCursor).toBe("1790000000:42");
  });

  it("reanudar pide LA MISMA ventana y el cursor pendiente, sin recalcular «24 h»", async () => {
    const primera = await correrJob({ servidas, tope: 2 });
    const plan = planDeReanudacion(leerManifiesto(primera.directorio));
    expect(plan.reanudarEn).toEqual({ tipo: "new", cursor: "1790000000:42" });

    const segunda = await correrJob({
      servidas: [{ cuerpo: paginaNew("5") }],
      tope: 2,
      ventana: plan.ventana,
      reanudarEn: { tipo: "new", cursor: plan.reanudarEn.cursor },
    });
    expect(segunda.red.urls).toHaveLength(1);
    const q = new URL(segunda.red.urls[0] ?? "").searchParams;
    expect(q.get("change_type")).toBe("new");
    expect(q.get("cursor")).toBe("1790000000:42");
    expect(Number(q.get("from"))).toBe(plan.punto.from);
    expect(Number(q.get("to"))).toBe(plan.punto.to);
    expect(segunda.salida.resultado.ejecutado && segunda.salida.resultado.estado).toBe(
      "succeeded",
    );
    expect(segunda.salida.reanudacion).toBeNull();
  });

  it("no hay reanudación que inventar si la ejecución terminó entera", async () => {
    const { directorio } = await correrJob({ servidas, tope: 4 });
    expect(() => planDeReanudacion(leerManifiesto(directorio))).toThrow(
      /sin punto de reanudación/,
    );
  });

  it("un job de un solo tipo también corta por cuota, nunca por páginas en silencio", async () => {
    // Con maximoDePaginas = tope, las páginas se acabarían antes que la cuota
    // y la ejecución cerraría `succeeded` con avisos sin ver.
    const libro = crearLibroEnMemoria();
    const red = llamadaServida([
      { cuerpo: paginaNew("2", { hasMore: true, nextCursor: "c1" }) },
      { cuerpo: paginaNew("5", { hasMore: true, nextCursor: "c2" }) },
      { cuerpo: paginaNew("6") },
    ]);
    const datos = ejecutorTransaccional().ejecutor;
    const salida = await ejecutarJobDeDeltas({
      ejecutorOps: libro.ejecutor,
      ejecutorDatos: datos,
      transaccion: transaccionPorPagina(datos),
      presupuesto: presupuestoConTope(2),
      crearLlamada: red.crear,
      apiKey: "k",
      plan: { origen: "fijo", ventana: VENTANA },
      tipos: ["new"],
      ahora: AHORA,
      crearRegistro: null,
      vincularEventos: false,
    });
    expect(salida.resultado.ejecutado && salida.resultado.estado).toBe(
      "budget_stopped",
    );
    expect(salida.reanudacion?.cursorDeEntrada).toBe("c2");
  });
});

// ── 4 · Guardia de cuota externa ─────────────────────────────────────────────

describe("las cabeceras del proveedor", () => {
  it("se leen tal cual y el umbral es floor(granted × 0,90)", () => {
    const cuota = leerCuotaDelProveedor(new Headers(CUOTA_HOLGADA));
    expect(cuota).toEqual({
      usada: 120,
      concedida: 1000,
      reinicio: "2026-10-01T00:00:00Z",
      umbral: 900,
    });
    expect(
      leerCuotaDelProveedor(new Headers({ ...CUOTA_HOLGADA, "x-quota-granted": "999" }))
        ?.umbral,
    ).toBe(899);
  });

  it("si falta o no se entiende alguna, no se inventa: null", () => {
    expect(leerCuotaDelProveedor(new Headers())).toBeNull();
    expect(
      leerCuotaDelProveedor(
        new Headers({ ...CUOTA_HOLGADA, "x-quota-used": "muchas" }),
      ),
    ).toBeNull();
    expect(
      leerCuotaDelProveedor(new Headers({ ...CUOTA_HOLGADA, "x-quota-reset": "" })),
    ).toBeNull();
  });

  it("899 de 1000 deja pasar; 900 de 1000 cierra la guardia", () => {
    const guardia = crearGuardiaDeCuotaExterna("deltas", {
      finDelCiclo: FIN_DEL_CICLO,
    });
    guardia.observar(new Headers({ ...CUOTA_HOLGADA, "x-quota-used": "899" }));
    expect(() => guardia.comprobar()).not.toThrow();
    guardia.observar(new Headers({ ...CUOTA_HOLGADA, "x-quota-used": "900" }));
    expect(() => guardia.comprobar()).toThrow(/cuota_del_proveedor/);
  });

  it("no suma ningún desfase inventado: solo lo que dice la cabecera", () => {
    const guardia = crearGuardiaDeCuotaExterna("deltas", {
      finDelCiclo: FIN_DEL_CICLO,
    });
    guardia.observar(new Headers({ ...CUOTA_HOLGADA, "x-quota-used": "5" }));
    expect(guardia.observaciones()[0]?.usada).toBe(5);
    expect(() => guardia.comprobar()).not.toThrow();
  });

  it("el fin del ciclo del libro es el reinicio que anuncia el proveedor", () => {
    expect(calcularCiclo(AHORA, 1).fin.getTime()).toBe(FIN_DEL_CICLO.getTime());
  });

  it("un x-quota-reset distinto del fin del ciclo cierra como ciclo_desalineado", () => {
    const guardia = crearGuardiaDeCuotaExterna("deltas", {
      finDelCiclo: FIN_DEL_CICLO,
    });
    // Lo que habría pasado con el ciclo antiguo: fin a las 22:00 UTC del 30.
    guardia.observar(
      new Headers({ ...CUOTA_HOLGADA, "x-quota-reset": "2026-09-30T22:00:00Z" }),
    );
    expect(() => guardia.comprobar()).toThrow(/ciclo_desalineado/);
  });

  it("compara instantes, no textos: el mismo reinicio con milisegundos coincide", () => {
    const guardia = crearGuardiaDeCuotaExterna("deltas", {
      finDelCiclo: FIN_DEL_CICLO,
    });
    guardia.observar(
      new Headers({ ...CUOTA_HOLGADA, "x-quota-reset": "2026-10-01T00:00:00.000Z" }),
    );
    expect(() => guardia.comprobar()).not.toThrow();
  });

  it("desalineada Y en el umbral: gana el desalineamiento, que es configuración", () => {
    const guardia = crearGuardiaDeCuotaExterna("deltas", {
      finDelCiclo: FIN_DEL_CICLO,
    });
    guardia.observar(
      new Headers({
        ...CUOTA_HOLGADA,
        "x-quota-used": "950",
        "x-quota-reset": "2026-10-15T00:00:00Z",
      }),
    );
    expect(() => guardia.comprobar()).toThrow(/ciclo_desalineado/);
  });

  it("prearmada, se cierra antes de observar nada", () => {
    const guardia = crearGuardiaDeCuotaExterna("deltas", {
      finDelCiclo: FIN_DEL_CICLO,
    });
    guardia.prearmar({
      runId: 7,
      pipeline: "expiring",
      usada: 901,
      umbral: 900,
      concedida: 1000,
      reinicio: "2026-10-01T00:00:00Z",
    });
    expect(() => guardia.comprobar()).toThrow(/cuota_del_proveedor/);
    expect(guardia.observaciones()).toEqual([]);
  });
});

describe("buscarCorteVigente", () => {
  const CICLO = calcularCiclo(AHORA, 1);
  const corte = (reinicio: unknown) => ({
    motivo: "cuota_del_proveedor",
    estado: "umbral_alcanzado",
    consumido: 900,
    techo: 900,
    x_quota_used: 900,
    x_quota_granted: 1000,
    x_quota_reset: reinicio,
  });

  it("encuentra el corte de CUALQUIER pipeline: la cuota del proveedor es una", async () => {
    const libro = crearLibroEnMemoria();
    libro.sembrar("expiring", 3, [corte("2026-10-01T00:00:00Z")]);
    const vigente = await buscarCorteVigente(libro.ejecutor, {
      ciclo: CICLO,
      ahora: AHORA,
    });
    expect(vigente).toMatchObject({
      runId: 1,
      pipeline: "expiring",
      usada: 900,
      umbral: 900,
      concedida: 1000,
      reinicio: "2026-10-01T00:00:00Z",
    });
  });

  it("un corte cuyo reinicio ya llegó no prearma nada", async () => {
    const libro = crearLibroEnMemoria();
    libro.sembrar("deltas", 1, [corte("2026-09-23T09:00:00Z")]);
    expect(
      await buscarCorteVigente(libro.ejecutor, { ciclo: CICLO, ahora: AHORA }),
    ).toBeNull();
  });

  it("un reinicio ilegible no prearma nada: no se inventa", async () => {
    const libro = crearLibroEnMemoria();
    libro.sembrar("deltas", 1, [corte("pronto"), corte(null)]);
    expect(
      await buscarCorteVigente(libro.ejecutor, { ciclo: CICLO, ahora: AHORA }),
    ).toBeNull();
  });

  it("las muestras que no son cortes por umbral no cuentan", async () => {
    const libro = crearLibroEnMemoria();
    libro.sembrar("deltas", 1, [
      { ...corte("2026-10-01T00:00:00Z"), estado: "cabeceras_ausentes_o_invalidas" },
      { motivo: "tope_por_ejecucion", consumido: 4, techo: 4 },
    ]);
    expect(
      await buscarCorteVigente(libro.ejecutor, { ciclo: CICLO, ahora: AHORA }),
    ).toBeNull();
  });
});

describe("la guardia externa dentro del job", () => {
  const alUmbral = { ...CUOTA_HOLGADA, "x-quota-used": "900" };

  it("tras una respuesta en el 90 %, no sale otra request en esa ejecución", async () => {
    const { salida, red } = await correrJob({
      servidas: [
        { cuerpo: paginaRemoved(), cabeceras: alUmbral },
        { cuerpo: paginaNew("2") },
      ],
      tope: 4,
    });
    expect(red.urls).toHaveLength(1);
    // La negativa es ANTES de reservar: el libro interno no cuenta una request
    // que no salió.
    expect(salida.contadores.reservasConcedidas).toBe(1);
    expect(salida.resultado.ejecutado && salida.resultado.estado).toBe(
      "budget_stopped",
    );
  });

  it("el cierre es explícito y auditable: motivo propio, cabeceras y punto de reanudación", async () => {
    const { libro, salida } = await correrJob({
      servidas: [
        { cuerpo: paginaRemoved(), cabeceras: alUmbral },
        { cuerpo: paginaNew("2") },
      ],
      tope: 4,
    });
    const muestra = libro.filas[0]?.errorSamples[0];
    expect(muestra).toMatchObject({
      motivo: "cuota_del_proveedor",
      consumido: 900,
      techo: 900,
      fuente: "cabeceras_del_proveedor",
      estado: "umbral_alcanzado",
      x_quota_used: 900,
      x_quota_granted: 1000,
      x_quota_reset: "2026-10-01T00:00:00Z",
    });
    expect(muestra?.reanudacion).toEqual(salida.reanudacion);
    expect(salida.reanudacion?.changeType).toBe("new");
  });

  it("sin cabeceras de cuota, tampoco sigue: sin comprobación externa no hay otra request", async () => {
    const { libro, red } = await correrJob({
      servidas: [
        { cuerpo: paginaRemoved(), cabeceras: { "content-type": "application/json" } },
        { cuerpo: paginaNew("2") },
      ],
      tope: 4,
    });
    expect(red.urls).toHaveLength(1);
    expect(libro.filas[0]?.status).toBe("budget_stopped");
    expect(libro.filas[0]?.errorSamples[0]).toMatchObject({
      motivo: "cuota_del_proveedor",
      estado: "cabeceras_ausentes_o_invalidas",
    });
  });

  it("la ejecución SIGUIENTE no gasta ni una request para volver a oír el 90 %", async () => {
    const libro = crearLibroEnMemoria();
    await correrJob({
      servidas: [{ cuerpo: paginaRemoved(), cabeceras: alUmbral }],
      tope: 4,
      libro,
    });
    const { salida, red } = await correrJob({
      servidas: [{ cuerpo: paginaRemoved() }],
      tope: 4,
      libro,
    });
    expect(red.urls).toHaveLength(0);
    expect(salida.contadores.reservasConcedidas).toBe(0);
    expect(libro.filas[1]?.requestsMade).toBe(0);
    expect(libro.filas[1]?.status).toBe("budget_stopped");
    // La muestra tiene la misma forma que un corte observado, así que la
    // tercera ejecución también la encuentra: la cadena dura hasta el reinicio.
    expect(libro.filas[1]?.errorSamples[0]).toMatchObject({
      motivo: "cuota_del_proveedor",
      estado: "umbral_alcanzado",
      fuente: "corte_registrado",
      x_quota_reset: "2026-10-01T00:00:00Z",
      prearmada_por_run_id: 1,
    });
    const { red: tercera } = await correrJob({
      servidas: [{ cuerpo: paginaRemoved() }],
      tope: 4,
      libro,
    });
    expect(tercera.urls).toHaveLength(0);
  });

  it("un corte ya reiniciado no bloquea: la ejecución sale con normalidad", async () => {
    const libro = crearLibroEnMemoria();
    libro.sembrar("deltas", 1, [
      {
        motivo: "cuota_del_proveedor",
        estado: "umbral_alcanzado",
        techo: 900,
        x_quota_used: 900,
        x_quota_granted: 1000,
        x_quota_reset: "2026-09-01T00:00:00Z",
      },
    ]);
    const { salida, red } = await correrJob({
      servidas: [{ cuerpo: paginaRemoved() }, { cuerpo: paginaNew("2") }],
      tope: 4,
      libro,
    });
    expect(red.urls).toHaveLength(2);
    expect(salida.resultado.ejecutado && salida.resultado.estado).toBe("succeeded");
  });

  it("un reinicio desalineado cierra FAILED tras confirmar la página que ya pagó", async () => {
    const desalineada = { ...CUOTA_HOLGADA, "x-quota-reset": "2026-09-30T22:00:00Z" };
    const { salida, libro, red } = await correrJob({
      servidas: [
        { cuerpo: paginaRemoved(), cabeceras: desalineada },
        { cuerpo: paginaNew("2") },
      ],
      tope: 4,
    });
    // Una sola request: la que reveló el desalineamiento.
    expect(red.urls).toHaveLength(1);
    expect(salida.resultado.ejecutado && salida.resultado.estado).toBe("failed");
    expect(libro.filas[0]?.errorSamples[0]).toMatchObject({
      motivo: "ciclo_desalineado",
      estado: "reinicio_distinto_del_fin_del_ciclo",
      x_quota_reset: "2026-09-30T22:00:00Z",
      fin_del_ciclo: "2026-10-01T00:00:00.000Z",
    });
    // La página pagada no se tira: se confirmó y el punto apunta a la siguiente.
    expect(salida.reanudacion).toMatchObject({
      changeType: "new",
      cursorDeEntrada: null,
    });
  });
});

// ── 5 · El cuadre de requests ────────────────────────────────────────────────

describe("el cuadre de requests", () => {
  const cuota = (usada: number) => ({
    usada,
    concedida: 1000,
    reinicio: "2026-10-01T00:00:00Z",
    umbral: 900,
  });

  it("cuadra cuando libro, reservas, respuestas y proveedor dicen lo mismo", () => {
    const r = verificarCuadre({
      requestsMade: 2,
      reservasConcedidas: 2,
      deltaDelLibro: 2,
      respuestas: 2,
      cuota: [cuota(103), cuota(104)],
    });
    expect(r.every((c) => c.ok)).toBe(true);
  });

  it("señala un Δ del proveedor que no cuadra: alguien más usó la clave", () => {
    const r = verificarCuadre({
      requestsMade: 2,
      reservasConcedidas: 2,
      deltaDelLibro: 2,
      respuestas: 2,
      cuota: [cuota(103), cuota(110)],
    });
    expect(r.find((c) => c.nombre.includes("proveedor"))?.ok).toBe(false);
  });

  it("sin cabeceras, el cuadre externo es SIN DATOS, no un aprobado", () => {
    const r = verificarCuadre({
      requestsMade: 1,
      reservasConcedidas: 1,
      deltaDelLibro: 1,
      respuestas: 1,
      cuota: [],
    });
    const externa = r.find((c) => c.nombre.includes("proveedor"));
    expect(externa?.ok).toBe(false);
    expect(externa?.detalle).toMatch(/SIN DATOS/);
  });
});
