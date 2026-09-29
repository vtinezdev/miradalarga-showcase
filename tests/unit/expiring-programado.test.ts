/**
 * `pnpm job expiring`: registro, guardas, códigos de salida y ejecuciones
 * completas. **Sin red y sin base de datos.**
 *
 * Las ejecuciones completas corren `ejecutarExpiringProgramado` con el
 * presupuesto **del repositorio** —sin inyectar nada—, así que también prueban
 * que el tope aprobado (12) es el que de verdad gobierna el job.
 */
import { describe, expect, it } from "vitest";

import type { Conexion } from "../../jobs/ops/conexion.ts";
import type { EjecutorSql, MuestraDeError } from "../../jobs/ops/contratos.ts";
import { NS_CATALOGO } from "../../jobs/ops/bloqueo.ts";
import { crearLibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import type { LibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import { TECHO_MENSUAL_POR_DEFECTO } from "../../jobs/ops/presupuesto.ts";
import type { FuenteDeCuota, Transporte } from "../../jobs/ops/transporte.ts";
import { ventanaEnSegundos } from "../../jobs/pipelines/deltas/manifiesto.ts";
import { ventanaHaciaDelante } from "../../jobs/pipelines/deltas/origen.ts";
import { planificarExpiring } from "../../jobs/pipelines/expiring/checkpoint.ts";
import type { ResultadoDelJobDeExpiring } from "../../jobs/pipelines/expiring/job.ts";
import {
  ejecutarExpiringProgramado,
  veredictoDeExpiring,
} from "../../jobs/pipelines/expiring/programado.ts";
import type { DestinoVerificado } from "../../jobs/pipelines/programado.ts";
import { PIPELINES_REGISTRADOS } from "../../jobs/registro.ts";
import { conexionDeDatos } from "./ayudas-checkpoint.ts";
import { respuestaCruda, showCrudo } from "./ayudas-deltas.ts";
import type { BaseEnMemoria } from "./base-en-memoria.ts";
import { crearBaseEnMemoria } from "./base-en-memoria.ts";

const T = new Date("2026-09-24T10:00:00.000Z");
const DIA = 86_400_000;
const en = (dias: number, desde = T) => new Date(desde.getTime() + dias * DIA);
const seg = (d: Date) => Math.floor(d.getTime() / 1000);

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
  it("expiring es un job oficial, junto a deltas y upcoming, y nada más", () => {
    expect(Object.keys(PIPELINES_REGISTRADOS)).toEqual([
      "deltas",
      "expiring",
      "upcoming",
    ]);
    expect(typeof PIPELINES_REGISTRADOS.expiring).toBe("function");
  });
});

// ── 2 · Códigos de salida: el veredicto, puro ────────────────────────────────

function salida(entrada: {
  estado?: "succeeded" | "failed" | "budget_stopped";
  muestras?: readonly MuestraDeError[];
  noEjecutado?: "ya_hay_una_viva" | "catalogo_ocupado";
  cortado?: boolean;
}): ResultadoDelJobDeExpiring {
  const plan = planificarExpiring(en(-10));
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
    // Un checkpoint de hace diez días, cortado: con la regla de `deltas`
    // sería retraso_excesivo. Aquí no significa nada.
    checkpoint: {
      ...plan,
      pendiente:
        entrada.cortado === false
          ? null
          : { changeType: "expiring", cursorDeEntrada: "c9" },
    },
    horizonte: null,
  };
}

describe("códigos de salida", () => {
  it("succeeded → 0", () => {
    expect(veredictoDeExpiring(salida({ cortado: false }))).toEqual({
      codigo: 0,
      nivel: "ok",
      motivo: "succeeded",
    });
  });

  it.each(["ya_hay_una_viva", "catalogo_ocupado"] as const)(
    "lock ocupado (%s) → 0 con aviso",
    (motivo) => {
      expect(veredictoDeExpiring(salida({ noEjecutado: motivo }))).toEqual({
        codigo: 0,
        nivel: "aviso",
        motivo,
      });
    },
  );

  it("budget_stopped por tope de ejecución → 0 con aviso", () => {
    const v = veredictoDeExpiring(
      salida({
        estado: "budget_stopped",
        muestras: [{ motivo: "tope_por_ejecucion", consumido: 12, techo: 12 }],
      }),
    );
    expect(v).toEqual({ codigo: 0, nivel: "aviso", motivo: "tope_por_ejecucion" });
  });

  it.each(["mensual_del_pipeline", "global", "cuota_del_proveedor"])(
    "budget_stopped por %s → 2",
    (motivo) => {
      const v = veredictoDeExpiring(
        salida({ estado: "budget_stopped", muestras: [{ motivo }] }),
      );
      expect(v).toEqual({ codigo: 2, nivel: "atencion", motivo });
    },
  );

  it("budget_stopped sin motivo reconocible → 2", () => {
    const v = veredictoDeExpiring(salida({ estado: "budget_stopped", muestras: [] }));
    expect(v).toMatchObject({ codigo: 2, motivo: "corte_sin_motivo" });
  });

  it("failed → 1, con el motivo de su muestra", () => {
    const v = veredictoDeExpiring(
      salida({ estado: "failed", muestras: [{ motivo: "excepcion" }] }),
    );
    expect(v).toEqual({ codigo: 1, nivel: "error", motivo: "excepcion" });
  });

  it("SIN regla de retraso: un corte viejo no convierte un tope en 2", () => {
    const v = veredictoDeExpiring(
      salida({
        estado: "budget_stopped",
        muestras: [{ motivo: "tope_por_ejecucion" }],
        cortado: true,
      }),
    );
    expect(v.codigo).toBe(0);
    expect(v).not.toHaveProperty("retrasoMs");
  });
});

// ── 3 · Ejecuciones completas, con dobles ────────────────────────────────────

const CUOTA = {
  "x-quota-used": "120",
  "x-quota-granted": "1000",
  "x-quota-reset": "2026-10-01T00:00:00Z",
};

function pagina(i: number, nextCursor?: string): Record<string, unknown> {
  const id = String(300 + i);
  const sale = seg(en(1 + i));
  return respuestaCruda({
    cambios: [
      {
        changeType: "expiring",
        showId: id,
        service: "netflix",
        type: "subscription",
        link: `https://netflix.test/${id}`,
        timestamp: sale,
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
            quality: "hd",
            expiresOn: sale,
          },
        ],
      }),
    ],
    hasMore: nextCursor !== undefined,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  });
}

/** `n` páginas de `expiring` encadenadas por cursor. */
function listas(n: number): ReadonlyMap<string, Record<string, unknown>> {
  return new Map(
    Array.from({ length: n }, (_, i) => [
      `expiring|${i === 0 ? "" : `c${String(i)}`}`,
      pagina(i, i < n - 1 ? `c${String(i + 1)}` : undefined),
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
    readonly paginas?: ReadonlyMap<string, Record<string, unknown>>;
    readonly ahora?: Date;
    readonly lockDePipelineOcupado?: boolean;
    readonly catalogoOcupado?: boolean;
    readonly entorno?: Readonly<Record<string, string>>;
    readonly destino?: DestinoVerificado;
    readonly aperturas?: string[];
  } = {},
) {
  const urls: URL[] = [];
  const cerradas: string[] = [];
  let abiertas = 0;
  const paginas = entrada.paginas ?? listas(6);

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
        headers: { "content-type": "application/json", ...CUOTA },
      });
    };

  const r = await ejecutarExpiringProgramado({
    entorno: entrada.entorno ?? ENTORNO,
    destino: entrada.destino ?? DESTINO,
    conectar,
    crearLlamada,
    ahora: entrada.ahora ?? T,
    directorioDeRegistros: null,
  });
  return { ...r, urls, cerradas };
}

describe("ejecutarExpiringProgramado", () => {
  it("el recorrido medido —6 páginas—: 6 requests, exit 0, horizonte completo", async () => {
    const r = await correr(crearMundo());
    expect(r.veredicto).toEqual({ codigo: 0, nivel: "ok", motivo: "succeeded" });
    expect(r.urls).toHaveLength(6);
    expect(r.salida.horizonte?.completo).toBe(true);
    expect(r.cerradas.sort()).toEqual(["datos", "ops"]);
    const texto = r.resumen.join("\n");
    expect(r.resumen[0]).toBe("expiring · exit 0 · ok · succeeded");
    expect(texto).toMatch(/horizonte: 31 días/);
    expect(texto).toMatch(/páginas confirmadas: 6 · recorrido completo/);
    expect(texto).toMatch(/desaparecidas del horizonte: 0/);
    // El resumen no filtra la clave ni la cadena de conexión.
    expect(texto).not.toMatch(/clave-de-prueba|secreto|postgres:/);
  });

  it("pide la ventana [ahora − 60 s, ahora + 31 días], sin include_unknown_dates", async () => {
    const r = await correr(crearMundo(), { paginas: listas(1) });
    const esperada = ventanaEnSegundos(ventanaHaciaDelante(T, 31));
    const u = r.urls[0];
    expect(u?.searchParams.get("change_type")).toBe("expiring");
    expect(Number(u?.searchParams.get("from"))).toBe(esperada.from);
    expect(Number(u?.searchParams.get("to"))).toBe(esperada.to);
    expect(u?.searchParams.get("include_unknown_dates")).toBe("false");
  });

  it("gobierna el tope del REPOSITORIO: 12, y la 13.ª página no se pide", async () => {
    const r = await correr(crearMundo(), { paginas: listas(13) });
    expect(r.urls).toHaveLength(12);
    expect(r.veredicto).toEqual({
      codigo: 0,
      nivel: "aviso",
      motivo: "tope_por_ejecucion",
    });
    expect(r.salida.horizonte?.completo).toBe(false);
    expect(r.resumen.join("\n")).toMatch(
      /cortado antes de c12 · el siguiente empieza de nuevo/,
    );
    expect(r.resumen.join("\n")).toMatch(/sin medir, el recorrido no terminó/);
  });

  it("tras un corte NO reanuda: el siguiente empieza por la primera página de SU horizonte", async () => {
    const mundo = crearMundo();
    await correr(mundo, { paginas: listas(13) });
    const manana = en(1);
    const segunda = await correr(mundo, { paginas: listas(13), ahora: manana });
    expect(segunda.urls[0]?.searchParams.get("cursor")).toBeNull();
    expect(Number(segunda.urls[0]?.searchParams.get("from"))).toBe(
      ventanaEnSegundos(ventanaHaciaDelante(manana, 31)).from,
    );
    expect(segunda.salida.checkpoint?.reanudaDe).toBeNull();
  });

  it("techo mensual agotado (60) → exit 2, sin una sola request", async () => {
    const mundo = crearMundo();
    mundo.libro.sembrar("expiring", TECHO_MENSUAL_POR_DEFECTO.expiring);
    const r = await correr(mundo);
    expect(r.urls).toHaveLength(0);
    expect(r.veredicto).toMatchObject({ codigo: 2, motivo: "mensual_del_pipeline" });
  });

  it("umbral global agotado → exit 2", async () => {
    const mundo = crearMundo();
    mundo.libro.sembrar("deltas", 900);
    const r = await correr(mundo);
    expect(r.urls).toHaveLength(0);
    expect(r.veredicto).toMatchObject({ codigo: 2, motivo: "global" });
  });

  it("otro expiring vivo → exit 0 con aviso, sin fila y sin requests", async () => {
    const mundo = crearMundo();
    const r = await correr(mundo, { lockDePipelineOcupado: true });
    expect(r.veredicto).toEqual({
      codigo: 0,
      nivel: "aviso",
      motivo: "ya_hay_una_viva",
    });
    expect(r.urls).toHaveLength(0);
    expect(mundo.libro.filas).toHaveLength(0);
  });

  it("deltas escribiendo catálogo → exit 0 con aviso, sin fila y sin requests", async () => {
    const mundo = crearMundo();
    const r = await correr(mundo, { catalogoOcupado: true });
    expect(r.veredicto).toEqual({
      codigo: 0,
      nivel: "aviso",
      motivo: "catalogo_ocupado",
    });
    expect(r.urls).toHaveLength(0);
    expect(mundo.libro.filas).toHaveLength(0);
    expect(r.resumen.join("\n")).toMatch(/escritor de catálogo/);
    expect(r.cerradas.sort()).toEqual(["datos", "ops"]);
  });

  it("una página que falla → exit 1", async () => {
    const r = await correr(crearMundo(), { paginas: new Map() });
    expect(r.veredicto).toMatchObject({ codigo: 1, nivel: "error" });
  });

  it("con las guardas en contra no abre ni una conexión, y el mensaje nombra expiring", async () => {
    const mundo = crearMundo();
    const aperturas: string[] = [];
    await expect(
      correr(mundo, { destino: { ...DESTINO, rama: "production" }, aperturas }),
    ).rejects.toThrow(/job expiring se niega a arrancar/);
    await expect(
      correr(mundo, {
        destino: { ...DESTINO, hostname: "ep-x-pooler.test" },
        aperturas,
      }),
    ).rejects.toThrow(/directa/);
    await expect(
      correr(mundo, {
        entorno: {
          ...ENTORNO,
          GITHUB_ACTIONS: "true",
          STREAMING_API_PER_RUN_CAPS: "expiring=99",
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
  });
});
