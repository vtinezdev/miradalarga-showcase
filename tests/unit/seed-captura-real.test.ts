/**
 * La captura **real** (ADR 0009 §1, §5, §7, §10) con fixtures, sin red: las dos
 * guardias de cuota alrededor de cada request, la reserva obligatoria de la
 * fuente, `T0` del reloj del servidor y la **reanudación** —adopción, páginas
 * apartadas, cierre anterior apartado— con sus negativas a 0 requests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EjecutorSql } from "../../jobs/ops/contratos.ts";
import { crearLibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import type { FuenteDePaginas } from "../../jobs/pipelines/seed/captura.ts";
import type { AlmacenDeCaptura } from "../../jobs/pipelines/seed/crudo/almacen.ts";
import { crearAlmacenEnMemoria } from "../../jobs/pipelines/seed/crudo/almacen.ts";
import { verificarCrudo } from "../../jobs/pipelines/seed/crudo/verificar.ts";
import type { CheckpointDeCaptura } from "../../jobs/pipelines/seed/fases.ts";
import {
  INICIO,
  capturar,
  crearPlan,
  crearProveedor,
  crearReloj,
  fijarReloj,
} from "./ayudas-seed.ts";
import { PAGINAS_BASE } from "./ayudas-seed-fixtures.ts";

beforeEach(() => fijarReloj());
afterEach(() => vi.useRealTimers());

const muestra = (r: Awaited<ReturnType<typeof capturar>>) =>
  r.resultado.ejecutado ? r.resultado.metricas.errorSamples[0] : undefined;

/** Una fuente que devuelve estas cabeceras en la página `n` (desde 1). */
function conCabeceras(cabeceras: (n: number) => Record<string, string>): {
  fuente: FuenteDePaginas;
  llamadas: () => number;
} {
  const base = crearProveedor(PAGINAS_BASE);
  let n = 0;
  return {
    fuente: async (p, cuota) => {
      const r = await base.fuente(p, cuota);
      n++;
      return { ...r, cabeceras: cabeceras(n) };
    },
    llamadas: () => base.llamadas.length,
  };
}

const CABECERAS_OK = {
  "x-quota-granted": "1000",
  "x-quota-reset": "2026-12-01T00:00:00Z",
};

// ── 1 · Cuota ────────────────────────────────────────────────────────────────

describe("cuota antes y después de cada request", () => {
  it("después: al 90 % de x-quota-granted la guardia se cierra y la siguiente no sale", async () => {
    const f = conCabeceras((n) => ({
      ...CABECERAS_OK,
      "x-quota-used": n === 2 ? "900" : "500",
    }));
    const c = await capturar({ paginas: PAGINAS_BASE, fuente: f.fuente });
    expect(c.resultado).toMatchObject({ ejecutado: true, estado: "budget_stopped" });
    expect(f.llamadas()).toBe(2);
    expect(muestra(c)).toMatchObject({
      motivo: "cuota_del_proveedor",
      estado: "umbral_alcanzado",
    });
    expect(c.libro.filas[0]?.requestsMade).toBe(2);
    // La página que trajo el aviso está en el crudo, y el crudo verifica.
    expect(c.manifiesto?.paginas).toHaveLength(2);
    expect(verificarCrudo(c.contenido).problemas).toEqual([]);
  });

  it("antes: un corte del proveedor ya registrado y sin reiniciar → 0 requests", async () => {
    const libro = crearLibroEnMemoria();
    libro.sembrar("deltas", 3, [
      {
        motivo: "cuota_del_proveedor",
        estado: "umbral_alcanzado",
        x_quota_used: 900,
        x_quota_granted: 1000,
        x_quota_reset: "2026-12-01T00:00:00Z",
        techo: 900,
      },
    ]);
    const c = await capturar({ paginas: PAGINAS_BASE, libro });
    expect(c.resultado).toMatchObject({ ejecutado: true, estado: "budget_stopped" });
    expect(c.proveedor.llamadas).toHaveLength(0);
    expect(libro.filas.at(-1)?.requestsMade).toBe(0);
  });

  it("sin cabeceras x-quota-* no hay comprobación externa: se para tras la primera", async () => {
    const f = conCabeceras(() => ({}));
    const c = await capturar({ paginas: PAGINAS_BASE, fuente: f.fuente });
    expect(c.resultado).toMatchObject({ ejecutado: true, estado: "budget_stopped" });
    expect(f.llamadas()).toBe(1);
    expect(muestra(c)).toMatchObject({ estado: "cabeceras_ausentes_o_invalidas" });
  });

  it("x-quota-reset distinto del fin del ciclo: failed (ciclo_desalineado), no budget_stopped", async () => {
    const f = conCabeceras(() => ({
      ...CABECERAS_OK,
      "x-quota-used": "10",
      "x-quota-reset": "2026-11-15T00:00:00Z",
    }));
    const c = await capturar({ paginas: PAGINAS_BASE, fuente: f.fuente });
    expect(c.resultado).toMatchObject({ ejecutado: true, estado: "failed" });
    expect(muestra(c)?.motivo).toBe("ciclo_desalineado");
    expect(f.llamadas()).toBe(1);
  });

  it("una fuente que no reserva no puede sacar una página: failed", async () => {
    const base = crearProveedor(PAGINAS_BASE);
    const sinReserva: FuenteDePaginas = (p) =>
      base.fuente(p, { pipeline: "seed", pedirCuota: () => Promise.resolve() });
    const c = await capturar({ paginas: PAGINAS_BASE, fuente: sinReserva });
    expect(c.resultado).toMatchObject({ ejecutado: true, estado: "failed" });
    expect(String(muestra(c)?.mensaje)).toMatch(/no reservó cuota/);
  });

  it("la reserva se deniega ANTES de salir: con el tope agotado la fuente no llega a pedir", async () => {
    const c = await capturar({ paginas: PAGINAS_BASE, tope: 3 });
    expect(c.proveedor.llamadas).toHaveLength(3);
    expect(c.libro.filas[0]?.requestsMade).toBe(3);
  });
});

// ── 2 · T0 del reloj del servidor ────────────────────────────────────────────

describe("T0", () => {
  it("sale de relojDeT0 (el servidor), no del reloj del proceso; S = T0 truncado − 1 h", async () => {
    const servidor = new Date("2026-11-03T08:59:58.750Z");
    const c = await capturar({
      paginas: PAGINAS_BASE,
      relojDeT0: () => Promise.resolve(servidor),
    });
    const cp = c.libro.filas[0]?.checkpoint as CheckpointDeCaptura;
    expect(cp.T0).toBe(servidor.toISOString());
    expect(cp.ancla).toBe("2026-11-03T07:59:58.000Z");
    expect(c.manifiesto?.cierre?.T0).toBe(servidor.toISOString());
    expect(verificarCrudo(c.contenido).problemas).toEqual([]);
  });
});

// ── 3 · Arrancar de cero ────────────────────────────────────────────────────

describe("una captura nueva", () => {
  it("se niega sobre un directorio con ficheros: crudo_no_vacio, 0 requests", async () => {
    const almacen = crearAlmacenEnMemoria({
      contenido: new Map([["plan.json", new Uint8Array([1])]]),
    });
    const c = await capturar({ paginas: PAGINAS_BASE, almacen });
    expect(muestra(c)?.motivo).toBe("crudo_no_vacio");
    expect(c.proveedor.llamadas).toHaveLength(0);
  });

  it("se niega a repetir un capturaId con filas: captura_ya_existe (S no se mueve)", async () => {
    const libro = crearLibroEnMemoria();
    await capturar({ paginas: PAGINAS_BASE, libro, tope: 5 });
    const c = await capturar({ paginas: PAGINAS_BASE, libro });
    expect(muestra(c)?.motivo).toBe("captura_ya_existe");
    expect(c.proveedor.llamadas).toHaveLength(0);
  });
});

// ── 4 · Reanudar ────────────────────────────────────────────────────────────

/** Un ejecutor que falla al escribir el checkpoint número `n` (el INSERT no cuenta). */
function fallaEnCheckpoint(ejecutor: EjecutorSql, n: number): EjecutorSql {
  let vistos = 0;
  return {
    ejecutar(texto, valores) {
      if (texto.includes("SET checkpoint = $2::jsonb") && ++vistos === n) {
        return Promise.reject(new Error("caída simulada tras escribir la página"));
      }
      return ejecutor.ejecutar(texto, valores);
    },
  };
}

/** Un almacén que falla al escribir la entrada de la página `n`. */
function fallaEnEntrada(
  almacen: ReturnType<typeof crearAlmacenEnMemoria>,
  n: number,
): ReturnType<typeof crearAlmacenEnMemoria> {
  let fallado = false;
  const ruta = `entradas/${String(n).padStart(4, "0")}.json`;
  const envuelto: AlmacenDeCaptura = {
    ...almacen,
    escribirDiario(r, b) {
      if (r === ruta && !fallado) {
        fallado = true;
        throw new Error("caída simulada entre el cuerpo y su entrada");
      }
      almacen.escribirDiario(r, b);
    },
  };
  return Object.assign(envuelto, {
    contenido: almacen.contenido,
    diario: almacen.diario,
  });
}

describe("reanudar", () => {
  it("un budget_stopped a mitad de ronda se reanuda con el mismo T0 y S, y el crudo final verifica", async () => {
    const libro = crearLibroEnMemoria();
    const almacen = crearAlmacenEnMemoria();
    const reloj = crearReloj();
    const primera = await capturar({
      paginas: PAGINAS_BASE,
      libro,
      almacen,
      reloj,
      tope: 5,
    });
    expect(primera.resultado).toMatchObject({ estado: "budget_stopped" });
    const cp1 = libro.filas[0]?.checkpoint as CheckpointDeCaptura;

    const segunda = await capturar({
      paginas: PAGINAS_BASE,
      libro,
      almacen,
      reloj,
      reanudar: true,
    });
    expect(segunda.resultado).toMatchObject({ ejecutado: true, estado: "succeeded" });
    const cp2 = libro.filas[1]?.checkpoint as CheckpointDeCaptura;
    expect(cp2).toMatchObject({ T0: cp1.T0, ancla: cp1.ancla, reanudaDe: 1 });
    expect(segunda.proveedor.llamadas).toHaveLength(9);
    expect(segunda.reanudacion).toMatchObject({
      reanudaDe: 1,
      cierreApartado: true,
      adoptada: null,
    });
    expect(segunda.manifiesto?.cierre).toMatchObject({
      estado: "succeeded",
      motivo: "objetivo_alcanzado",
      filasDeOps: ["1", "2"],
      requestsReservadas: 14,
      respuestas: 14,
    });
    // El cierre anterior no se borró: está apartado en el diario.
    expect(almacen.diario.has("cierres/2/manifiesto.json")).toBe(true);
    const v = verificarCrudo(segunda.contenido);
    expect(v.problemas).toEqual([]);
    expect(v.crudo?.cargable).toBe(true);
  });

  it("caída tras escribir la página y antes del checkpoint: se ADOPTA, 0 requests por ella", async () => {
    const libro = crearLibroEnMemoria();
    const almacen = crearAlmacenEnMemoria();
    const reloj = crearReloj();
    const caida = await capturar({
      paginas: PAGINAS_BASE,
      libro: { ...libro, ejecutor: fallaEnCheckpoint(libro.ejecutor, 4) },
      almacen,
      reloj,
    });
    expect(caida.resultado).toMatchObject({ estado: "failed" });
    expect((libro.filas[0]?.checkpoint as CheckpointDeCaptura).paginasConfirmadas).toBe(
      3,
    );

    const r = await capturar({
      paginas: PAGINAS_BASE,
      libro,
      almacen,
      reloj,
      reanudar: true,
    });
    expect(r.resultado).toMatchObject({ estado: "succeeded" });
    expect(r.reanudacion?.adoptada).toBe(4);
    // 14 páginas en total, 14 requests: la adoptada no se volvió a pedir.
    expect(r.proveedor.llamadas).toHaveLength(10);
    expect(r.manifiesto?.cierre?.requestsReservadas).toBe(14);
    expect(r.manifiesto?.paginas[3]).toMatchObject({
      n: 4,
      estado: "adoptada",
      runId: "1",
    });
    const v = verificarCrudo(r.contenido);
    expect(v.problemas).toEqual([]);
    expect(v.resumen?.paginas.adoptadas).toBe(1);
  });

  it("caída entre el cuerpo y su entrada: el cuerpo huérfano se APARTA y se vuelve a pedir (+1)", async () => {
    const libro = crearLibroEnMemoria();
    const almacen = crearAlmacenEnMemoria();
    const reloj = crearReloj();
    const caida = await capturar({
      paginas: PAGINAS_BASE,
      libro,
      reloj,
      almacen: fallaEnEntrada(almacen, 3),
    });
    expect(caida.resultado).toMatchObject({ estado: "failed" });

    const r = await capturar({
      paginas: PAGINAS_BASE,
      libro,
      almacen,
      reloj,
      reanudar: true,
    });
    expect(r.resultado).toMatchObject({ estado: "succeeded" });
    expect(r.reanudacion?.apartadas).toEqual([
      { ruta: "paginas/0003-prime-movie-r01.json", motivo: "cuerpo_sin_entrada" },
    ]);
    expect(almacen.diario.has("retiradas/2/paginas/0003-prime-movie-r01.json")).toBe(
      true,
    );
    // Sobrecontar, nunca perder: 15 reservadas para 14 páginas.
    expect(r.manifiesto?.cierre?.requestsReservadas).toBe(15);
    expect(verificarCrudo(r.contenido).problemas).toEqual([]);
  });

  it("una página inválida se aparta al reanudar y su cursor se vuelve a pedir", async () => {
    const libro = crearLibroEnMemoria();
    const almacen = crearAlmacenEnMemoria();
    const reloj = crearReloj();
    const base = crearProveedor(PAGINAS_BASE);
    let primeraVez = true;
    const conUn500: FuenteDePaginas = async (p, cuota) => {
      const r = await base.fuente(p, cuota);
      if (p.estrato.estrato === "netflix-series" && primeraVez) {
        primeraVez = false;
        return { ...r, status: 500, cuerpo: new TextEncoder().encode("{}") };
      }
      return r;
    };
    const fallo = await capturar({
      paginas: PAGINAS_BASE,
      libro,
      almacen,
      reloj,
      fuente: conUn500,
    });
    expect(muestra(fallo)?.motivo).toBe("respuesta_invalida");

    const r = await capturar({
      paginas: PAGINAS_BASE,
      libro,
      almacen,
      reloj,
      reanudar: true,
      fuente: conUn500,
    });
    expect(r.resultado).toMatchObject({ estado: "succeeded" });
    expect(r.reanudacion?.apartadas[0]).toMatchObject({ motivo: "respuesta_invalida" });
    expect(almacen.diario.has("retiradas/2/entradas/0002.json")).toBe(true);
    const v = verificarCrudo(r.contenido);
    expect(v.problemas).toEqual([]);
    expect(v.resumen?.paginas.invalidas).toBe(0);
  });

  describe("se niega, con 0 requests", () => {
    async function cortada() {
      const libro = crearLibroEnMemoria();
      const almacen = crearAlmacenEnMemoria();
      const reloj = crearReloj();
      await capturar({ paginas: PAGINAS_BASE, libro, almacen, reloj, tope: 5 });
      return { libro, almacen, reloj };
    }

    it("con otro plan: plan_distinto", async () => {
      const { libro, almacen, reloj } = await cortada();
      const r = await capturar({
        paginas: PAGINAS_BASE,
        libro,
        almacen,
        reloj,
        reanudar: true,
        plan: crearPlan({ objetivoUnicos: 6 }),
      });
      expect(muestra(r)?.motivo).toBe("plan_distinto");
      expect(r.proveedor.llamadas).toHaveLength(0);
      expect(r.manifiesto).toBeNull();
    });

    it("pasado S + 72 h: ancla_caducada, y el crudo queda como estaba", async () => {
      const { libro, almacen, reloj } = await cortada();
      const antes = new Map(almacen.contenido);
      const r = await capturar({
        paginas: PAGINAS_BASE,
        libro,
        almacen,
        reloj,
        reanudar: true,
        relojDeT0: () => Promise.resolve(new Date(INICIO.getTime() + 72 * 3_600_000)),
      });
      expect(muestra(r)?.motivo).toBe("ancla_caducada");
      expect(r.proveedor.llamadas).toHaveLength(0);
      expect(almacen.contenido).toEqual(antes);
    });

    it("sobre una captura succeeded: captura_ya_cerrada", async () => {
      const libro = crearLibroEnMemoria();
      const almacen = crearAlmacenEnMemoria();
      const reloj = crearReloj();
      await capturar({ paginas: PAGINAS_BASE, libro, almacen, reloj });
      const r = await capturar({
        paginas: PAGINAS_BASE,
        libro,
        almacen,
        reloj,
        reanudar: true,
      });
      expect(muestra(r)?.motivo).toBe("captura_ya_cerrada");
      expect(r.proveedor.llamadas).toHaveLength(0);
    });

    it("con una página confirmada dañada: crudo_incoherente", async () => {
      const { libro, almacen, reloj } = await cortada();
      almacen.contenido.set(
        "paginas/0002-netflix-series-r01.json",
        new Uint8Array([123, 125]),
      );
      const r = await capturar({
        paginas: PAGINAS_BASE,
        libro,
        almacen,
        reloj,
        reanudar: true,
      });
      expect(muestra(r)?.motivo).toBe("crudo_incoherente");
      expect(r.proveedor.llamadas).toHaveLength(0);
    });

    it("sin el diario: crudo_incoherente", async () => {
      const { libro, almacen, reloj } = await cortada();
      almacen.diario.clear();
      const r = await capturar({
        paginas: PAGINAS_BASE,
        libro,
        almacen,
        reloj,
        reanudar: true,
      });
      expect(muestra(r)?.motivo).toBe("crudo_incoherente");
      expect(r.proveedor.llamadas).toHaveLength(0);
    });

    it("sin plan.json: crudo_ausente", async () => {
      const r = await capturar({
        paginas: PAGINAS_BASE,
        almacen: crearAlmacenEnMemoria(),
        reanudar: true,
      });
      expect(muestra(r)?.motivo).toBe("crudo_ausente");
    });

    it("tras un cursor_sin_progreso: reanudacion_no_admitida", async () => {
      const libro = crearLibroEnMemoria();
      const almacen = crearAlmacenEnMemoria();
      const reloj = crearReloj();
      const paginas = {
        ...PAGINAS_BASE,
        "netflix-movie": [{ shows: [], hasMore: true, nextCursor: null }],
      };
      await capturar({ paginas, libro, almacen, reloj });
      const r = await capturar({ paginas, libro, almacen, reloj, reanudar: true });
      expect(muestra(r)?.motivo).toBe("reanudacion_no_admitida");
      expect(r.proveedor.llamadas).toHaveLength(0);
    });
  });
});

describe("un temporal que sobrevive a una caída a mitad de escritura", () => {
  it("se aparta al reanudar, y el crudo final verifica", async () => {
    const libro = crearLibroEnMemoria();
    const almacen = crearAlmacenEnMemoria();
    const reloj = crearReloj();
    await capturar({ paginas: PAGINAS_BASE, libro, almacen, reloj, tope: 5 });
    almacen.contenido.set(
      "paginas/0006-disney-series-r01.json.tmp-4242",
      new Uint8Array([1]),
    );
    const r = await capturar({
      paginas: PAGINAS_BASE,
      libro,
      almacen,
      reloj,
      reanudar: true,
    });
    expect(r.resultado).toMatchObject({ estado: "succeeded" });
    expect(r.reanudacion?.apartadas).toContainEqual({
      ruta: "paginas/0006-disney-series-r01.json.tmp-4242",
      motivo: "temporal_incompleto",
    });
    expect(verificarCrudo(r.contenido).problemas).toEqual([]);
  });
});
