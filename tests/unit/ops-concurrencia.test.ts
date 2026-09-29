/**
 * Dos jobs a la vez no pueden pasarse del techo entre los dos.
 *
 * ⚠️ **Esto prueba el ALGORITMO, no PostgreSQL.** El servidor de aquí abajo es
 * de mentira: respeta el lock porque se lo he programado. Que Neon honre de
 * verdad `pg_advisory_xact_lock` es otra afirmación, y se mide aparte con
 * `pnpm db:validate:ops`. No se da por supuesta.
 *
 * Lo que sí prueba, y no es poco: que la función `reservar()` real —la misma
 * que correrá en producción— nunca rebasa el umbral **si** el lock serializa; y
 * que **sin el lock sí lo rebasa**, que es lo que demuestra que el lock no es
 * decorativo.
 */
import { describe, expect, it } from "vitest";

import type { EjecutorSql } from "../../jobs/ops/contratos.ts";
import {
  calcularCiclo,
  leerPresupuesto,
  reservar,
} from "../../jobs/ops/presupuesto.ts";

const PRESUPUESTO = leerPresupuesto({
  STREAMING_API_MONTHLY_BUDGET: "1000",
  // Configuración INYECTADA. Los dos mapas se abren a propósito para dejar el
  // techo global como único límite en juego — que es lo que este fichero prueba.
  // Los valores por defecto del repositorio siguen a 0: ningún job aprobado.
  STREAMING_API_MONTHLY_PIPELINE_BUDGETS: "seed=100000",
  STREAMING_API_PER_RUN_CAPS: "seed=100000",
});
const AHORA = new Date("2026-09-22T10:00:00.000Z");
const CICLO = calcularCiclo(AHORA, PRESUPUESTO.diaDeCiclo);

/**
 * Un PostgreSQL de juguete con una sola cifra dentro.
 *
 * Cada «conexión» tiene su propio estado de transacción, y todas comparten el
 * contador y el lock. Las respuestas se resuelven en un microtask, así que
 * varias conexiones avanzan **en paralelo real** entre sentencia y sentencia:
 * es justo ahí donde vive la carrera que el lock tiene que cerrar.
 */
function crearServidor(opciones: { readonly respetarLock: boolean }) {
  let total = 0;
  let ocupado = false;
  const esperando: (() => void)[] = [];

  async function tomarLock(): Promise<void> {
    if (!opciones.respetarLock) return;
    while (ocupado) await new Promise<void>((seguir) => esperando.push(seguir));
    ocupado = true;
  }

  function soltarLock(): void {
    if (!opciones.respetarLock) return;
    ocupado = false;
    esperando.shift()?.();
  }

  function conexion(): EjecutorSql {
    let sostieneLock = false;
    return {
      async ejecutar<T>(texto: string, valores: readonly unknown[] = []) {
        if (texto.includes("pg_advisory_xact_lock")) {
          await tomarLock();
          sostieneLock = true;
          return [] as readonly T[];
        }
        if (texto.includes("FROM ops_sync_runs")) {
          // Se lee AQUÍ, en el instante en que llega la consulta. Sin el lock,
          // varias conexiones leen la misma cifra y todas creen que caben.
          return [
            { total, del_pipeline: total, de_esta: 0 },
          ] as unknown as readonly T[];
        }
        if (texto.includes("UPDATE ops_sync_runs SET requests_made")) {
          total += Number(valores[0] ?? 0);
          return [] as readonly T[];
        }
        if (texto === "COMMIT" || texto === "ROLLBACK") {
          if (sostieneLock) {
            soltarLock();
            sostieneLock = false;
          }
        }
        return [] as readonly T[];
      },
    };
  }

  return {
    conexion,
    sembrar(n: number) {
      total = n;
    },
    get total() {
      return total;
    },
  };
}

function trabajador(ejecutor: EjecutorSql, runId: number) {
  return async (): Promise<number> => {
    let concedidas = 0;
    for (;;) {
      const decision = await reservar(ejecutor, {
        runId,
        pipeline: "seed",
        presupuesto: PRESUPUESTO,
        cicloDeLaEjecucion: CICLO.clave,
        ahora: AHORA,
      });
      if (!decision.concedida) return concedidas;
      concedidas += 1;
    }
  };
}

describe("con el lock del ciclo", () => {
  it("ocho ejecuciones simultáneas gastan exactamente 900, ni una más", async () => {
    const servidor = crearServidor({ respetarLock: true });
    const trabajadores = Array.from({ length: 8 }, (_, i) =>
      trabajador(servidor.conexion(), i + 1),
    );

    const concedidas = await Promise.all(trabajadores.map((t) => t()));

    expect(servidor.total).toBe(PRESUPUESTO.umbralGlobal);
    expect(servidor.total).toBe(900);
    // Ninguna se queda sin correr, y entre todas suman justo el umbral.
    expect(concedidas.reduce((a, b) => a + b, 0)).toBe(900);
  });

  it("aguanta arrancando ya al borde del umbral", async () => {
    const servidor = crearServidor({ respetarLock: true });
    servidor.sembrar(899);
    const trabajadores = Array.from({ length: 8 }, (_, i) =>
      trabajador(servidor.conexion(), i + 1),
    );

    const concedidas = await Promise.all(trabajadores.map((t) => t()));

    // Cabe exactamente una request más, y se la lleva una sola ejecución.
    expect(servidor.total).toBe(900);
    expect(concedidas.filter((n) => n === 1)).toHaveLength(1);
    expect(concedidas.filter((n) => n === 0)).toHaveLength(7);
  });
});

describe("sin el lock del ciclo", () => {
  it("las mismas ocho se pasan del techo: el lock no es decorativo", async () => {
    const servidor = crearServidor({ respetarLock: false });
    servidor.sembrar(895);

    // Un intento cada una, todas lanzadas a la vez. Todas leen 895, todas
    // concluyen que caben, y todas escriben.
    const conexiones = Array.from({ length: 8 }, () => servidor.conexion());
    await Promise.all(
      conexiones.map((ejecutor, i) =>
        reservar(ejecutor, {
          runId: i + 1,
          pipeline: "seed",
          presupuesto: PRESUPUESTO,
          cicloDeLaEjecucion: CICLO.clave,
          ahora: AHORA,
        }),
      ),
    );

    expect(servidor.total).toBe(903);
    expect(servidor.total).toBeGreaterThan(PRESUPUESTO.umbralGlobal);
  });
});
