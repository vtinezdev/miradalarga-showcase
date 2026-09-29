/**
 * `pnpm job upcoming`: registro, guardas, códigos de salida y ejecuciones
 * completas. **Sin red y sin base de datos.**
 *
 * Las ejecuciones completas corren `ejecutarUpcomingProgramado` con el
 * presupuesto **del repositorio** —sin inyectar nada—, así que también prueban
 * que el tope aprobado (8) y el techo mensual (40) son los que de verdad
 * gobiernan el job.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Conexion } from "../../jobs/ops/conexion.ts";
import type { EjecutorSql, MuestraDeError } from "../../jobs/ops/contratos.ts";
import { NS_CATALOGO } from "../../jobs/ops/bloqueo.ts";
import { crearLibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import type { LibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import {
  TECHO_MENSUAL_POR_DEFECTO,
  TOPE_POR_EJECUCION_POR_DEFECTO,
} from "../../jobs/ops/presupuesto.ts";
import type { FuenteDeCuota, Transporte } from "../../jobs/ops/transporte.ts";
import { ventanaEnSegundos } from "../../jobs/pipelines/deltas/manifiesto.ts";
import { ventanaHaciaDelante } from "../../jobs/pipelines/deltas/origen.ts";
import type { DestinoVerificado } from "../../jobs/pipelines/programado.ts";
import { planificarUpcoming } from "../../jobs/pipelines/upcoming/checkpoint.ts";
import type { ResultadoDelJobDeUpcoming } from "../../jobs/pipelines/upcoming/job.ts";
import { informeDeAnunciosVacio } from "../../jobs/pipelines/deltas/anuncios.ts";
import {
  ejecutarUpcomingProgramado,
  lineasDeAnunciosGuardados,
  veredictoDeUpcoming,
} from "../../jobs/pipelines/upcoming/programado.ts";
import {
  leerAnunciosVigentes,
  leerRecorridoDeReferencia,
} from "../../jobs/pipelines/upcoming/vigencia.ts";
import { PIPELINES_REGISTRADOS } from "../../jobs/registro.ts";
import { conexionDeDatos } from "./ayudas-checkpoint.ts";
import { respuestaCruda, showCrudo } from "./ayudas-deltas.ts";
import type { BaseEnMemoria } from "./base-en-memoria.ts";
import { crearBaseEnMemoria } from "./base-en-memoria.ts";

const RAIZ = join(import.meta.dirname, "..", "..");
const T = new Date("2026-09-24T10:00:00.000Z");
const DIA = 86_400_000;
const en = (dias: number, desde = T) => new Date(desde.getTime() + dias * DIA);
const seg = (d: Date) => Math.floor(d.getTime() / 1000);
const imdb = (id: string) => `tt${id.padStart(7, "0")}`;

const HOST = "ep-validacion.test";
const ENTORNO = {
  NEON_VALIDATION_HOST: HOST,
  STREAMING_AVAILABILITY_API_KEY: "clave-de-prueba",
};
const DESTINO: DestinoVerificado = {
  url: "postgres://usuario:secreto@ep-validacion.test/db",
  hostname: HOST,
  esConexionDirecta: true,
  rama: "drizzle-schema-v1-test",
};

// ── 1 · Registro ─────────────────────────────────────────────────────────────

describe("registro", () => {
  it("upcoming es un job oficial, junto a deltas y expiring, y nada más", () => {
    expect(Object.keys(PIPELINES_REGISTRADOS)).toEqual([
      "deltas",
      "expiring",
      "upcoming",
    ]);
    expect(typeof PIPELINES_REGISTRADOS.upcoming).toBe("function");
  });
});

// ── 2 · Códigos de salida: el veredicto, puro ────────────────────────────────

function salida(entrada: {
  estado?: "succeeded" | "failed" | "budget_stopped";
  muestras?: readonly MuestraDeError[];
  noEjecutado?: "ya_hay_una_viva" | "catalogo_ocupado";
}): ResultadoDelJobDeUpcoming {
  // Un checkpoint de hace diez días, cortado: con la regla de `deltas`
  // sería retraso_excesivo. Aquí no significa nada.
  const plan = planificarUpcoming(en(-10));
  return {
    resultado:
      entrada.noEjecutado !== undefined
        ? { ejecutado: false, motivo: entrada.noEjecutado }
        : {
            ejecutado: true,
            runId: 7,
            estado: entrada.estado ?? "succeeded",
            huerfanasCerradas: [],
            metricas: {
              rowsAffected: null,
              multiLinkOffers: 0,
              farFutureExpiries: 0,
              errorCount: entrada.muestras?.length ?? 0,
              errorSamples: entrada.muestras ?? [],
            },
          },
    informe: null,
    contadores: { reservasConcedidas: 0, respuestas: 0, respuestasOk: 0 },
    cuotaDelProveedor: [],
    reanudacion: null,
    checkpoint: {
      ...plan,
      pendiente: { changeType: "upcoming", cursorDeEntrada: "c9" },
    },
    horizonte: null,
    anuncios: null,
    anunciosGuardados: null,
  };
}

describe("códigos de salida", () => {
  it("succeeded → 0", () => {
    expect(veredictoDeUpcoming(salida({}))).toEqual({
      codigo: 0,
      nivel: "ok",
      motivo: "succeeded",
    });
  });

  it.each(["ya_hay_una_viva", "catalogo_ocupado"] as const)(
    "lock ocupado (%s) → 0 con aviso",
    (motivo) => {
      expect(veredictoDeUpcoming(salida({ noEjecutado: motivo }))).toEqual({
        codigo: 0,
        nivel: "aviso",
        motivo,
      });
    },
  );

  it("budget_stopped por tope de ejecución → 0 con aviso", () => {
    const v = veredictoDeUpcoming(
      salida({
        estado: "budget_stopped",
        muestras: [{ motivo: "tope_por_ejecucion", consumido: 8, techo: 8 }],
      }),
    );
    expect(v).toEqual({ codigo: 0, nivel: "aviso", motivo: "tope_por_ejecucion" });
  });

  it.each(["mensual_del_pipeline", "global", "cuota_del_proveedor"])(
    "budget_stopped por %s → 2",
    (motivo) => {
      const v = veredictoDeUpcoming(
        salida({ estado: "budget_stopped", muestras: [{ motivo }] }),
      );
      expect(v).toEqual({ codigo: 2, nivel: "atencion", motivo });
    },
  );

  it("budget_stopped sin motivo reconocible → 2", () => {
    const v = veredictoDeUpcoming(salida({ estado: "budget_stopped", muestras: [] }));
    expect(v).toMatchObject({ codigo: 2, motivo: "corte_sin_motivo" });
  });

  it.each(["excepcion", "cursor_sin_progreso"])(
    "failed (%s) → 1, con el motivo de su muestra",
    (motivo) => {
      const v = veredictoDeUpcoming(
        salida({ estado: "failed", muestras: [{ motivo }] }),
      );
      expect(v).toEqual({ codigo: 1, nivel: "error", motivo });
    },
  );

  it("SIN regla de retraso: un corte viejo no convierte un tope en 2", () => {
    const v = veredictoDeUpcoming(
      salida({
        estado: "budget_stopped",
        muestras: [{ motivo: "tope_por_ejecucion" }],
      }),
    );
    expect(v.codigo).toBe(0);
    expect(v).not.toHaveProperty("retrasoMs");
  });
});

describe("lineasDeAnunciosGuardados: el resumen de anuncios, común al job y al script manual", () => {
  it("la primera línea suma todos los destinos; la segunda lleva las marcas que no suman", () => {
    const g = {
      ...informeDeAnunciosVacio(),
      observados: 12,
      nuevos: 3,
      nuevosCiclos: 1,
      actualizados: 2,
      sinCambios: 1,
      enlacesCompletados: 2,
      mismaObservacion: 1,
      fueraDeOrden: 1,
      conflictos: [
        {
          clave: "k",
          vigente: { anunciadoPara: "2026-10-01T00:00:00.000Z", enlace: null },
          descartado: { anunciadoPara: "2026-10-02T00:00:00.000Z", enlace: null },
        },
      ],
      sinEnlace: 4,
      enlacesConservados: 1,
      fechasCambiadas: 1,
      enlacesCambiados: 1,
    };
    const destinos =
      g.nuevos +
      g.nuevosCiclos +
      g.actualizados +
      g.sinCambios +
      g.enlacesCompletados +
      g.mismaObservacion +
      g.fueraDeOrden +
      g.conflictos.length;
    expect(destinos).toBe(g.observados);

    expect(lineasDeAnunciosGuardados(g, 1)).toEqual([
      "anuncios: 12 observados = nuevos 3 · ciclos nuevos 1 · actualizados 2 · " +
        "sin cambios 1 · enlaces completados 2 · misma observación 1 · " +
        "fuera de orden 1 · conflictos 1",
      "  de ellos: sin link 4 · enlaces conservados 1 · fecha cambiada 1 · " +
        "link cambiado 1 · repetidos en el crudo 1",
    ]);
  });

  it("sin resumen del crudo, no inventa los repetidos", () => {
    const [, marcas] = lineasDeAnunciosGuardados(informeDeAnunciosVacio(), null);
    expect(marcas).not.toMatch(/repetidos/);
  });

  it("scripts/run-upcoming-manual.ts la usa: los dos resúmenes no pueden divergir", () => {
    const fuente = readFileSync(
      join(RAIZ, "scripts", "run-upcoming-manual.ts"),
      "utf8",
    );
    expect(fuente).toMatch(/lineasDeAnunciosGuardados\(/);
    expect(fuente).not.toMatch(/anuncios guardados/);
  });
});

// ── 3 · Ejecuciones completas, con dobles ────────────────────────────────────

const CUOTA = {
  "x-quota-used": "122",
  "x-quota-granted": "1000",
  "x-quota-reset": "2026-10-01T00:00:00Z",
};

/** Un aviso `upcoming` con su show, que todavía no tiene opciones en ES. */
function anuncio(id: string, estreno: Date) {
  return {
    cambio: {
      changeType: "upcoming",
      showId: id,
      service: "netflix",
      type: "subscription",
      link: `https://netflix.test/${id}`,
      timestamp: seg(estreno),
    },
    show: showCrudo({ id, imdbId: imdb(id), opciones: [] }),
  };
}

function pagina(
  avisos: readonly ReturnType<typeof anuncio>[],
  nextCursor?: string,
  hasMore = nextCursor !== undefined,
): Record<string, unknown> {
  return respuestaCruda({
    cambios: avisos.map((a) => a.cambio),
    shows: avisos.map((a) => a.show),
    hasMore,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  });
}

type Listas = ReadonlyMap<string, Record<string, unknown>>;

/** `n` páginas de `upcoming` encadenadas por cursor, un anuncio en cada una. */
function listas(n: number, primerId = 400): Listas {
  return new Map(
    Array.from({ length: n }, (_, i) => [
      `upcoming|${i === 0 ? "" : `c${String(i)}`}`,
      pagina(
        [anuncio(String(primerId + i), en(2 + i))],
        i < n - 1 ? `c${String(i + 1)}` : undefined,
      ),
    ]),
  );
}

interface Mundo {
  readonly libro: LibroEnMemoria;
  readonly base: BaseEnMemoria;
}

const crearMundo = (): Mundo => ({
  libro: crearLibroEnMemoria(),
  base: crearBaseEnMemoria(),
});

async function correr(
  mundo: Mundo,
  entrada: {
    readonly paginas?: Listas;
    readonly ahora?: Date;
    readonly lockDePipelineOcupado?: boolean;
    readonly catalogoOcupado?: boolean;
    readonly entorno?: Readonly<Record<string, string>>;
    readonly destino?: DestinoVerificado;
    readonly aperturas?: string[];
    /** Cabeceras de cuota por clave de página, para la guardia externa. */
    readonly cuota?: ReadonlyMap<string, Readonly<Record<string, string>>>;
  } = {},
) {
  const urls: URL[] = [];
  const cerradas: string[] = [];
  let abiertas = 0;
  const paginas = entrada.paginas ?? listas(3);

  const ops: EjecutorSql = {
    ejecutar<T>(texto: string, valores?: readonly unknown[]) {
      if (texto.includes("pg_try_advisory_lock")) {
        const esCatalogo = valores?.[0] === NS_CATALOGO;
        const ocupado = esCatalogo
          ? entrada.catalogoOcupado === true
          : entrada.lockDePipelineOcupado === true;
        if (ocupado)
          return Promise.resolve([{ tomado: false }] as unknown as readonly T[]);
      }
      return mundo.libro.ejecutor.ejecutar<T>(texto, valores);
    },
  };
  const conectar = (url: string): Promise<Conexion> => {
    expect(url).toBe(DESTINO.url);
    abiertas++;
    entrada.aperturas?.push(url);
    const nombre = abiertas === 1 ? "ops" : "datos";
    const ejecutor =
      abiertas === 1 ? ops : conexionDeDatos(mundo.base, mundo.libro).ejecutor;
    return Promise.resolve({
      ejecutor,
      cerrar: () => {
        cerradas.push(nombre);
        return Promise.resolve();
      },
    });
  };
  const crearLlamada =
    (fuente: FuenteDeCuota): Transporte =>
    async (url) => {
      await fuente.pedirCuota();
      const u = new URL(url);
      urls.push(u);
      const clave = `${u.searchParams.get("change_type") ?? "?"}|${u.searchParams.get("cursor") ?? ""}`;
      const cuerpo = paginas.get(clave);
      if (cuerpo === undefined) throw new Error(`sin página para ${clave}`);
      return new Response(JSON.stringify(cuerpo), {
        status: 200,
        headers: {
          "content-type": "application/json",
          ...CUOTA,
          ...entrada.cuota?.get(clave),
        },
      });
    };

  const r = await ejecutarUpcomingProgramado({
    entorno: entrada.entorno ?? ENTORNO,
    destino: entrada.destino ?? DESTINO,
    conectar,
    crearLlamada,
    ahora: entrada.ahora ?? T,
    directorioDeRegistros: null,
  });
  const runId = r.salida.resultado.ejecutado ? r.salida.resultado.runId : null;
  return { ...r, urls, cerradas, runId };
}

/** «Próximamente» en `ahora`: los imdb vigentes, ordenados. */
async function proximamente(mundo: Mundo, ahora: Date): Promise<string[]> {
  const vigentes = await leerAnunciosVigentes(
    { datos: mundo.base.ejecutor, ops: mundo.libro.ejecutor },
    ahora,
  );
  return vigentes.map((v) => v.imdbId).sort();
}

describe("ejecutarUpcomingProgramado", () => {
  it("el recorrido medido —3 páginas—: 3 requests, exit 0, horizonte completo", async () => {
    const mundo = crearMundo();
    const r = await correr(mundo);
    expect(r.veredicto).toEqual({ codigo: 0, nivel: "ok", motivo: "succeeded" });
    expect(r.urls).toHaveLength(3);
    expect(r.salida.horizonte).toEqual({
      completo: true,
      desaparecidas: 0,
      muestra: [],
      fueraDeCobertura: 0,
    });
    expect(r.cerradas.sort()).toEqual(["datos", "ops"]);
    // Cada anuncio en su tabla; ni opciones sintéticas ni eventos.
    expect(mundo.base.anuncios()).toHaveLength(3);
    expect(r.salida.informe?.eventos).toEqual({});
    expect(r.salida.informe?.eventosEscritos).toBe(0);

    const texto = r.resumen.join("\n");
    expect(r.resumen[0]).toBe("upcoming · exit 0 · ok · succeeded");
    expect(texto).toMatch(/horizonte: 31 días/);
    expect(texto).toMatch(/páginas confirmadas: 3 · recorrido completo/);
    expect(r.resumen).toContain(
      "anuncios: 3 observados = nuevos 3 · ciclos nuevos 0 · actualizados 0 · " +
        "sin cambios 0 · enlaces completados 0 · misma observación 0 · " +
        "fuera de orden 0 · conflictos 0",
    );
    expect(r.resumen).toContain(
      "  de ellos: sin link 0 · enlaces conservados 0 · fecha cambiada 0 · " +
        "link cambiado 0 · repetidos en el crudo 0",
    );
    expect(texto).toMatch(/anuncios no observados: 0 \(solo se cuentan\)/);
    // El resumen no filtra la clave ni la cadena de conexión.
    expect(texto).not.toMatch(/clave-de-prueba|secreto|postgres:/);
  });

  it("📏 fila 57: el aviso que el cursor repite en la frontera es misma observación, y el resumen cuadra", async () => {
    // El cursor `timestamp:0` vuelve a servir en la página 2 el último aviso
    // de la página 1 (📏 «Título ficticio», tt90000085, 02-oct 07:00).
    const frontera = anuncio("401", en(8));
    const paginas: Listas = new Map([
      ["upcoming|", pagina([anuncio("400", en(2)), frontera], "c1")],
      ["upcoming|c1", pagina([frontera, anuncio("402", en(20))])],
    ]);
    const mundo = crearMundo();
    const r = await correr(mundo, { paginas });

    expect(r.veredicto.codigo).toBe(0);
    expect(mundo.base.anuncios()).toHaveLength(3);
    const g = r.salida.anunciosGuardados;
    expect(g).toMatchObject({
      observados: 4,
      nuevos: 3,
      mismaObservacion: 1,
      sinCambios: 0,
      actualizados: 0,
      enlacesCompletados: 0,
      nuevosCiclos: 0,
      fueraDeOrden: 0,
      conflictos: [],
    });
    expect(r.salida.anuncios?.repetidos).toBe(1);
    expect(r.salida.informe?.eventosEscritos).toBe(0);
    expect(r.resumen).toContain(
      "anuncios: 4 observados = nuevos 3 · ciclos nuevos 0 · actualizados 0 · " +
        "sin cambios 0 · enlaces completados 0 · misma observación 1 · " +
        "fuera de orden 0 · conflictos 0",
    );
    expect(r.resumen.join("\n")).toMatch(/repetidos en el crudo 1/);
  });

  it("pide la ventana [ahora − 60 s, ahora + 31 días], sin include_unknown_dates", async () => {
    const r = await correr(crearMundo(), { paginas: listas(1) });
    const esperada = ventanaEnSegundos(ventanaHaciaDelante(T, 31));
    const u = r.urls[0];
    expect(u?.searchParams.get("change_type")).toBe("upcoming");
    expect(u?.searchParams.get("cursor")).toBeNull();
    expect(Number(u?.searchParams.get("from"))).toBe(esperada.from);
    expect(Number(u?.searchParams.get("to"))).toBe(esperada.to);
    expect(u?.searchParams.get("include_unknown_dates")).toBe("false");
  });

  it("la fila de la ejecución es la que escribe last_seen_run_id, y pasa a ser la referencia", async () => {
    const mundo = crearMundo();
    const r = await correr(mundo);
    expect(r.runId).not.toBeNull();
    expect(mundo.base.anuncios().map((a) => a.lastSeenRunId)).toEqual([
      r.runId,
      r.runId,
      r.runId,
    ]);
    expect(await leerRecorridoDeReferencia(mundo.libro.ejecutor)).toBe(r.runId);
    expect(await proximamente(mundo, T)).toEqual([
      imdb("400"),
      imdb("401"),
      imdb("402"),
    ]);
  });

  it("gobierna el tope del REPOSITORIO: 8, y la 9.ª página no se pide", async () => {
    expect(TOPE_POR_EJECUCION_POR_DEFECTO.upcoming).toBe(8);
    const r = await correr(crearMundo(), { paginas: listas(9) });
    expect(r.urls).toHaveLength(8);
    expect(r.salida.contadores.reservasConcedidas).toBe(8);
    expect(r.veredicto).toEqual({
      codigo: 0,
      nivel: "aviso",
      motivo: "tope_por_ejecucion",
    });
    expect(r.salida.horizonte).toEqual({
      completo: false,
      desaparecidas: null,
      muestra: [],
      fueraDeCobertura: null,
    });
    const texto = r.resumen.join("\n");
    expect(texto).toMatch(/cortado antes de c8 · el siguiente empieza de nuevo/);
    expect(texto).toMatch(/sin medir, el recorrido no terminó/);
  });

  it("tras un corte NO reanuda: el siguiente empieza por la primera página de SU horizonte", async () => {
    const mundo = crearMundo();
    await correr(mundo, { paginas: listas(9) });
    const manana = en(1);
    const segunda = await correr(mundo, { paginas: listas(3), ahora: manana });
    expect(segunda.urls.map((u) => u.searchParams.get("cursor"))).toEqual([
      null,
      "c1",
      "c2",
    ]);
    expect(Number(segunda.urls[0]?.searchParams.get("from"))).toBe(
      ventanaEnSegundos(ventanaHaciaDelante(manana, 31)).from,
    );
    expect(segunda.salida.checkpoint?.reanudaDe).toBeNull();
    expect(segunda.veredicto.codigo).toBe(0);
  });

  it("un recorrido incompleto no mide desapariciones, no toca nada y no mueve la referencia", async () => {
    const mundo = crearMundo();
    const primera = await correr(mundo);
    const antes = mundo.base.anuncios();
    const sentencias = mundo.base.sentencias.length;

    // Nueve páginas de anuncios que no son los de ayer: el corte deja fuera
    // la novena y los tres de la primera ejecución no se observan.
    const segunda = await correr(mundo, { paginas: listas(9, 500), ahora: en(1) });
    expect(segunda.veredicto.motivo).toBe("tope_por_ejecucion");
    expect(segunda.salida.horizonte?.desaparecidas).toBeNull();

    // Ni borrado, ni marca, ni evento sobre lo que no se observó.
    for (const previo of antes) {
      expect(mundo.base.anuncios().find((a) => a.imdbId === previo.imdbId)).toEqual(
        previo,
      );
    }
    const posteriores = mundo.base.sentencias.slice(sentencias);
    expect(posteriores.some((s) => s.startsWith("DELETE"))).toBe(false);
    expect(segunda.salida.informe?.eventosEscritos ?? 0).toBe(0);

    // La referencia sigue siendo el último recorrido COMPLETO: los tres de
    // ayer siguen vigentes, y los ocho de hoy también (run posterior).
    expect(await leerRecorridoDeReferencia(mundo.libro.ejecutor)).toBe(primera.runId);
    const vigentes = await proximamente(mundo, en(1));
    expect(vigentes).toEqual(expect.arrayContaining([imdb("400"), imdb("401")]));
    expect(vigentes).toHaveLength(3 + 8);
  });

  it("un recorrido completo que no los observa solo los cuenta: la vigencia se deriva del run", async () => {
    const mundo = crearMundo();
    await correr(mundo);
    const antes = mundo.base.anuncios();
    const sentencias = mundo.base.sentencias.length;

    // Mañana el proveedor solo lista uno de los tres.
    const segunda = await correr(mundo, {
      paginas: new Map([["upcoming|", pagina([anuncio("400", en(2))])]]),
      ahora: en(1),
    });
    expect(segunda.veredicto).toEqual({ codigo: 0, nivel: "ok", motivo: "succeeded" });
    expect(segunda.salida.horizonte).toMatchObject({
      completo: true,
      desaparecidas: 2,
    });
    expect(segunda.resumen.join("\n")).toMatch(/anuncios no observados: 2/);

    // Contar no es actuar: las dos filas quedan intactas.
    for (const id of ["401", "402"]) {
      expect(mundo.base.anuncios().find((a) => a.imdbId === imdb(id))).toEqual(
        antes.find((a) => a.imdbId === imdb(id)),
      );
    }
    expect(
      mundo.base.sentencias.slice(sentencias).some((s) => s.startsWith("DELETE")),
    ).toBe(false);

    // Pero ya no son la referencia: su last_seen_run_id es anterior.
    expect(await leerRecorridoDeReferencia(mundo.libro.ejecutor)).toBe(segunda.runId);
    expect(await proximamente(mundo, en(1))).toEqual([imdb("400")]);
  });

  it("cursor sin progreso (A → B → A) → exit 1, sin request extra y sin medir", async () => {
    const r = await correr(crearMundo(), {
      paginas: new Map([
        ["upcoming|", pagina([anuncio("600", en(2))], "A")],
        ["upcoming|A", pagina([anuncio("601", en(3))], "B")],
        ["upcoming|B", pagina([anuncio("602", en(4))], "A")],
      ]),
    });
    expect(r.veredicto).toEqual({
      codigo: 1,
      nivel: "error",
      motivo: "cursor_sin_progreso",
    });
    expect(r.urls).toHaveLength(3);
    expect(r.salida.horizonte?.completo).toBe(false);
    expect(r.salida.horizonte?.desaparecidas).toBeNull();
  });

  it("hasMore sin cursor → exit 1: no se da por completo", async () => {
    const r = await correr(crearMundo(), {
      paginas: new Map([
        ["upcoming|", pagina([anuncio("610", en(2))], undefined, true)],
      ]),
    });
    expect(r.veredicto).toMatchObject({ codigo: 1, motivo: "cursor_sin_progreso" });
    expect(r.urls).toHaveLength(1);
    expect(r.salida.horizonte?.completo).toBe(false);
  });

  it("techo mensual agotado (40) → exit 2, sin una sola request", async () => {
    const mundo = crearMundo();
    mundo.libro.sembrar("upcoming", TECHO_MENSUAL_POR_DEFECTO.upcoming);
    const r = await correr(mundo);
    expect(r.urls).toHaveLength(0);
    expect(r.veredicto).toMatchObject({ codigo: 2, motivo: "mensual_del_pipeline" });
  });

  it("con 33 ya gastadas en el ciclo, el techo corta en la 7.ª antes que el tope → exit 2", async () => {
    const mundo = crearMundo();
    mundo.libro.sembrar("upcoming", 33);
    const r = await correr(mundo, { paginas: listas(9) });
    expect(r.urls).toHaveLength(7);
    expect(r.veredicto).toMatchObject({ codigo: 2, motivo: "mensual_del_pipeline" });
  });

  it("umbral global agotado → exit 2", async () => {
    const mundo = crearMundo();
    mundo.libro.sembrar("deltas", 900);
    const r = await correr(mundo);
    expect(r.urls).toHaveLength(0);
    expect(r.veredicto).toMatchObject({ codigo: 2, motivo: "global" });
  });

  it("el proveedor en el 90 % → exit 2, y no sale otra request", async () => {
    const r = await correr(crearMundo(), {
      cuota: new Map([["upcoming|", { "x-quota-used": "900" }]]),
    });
    expect(r.urls).toHaveLength(1);
    expect(r.veredicto).toMatchObject({ codigo: 2, motivo: "cuota_del_proveedor" });
    expect(r.salida.horizonte?.completo).toBe(false);
  });

  it("otro upcoming vivo → exit 0 con aviso, sin fila y sin requests", async () => {
    const mundo = crearMundo();
    const r = await correr(mundo, { lockDePipelineOcupado: true });
    expect(r.veredicto).toEqual({
      codigo: 0,
      nivel: "aviso",
      motivo: "ya_hay_una_viva",
    });
    expect(r.urls).toHaveLength(0);
    expect(mundo.libro.filas).toHaveLength(0);
    expect(r.resumen.join("\n")).toMatch(/Otra ejecución de upcoming/);
  });

  it("deltas o expiring escribiendo catálogo → exit 0 con aviso, sin fila y sin requests", async () => {
    const mundo = crearMundo();
    const r = await correr(mundo, { catalogoOcupado: true });
    expect(r.veredicto).toEqual({
      codigo: 0,
      nivel: "aviso",
      motivo: "catalogo_ocupado",
    });
    expect(r.urls).toHaveLength(0);
    expect(mundo.libro.filas).toHaveLength(0);
    expect(mundo.base.anuncios()).toHaveLength(0);
    expect(r.resumen.join("\n")).toMatch(/escritor de catálogo/);
    expect(r.cerradas.sort()).toEqual(["datos", "ops"]);
  });

  it("una página que falla → exit 1", async () => {
    const r = await correr(crearMundo(), { paginas: new Map() });
    expect(r.veredicto).toMatchObject({ codigo: 1, nivel: "error" });
  });

  it("con las guardas en contra no abre ni una conexión, y el mensaje nombra upcoming", async () => {
    const mundo = crearMundo();
    const aperturas: string[] = [];
    await expect(
      correr(mundo, { destino: { ...DESTINO, rama: "production" }, aperturas }),
    ).rejects.toThrow(/job upcoming se niega a arrancar/);
    await expect(
      correr(mundo, {
        destino: { ...DESTINO, hostname: "ep-x-pooler.test" },
        aperturas,
      }),
    ).rejects.toThrow(/directa/);
    await expect(
      correr(mundo, {
        destino: { ...DESTINO, hostname: "ep-otra.test" },
        aperturas,
      }),
    ).rejects.toThrow(/NEON_VALIDATION_HOST/);
    await expect(
      correr(mundo, {
        entorno: {
          ...ENTORNO,
          GITHUB_ACTIONS: "true",
          STREAMING_API_PER_RUN_CAPS: "upcoming=99",
        },
        aperturas,
      }),
    ).rejects.toThrow(/no admite overrides/);
    await expect(
      correr(mundo, {
        entorno: {
          ...ENTORNO,
          GITHUB_ACTIONS: "true",
          STREAMING_API_BASE_URL: "https://otro.test",
        },
        aperturas,
      }),
    ).rejects.toThrow(/STREAMING_API_BASE_URL/);
    await expect(
      correr(mundo, { entorno: { NEON_VALIDATION_HOST: HOST }, aperturas }),
    ).rejects.toThrow(/STREAMING_AVAILABILITY_API_KEY/);
    expect(aperturas).toEqual([]);
    expect(mundo.libro.filas).toHaveLength(0);
  });
});
