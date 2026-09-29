/**
 * **El crudo de ensayo** (`ensayo.ts`): cuerpos reales reenviados por el motor
 * de captura de verdad, una sola ronda, sin inventar una página 2. **0 API.**
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { crearLibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import {
  TECHO_MENSUAL_POR_DEFECTO,
  TOPE_POR_EJECUCION_POR_DEFECTO,
} from "../../jobs/ops/presupuesto.ts";
import { ejecutarCaptura } from "../../jobs/pipelines/seed/captura.ts";
import type { ContenidoDelCrudo } from "../../jobs/pipelines/seed/crudo/disco.ts";
import { crearAlmacenEnMemoria } from "../../jobs/pipelines/seed/crudo/almacen.ts";
import { ESTRATOS_DEL_MVP, planV1 } from "../../jobs/pipelines/seed/crudo/formato.ts";
import { verificarCrudo } from "../../jobs/pipelines/seed/crudo/verificar.ts";
import {
  DESTINO_DEL_ENSAYO,
  M1_SINTETICA,
  PAGINAS_DEL_ENSAYO,
  cicloAnterior,
  esCrudoDeEnsayo,
  fuenteDeReplay,
  planDeEnsayo,
  presupuestoDelEnsayo,
} from "../../jobs/pipelines/seed/ensayo.ts";
import { crearReloj, fijarReloj, INICIO, show } from "./ayudas-seed.ts";

afterEach(() => {
  vi.useRealTimers();
});

/** Un cuerpo por estrato, con la forma de `search/filters` y `hasMore`. */
function cuerpos(): Map<string, Uint8Array> {
  const salida = new Map<string, Uint8Array>();
  ESTRATOS_DEL_MVP.forEach((e, i) => {
    const imdb = `tt${String(1000000 + i)}`;
    salida.set(
      e.estrato,
      new TextEncoder().encode(
        JSON.stringify({
          shows: [
            show(imdb, {
              tipo: e.showType,
              opciones: [
                { service: e.catalogo, link: `https://${e.plataforma}.test/${imdb}` },
              ],
            }),
          ],
          hasMore: true,
          nextCursor: `${imdb}:siguiente`,
        }),
      ),
    );
  });
  return salida;
}

async function capturaDeEnsayo(fuente = fuenteDeReplay(cuerpos())) {
  fijarReloj();
  const almacen = crearAlmacenEnMemoria();
  const salida = await ejecutarCaptura({
    ejecutorOps: crearLibroEnMemoria().ejecutor,
    presupuesto: presupuestoDelEnsayo(),
    plan: planDeEnsayo({ capturaId: "ensayo-prueba", commit: null, inicio: INICIO }),
    fuente,
    almacen,
    reloj: crearReloj(),
    destino: DESTINO_DEL_ENSAYO,
    comprobarCuotaDelProveedor: false,
  });
  return { salida, contenido: almacen.contenido as ContenidoDelCrudo };
}

describe("planDeEnsayo", () => {
  it("es un plan v1 válido, con M1 sintética del ciclo anterior", () => {
    const plan = planDeEnsayo({ capturaId: "ensayo-x", commit: null, inicio: INICIO });
    expect(planV1.safeParse(plan).success).toBe(true);
    expect(plan.m1).toEqual({ runId: M1_SINTETICA, cicloClave: 202610, diaDeCiclo: 1 });
    expect(plan.objetivoUnicos).toBe(1);
    expect(plan.tope).toBe(12);
  });

  it("un crudo de ensayo se llama ensayo-…", () => {
    expect(() =>
      planDeEnsayo({ capturaId: "captura-1", commit: null, inicio: INICIO }),
    ).toThrow();
  });

  it("cicloAnterior cruza el año", () => {
    expect(cicloAnterior(202701)).toBe(202612);
    expect(cicloAnterior(202609)).toBe(202608);
  });
});

describe("la captura de ensayo", () => {
  it("cierra succeeded en la frontera de la ronda 1, verificable y cargable", async () => {
    const { salida, contenido } = await capturaDeEnsayo();
    expect(salida.resultado.ejecutado && salida.resultado.estado).toBe("succeeded");
    const v = verificarCrudo(contenido);
    expect(v.problemas).toEqual([]);
    expect(v.crudo?.cargable).toBe(true);
    expect(v.crudo?.cierre).toMatchObject({
      motivo: "objetivo_alcanzado",
      rondasCompletas: 1,
      rondaCompleta: true,
      requestsReservadas: PAGINAS_DEL_ENSAYO,
      destino: DESTINO_DEL_ENSAYO,
    });
    expect(v.crudo?.manifiesto.paginas.every((p) => p.cuota === null)).toBe(true);
    expect(v.crudo !== null && esCrudoDeEnsayo(v.crudo)).toBe(true);
  });

  it("nunca inventa una página 2: pedirla hace fallar la captura", async () => {
    const fuente = fuenteDeReplay(cuerpos());
    await expect(
      fuente(
        {
          estrato: {
            ...ESTRATOS_DEL_MVP[0]!,
            orderBy: "popularity_alltime",
            orderDirection: "desc",
          },
          ronda: 2,
          cursorDeEntrada: "algo",
          query: {},
        },
        { pipeline: "seed", pedirCuota: () => Promise.resolve() },
      ),
    ).rejects.toThrow(/solo tiene la página 1/);
  });

  it("sin cuerpo para un estrato, falla en vez de rellenar", async () => {
    const incompletos = cuerpos();
    incompletos.delete("apple-series");
    const { salida } = await capturaDeEnsayo(fuenteDeReplay(incompletos));
    expect(salida.resultado.ejecutado && salida.resultado.estado).toBe("failed");
  });
});

describe("esCrudoDeEnsayo y el presupuesto del repositorio", () => {
  it("cualquiera de las dos marcas basta", () => {
    expect(
      esCrudoDeEnsayo({ plan: { capturaId: "ensayo-a" }, cierre: { destino: "rama" } }),
    ).toBe(true);
    expect(
      esCrudoDeEnsayo({
        plan: { capturaId: "c-1" },
        cierre: { destino: DESTINO_DEL_ENSAYO },
      }),
    ).toBe(true);
    expect(
      esCrudoDeEnsayo({ plan: { capturaId: "c-1" }, cierre: { destino: "rama" } }),
    ).toBe(false);
  });

  it("el presupuesto del ensayo es del libro en memoria: el del repositorio sigue 0/0", () => {
    expect(presupuestoDelEnsayo().topePorEjecucion.seed).toBe(12);
    expect(TOPE_POR_EJECUCION_POR_DEFECTO.seed).toBe(0);
    expect(TECHO_MENSUAL_POR_DEFECTO.seed).toBe(0);
  });
});
