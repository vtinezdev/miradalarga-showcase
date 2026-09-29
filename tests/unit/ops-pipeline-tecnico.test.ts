/**
 * El pipeline técnico `changes_validation`.
 *
 * Existe por contabilidad: un harness que mide `/changes` gasta requests de
 * verdad y tienen que quedar auditadas, pero imputarlas a `deltas`,
 * `expiring` o `upcoming` falsearía el consumo de tres pipelines productivos.
 *
 * Lo que estos tests protegen es que siga siendo **técnico**: cerrado por
 * defecto, fuera del runner y sin programación.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PIPELINES_REGISTRADOS } from "../../jobs/registro.ts";

import {
  NOMBRES_DE_PIPELINE,
  PIPELINES_TECNICOS,
  PIPELINE_ID,
  esPipelineTecnico,
} from "../../jobs/ops/contratos.ts";
import { ejecutarJob } from "../../jobs/ops/ejecucion.ts";
import {
  TECHO_MENSUAL_POR_DEFECTO,
  TOPE_POR_EJECUCION_POR_DEFECTO,
  decidirReserva,
  leerPresupuesto,
} from "../../jobs/ops/presupuesto.ts";
import { MAXIMO_DE_REQUESTS } from "../../jobs/pipelines/deltas/validacion.ts";

const RAIZ = join(import.meta.dirname, "..", "..");
const PIPELINE = "changes_validation";

describe("identidad", () => {
  it("está en el vocabulario cerrado y se reconoce como técnico", () => {
    expect(NOMBRES_DE_PIPELINE).toContain(PIPELINE);
    expect(PIPELINES_TECNICOS).toContain(PIPELINE);
    expect(esPipelineTecnico(PIPELINE)).toBe(true);
  });

  it("tiene un PIPELINE_ID propio y estable que no colisiona", () => {
    // Los números son identidad: una colisión no daría error, haría que dos
    // pipelines se excluyeran mutuamente sin que nadie supiera por qué.
    expect(PIPELINE_ID[PIPELINE]).toBe(10);
    const ids = NOMBRES_DE_PIPELINE.map((n) => PIPELINE_ID[n]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ningún pipeline productivo se marca como técnico", () => {
    for (const nombre of [
      "seed",
      "deltas",
      "expiring",
      "upcoming",
      "updated",
    ] as const) {
      expect(esPipelineTecnico(nombre)).toBe(false);
    }
  });
});

describe("cerrado por defecto", () => {
  it("su techo mensual real es 0", () => {
    expect(TECHO_MENSUAL_POR_DEFECTO[PIPELINE]).toBe(0);
  });

  it("su tope por ejecución real es 0", () => {
    expect(TOPE_POR_EJECUCION_POR_DEFECTO[PIPELINE]).toBe(0);
  });

  it("sin inyección no puede gastar ni una request", () => {
    const presupuesto = leerPresupuesto({});
    expect(presupuesto.techoMensualPorPipeline[PIPELINE]).toBe(0);
    expect(presupuesto.topePorEjecucion[PIPELINE]).toBe(0);
  });

  it("no ha tocado el presupuesto de los pipelines productivos", () => {
    // La corrección de contabilidad no puede haber movido ninguna otra cifra.
    // `deltas`, `expiring` y `upcoming` sí cambiaron después, a propósito y
    // por su cuenta: 124 (opción C), 60 (5 × 12) y 40 (5 × 8, 2026-09-24).
    expect(TECHO_MENSUAL_POR_DEFECTO.deltas).toBe(124);
    expect(TECHO_MENSUAL_POR_DEFECTO.expiring).toBe(60);
    expect(TECHO_MENSUAL_POR_DEFECTO.upcoming).toBe(40);
    expect(TECHO_MENSUAL_POR_DEFECTO.updated).toBe(48);
  });
});

describe("solo el harness inyecta 5/5", () => {
  it("la inyección abre exactamente 5 y solo para este pipeline", () => {
    const presupuesto = leerPresupuesto({
      STREAMING_API_MONTHLY_PIPELINE_BUDGETS: `${PIPELINE}=${String(MAXIMO_DE_REQUESTS)}`,
      STREAMING_API_PER_RUN_CAPS: `${PIPELINE}=${String(MAXIMO_DE_REQUESTS)}`,
    });

    expect(presupuesto.techoMensualPorPipeline[PIPELINE]).toBe(5);
    expect(presupuesto.topePorEjecucion[PIPELINE]).toBe(5);

    // Y nadie más se abre por el camino: cada uno conserva su valor del
    // repositorio (0 para todos, 4 para deltas, 12 para expiring y 8 para
    // upcoming).
    for (const nombre of NOMBRES_DE_PIPELINE) {
      if (nombre === PIPELINE) continue;
      expect(`${nombre}=${String(presupuesto.topePorEjecucion[nombre])}`).toBe(
        `${nombre}=${String(TOPE_POR_EJECUCION_POR_DEFECTO[nombre])}`,
      );
    }
  });

  it("la inyección respeta el invariante tope <= techo mensual", () => {
    // 5 <= 5: no necesita figurar en EXCEPCIONES_AL_INVARIANTE.
    expect(() =>
      leerPresupuesto({
        STREAMING_API_MONTHLY_PIPELINE_BUDGETS: `${PIPELINE}=5`,
        STREAMING_API_PER_RUN_CAPS: `${PIPELINE}=5`,
      }),
    ).not.toThrow();
  });

  it("las 5 siguen contando para el techo global de 900", () => {
    const presupuesto = leerPresupuesto({
      STREAMING_API_MONTHLY_PIPELINE_BUDGETS: `${PIPELINE}=5`,
      STREAMING_API_PER_RUN_CAPS: `${PIPELINE}=5`,
    });
    expect(presupuesto.umbralGlobal).toBe(900);
  });
});

describe("fuera del runner y sin programación", () => {
  it("no está registrado en jobs/run.ts", () => {
    // El registro se importa de verdad, no se lee el fuente como texto.
    expect(Object.hasOwn(PIPELINES_REGISTRADOS, PIPELINE)).toBe(false);
    // Y hoy los registrados son `deltas` (Paso 5), `expiring` y `upcoming`
    // (2026-09-24).
    expect(Object.keys(PIPELINES_REGISTRADOS)).toEqual([
      "deltas",
      "expiring",
      "upcoming",
    ]);
  });

  it("ningún pipeline técnico es ejecutable por `pnpm job`", () => {
    for (const tecnico of PIPELINES_TECNICOS) {
      expect(Object.hasOwn(PIPELINES_REGISTRADOS, tecnico)).toBe(false);
    }
    // Ni por el registro ni escrito a mano en el runner.
    const runner = readFileSync(join(RAIZ, "jobs", "run.ts"), "utf8");
    for (const tecnico of PIPELINES_TECNICOS) {
      expect(runner).not.toContain(`"${tecnico}"`);
    }
  });

  it("solo lo nombra su propio harness manual", () => {
    // Si apareciera en un workflow o en un cron, dejaría de ser manual.
    const harness = readFileSync(
      join(RAIZ, "scripts", "validate-changes-live.ts"),
      "utf8",
    );
    expect(harness).toContain(`const PIPELINE = "${PIPELINE}" as const`);
  });
});

describe("la cuota real queda imputada a changes_validation", () => {
  /** Un `ops_sync_runs` en memoria que además recuerda qué se le pidió. */
  function ejecutorQueRecuerda() {
    const sentencias: { texto: string; valores: readonly unknown[] }[] = [];
    let consumidas = 0;

    const ejecutor = {
      ejecutar<T>(
        texto: string,
        valores: readonly unknown[] = [],
      ): Promise<readonly T[]> {
        sentencias.push({ texto, valores });
        const t = texto.trim();
        if (t.includes("pg_try_advisory_lock")) {
          return Promise.resolve([{ tomado: true }] as unknown as readonly T[]);
        }
        if (t.startsWith("INSERT INTO ops_sync_runs")) {
          return Promise.resolve([{ id: 77 }] as unknown as readonly T[]);
        }
        if (t.includes("coalesce(sum(requests_made)")) {
          return Promise.resolve([
            { total: consumidas, del_pipeline: consumidas, de_esta: consumidas },
          ] as unknown as readonly T[]);
        }
        if (t.includes("SET requests_made = requests_made +")) {
          consumidas += Number(valores[0] ?? 1);
        }
        return Promise.resolve([] as readonly T[]);
      },
    };

    return { ejecutor, sentencias, consumidas: () => consumidas };
  }

  const presupuestoDelHarness = () =>
    leerPresupuesto({
      STREAMING_API_MONTHLY_PIPELINE_BUDGETS: `${PIPELINE}=${String(MAXIMO_DE_REQUESTS)}`,
      STREAMING_API_PER_RUN_CAPS: `${PIPELINE}=${String(MAXIMO_DE_REQUESTS)}`,
    });

  it("la fila de ops_sync_runs nace con pipeline='changes_validation'", async () => {
    const bd = ejecutorQueRecuerda();
    await ejecutarJob(
      bd.ejecutor,
      { pipeline: PIPELINE, presupuesto: presupuestoDelHarness() },
      async (ctx) => {
        await ctx.pedirCuota();
      },
    );

    const alta = bd.sentencias.find((s) =>
      s.texto.trim().startsWith("INSERT INTO ops_sync_runs"),
    );
    expect(alta?.valores[0]).toBe(PIPELINE);
    // Y el techo grabado es el operativo, no el bruto.
    expect(alta?.valores[2]).toBe(900);
  });

  it("consume exactamente 5 y la sexta se corta como budget_stopped", async () => {
    const bd = ejecutorQueRecuerda();
    let concedidas = 0;

    const resultado = await ejecutarJob(
      bd.ejecutor,
      { pipeline: PIPELINE, presupuesto: presupuestoDelHarness() },
      async (ctx) => {
        // Diez intentos contra un tope de cinco: el corte lo hace reservar().
        for (let i = 0; i < 10; i++) {
          await ctx.pedirCuota();
          concedidas++;
        }
      },
    );

    expect(concedidas).toBe(MAXIMO_DE_REQUESTS);
    expect(bd.consumidas()).toBe(MAXIMO_DE_REQUESTS);
    expect(resultado.ejecutado && resultado.estado).toBe("budget_stopped");
    expect(resultado.ejecutado && resultado.estado).not.toBe("failed");
  });

  it("el gasto NO aparece bajo ningún pipeline productivo", async () => {
    const bd = ejecutorQueRecuerda();
    await ejecutarJob(
      bd.ejecutor,
      { pipeline: PIPELINE, presupuesto: presupuestoDelHarness() },
      async (ctx) => {
        await ctx.pedirCuota();
      },
    );

    // La consulta de consumo filtra por pipeline: el suyo, y ninguno más.
    const consumo = bd.sentencias.find((s) =>
      s.texto.includes("coalesce(sum(requests_made)"),
    );
    expect(consumo?.valores[2]).toBe(PIPELINE);
    for (const productivo of ["deltas", "expiring", "upcoming"]) {
      expect(consumo?.valores).not.toContain(productivo);
    }
  });
});

describe("lo ya gastado descuenta solo, sin ampliar el límite", () => {
  it("con 1 consumida en el ciclo, solo quedan 4 de las 5", () => {
    // La fila 19 gastó 1 request antes de reventar. El techo mensual de 5 que
    // inyecta el harness cuenta TODAS las filas del ciclo, así que la próxima
    // ejecución solo puede reservar 4 más: el límite se descuenta solo y no
    // hay que tocar ninguna configuración.
    const presupuesto = leerPresupuesto({
      STREAMING_API_MONTHLY_PIPELINE_BUDGETS: `${PIPELINE}=5`,
      STREAMING_API_PER_RUN_CAPS: `${PIPELINE}=5`,
    });

    const decidir = (yaGastadasEnElCiclo: number, enEstaEjecucion: number) =>
      decidirReserva({
        coste: 1,
        total: yaGastadasEnElCiclo,
        delPipeline: yaGastadasEnElCiclo,
        deEstaEjecucion: enEstaEjecucion,
        umbralGlobal: presupuesto.umbralGlobal,
        techoMensualDelPipeline: presupuesto.techoMensualPorPipeline[PIPELINE],
        topeDeLaEjecucion: presupuesto.topePorEjecucion[PIPELINE],
      });

    // Con 1 ya gastada: la 2ª, 3ª, 4ª y 5ª del ciclo se conceden…
    expect(decidir(1, 0).concedida).toBe(true);
    expect(decidir(4, 3).concedida).toBe(true);
    // …y la sexta del ciclo se deniega por el techo MENSUAL, no por el de la
    // ejecución: es lo que impide que un segundo intento gaste otras 5.
    const denegada = decidir(5, 4);
    expect(denegada.concedida).toBe(false);
    expect(!denegada.concedida && denegada.motivo).toBe("mensual_del_pipeline");
  });
});
