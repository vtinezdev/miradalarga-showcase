/**
 * `pnpm api:run:updated --real` **no lleva tope propio**: `updated` no tiene
 * presupuesto aprobado, y medir es previo a fijarlo. El tope lo escribe quien
 * lanza la medición (`--tope <n>`), y la guarda lo acota. **Sin red, sin base
 * de datos y sin ejecutar el script**, que arranca al importarse: la guarda
 * vive en `manual-comun.ts` y el script se comprueba en el fuente.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  GUARDRAIL_DE_MEDICION_MANUAL,
  TECHO_MENSUAL_POR_DEFECTO,
  TOPE_POR_EJECUCION_POR_DEFECTO,
  decidirReserva,
  leerPresupuesto,
} from "../../jobs/ops/presupuesto.ts";
import {
  describirMedicionDeVentana,
  exigirTopeDeMedicion,
} from "../../scripts/manual-comun.ts";

const RAIZ = join(import.meta.dirname, "..", "..");

describe("updated sigue sin presupuesto aprobado", () => {
  it("tope 0 en el repositorio: ningún pnpm job ni workflow puede gastar", () => {
    expect(TOPE_POR_EJECUCION_POR_DEFECTO.updated).toBe(0);
  });

  it("no está registrado en jobs/run.ts ni tiene workflow", () => {
    const run = readFileSync(join(RAIZ, "jobs", "run.ts"), "utf8");
    expect(run).not.toMatch(/updated\/programado|ejecutarJobDeUpdated/);
    expect(() =>
      readFileSync(join(RAIZ, ".github", "workflows", "updated.yml"), "utf8"),
    ).toThrow();
  });
});

describe("exigirTopeDeMedicion", () => {
  const techo = TECHO_MENSUAL_POR_DEFECTO.updated;

  it("sin --tope no hay medición", () => {
    expect(() => exigirTopeDeMedicion("updated", undefined)).toThrow(
      /exige --tope <n>.*No se ha pedido nada/,
    );
  });

  it("un entero entre 1 y el techo mensual se admite", () => {
    expect(exigirTopeDeMedicion("updated", "1")).toBe(1);
    expect(exigirTopeDeMedicion("updated", String(techo))).toBe(techo);
  });

  it("0, negativos, decimales, texto o más que el techo, no", () => {
    for (const malo of ["0", "-1", "2.5", "cuatro", "", String(techo + 1)]) {
      expect(() => exigirTopeDeMedicion("updated", malo)).toThrow(
        /No se ha pedido nada/,
      );
    }
  });

  it("con tope oficial, manda el oficial: upcoming no pasa de 8", () => {
    expect(exigirTopeDeMedicion("upcoming", "8")).toBe(8);
    expect(() => exigirTopeDeMedicion("upcoming", "9")).toThrow(/su tope oficial/);
  });

  it("el script pasa el --tope de la línea de órdenes, sin literal propio", () => {
    const fuente = readFileSync(join(RAIZ, "scripts", "run-updated-manual.ts"), "utf8");
    expect(fuente).toMatch(/exigirTopeDeMedicion\(PIPELINE, argumentoDelTope\)/);
    expect(fuente).toMatch(/real\(valorDe\("--tope"\)\)/);
  });
});

/**
 * 📏 La fila 60 reanudó la ventana de las filas 58 y 59 y la cerró con 3
 * requests. El resumen decía «la ventana … cabe en 3 requests»; la ventana
 * entera necesitó 11 (4 + 4 + 3).
 */
describe("describirMedicionDeVentana", () => {
  const desde = new Date("2026-09-24T15:18:20.000Z");
  const hasta = new Date("2026-09-25T15:18:20.000Z");
  const texto = (entrada: {
    reanudaDe: number | null;
    completa: boolean;
    requests: number;
  }) => describirMedicionDeVentana({ desde, hasta, ...entrada }).join(" / ");

  it("nueva y completa: la ventana completa necesitó N requests", () => {
    const t = texto({ reanudaDe: null, completa: true, requests: 2 });
    expect(t).toMatch(
      /La ventana completa 2026-09-24T15:18:20\.000Z → 2026-09-25T15:18:20\.000Z necesitó 2 requests/,
    );
  });

  it("reanudada y completa (fila 60): el tramo pendiente, no la ventana, se completó en N", () => {
    const t = texto({ reanudaDe: 59, completa: true, requests: 3 });
    expect(t).toMatch(
      /Se completó el tramo pendiente de la ventana .* \(reanudado de la ejecución 59\) en 3 requests/,
    );
    expect(t).toMatch(/que esta ejecución no suma/);
    expect(t).not.toMatch(/ventana completa/);
    expect(t).not.toMatch(/cabe en/);
    // No inventa un total: ni 11 ni ninguna otra suma.
    expect(t).not.toMatch(/\b11\b/);
  });

  it("reanudada sin agotar: el tramo pendiente tampoco se agotó; es un suelo", () => {
    const t = texto({ reanudaDe: 58, completa: false, requests: 4 });
    expect(t).toMatch(
      /Tampoco se agotó el tramo pendiente .*ejecución 58\) en 4 requests: la cifra es un SUELO/,
    );
  });

  it("nueva sin agotar: suelo, y la siguiente reanuda", () => {
    const t = texto({ reanudaDe: null, completa: false, requests: 4 });
    expect(t).toMatch(/no se agotó en 4 requests: la cifra es un SUELO/);
    expect(t).toMatch(/reanuda desde ops_sync_runs\.checkpoint/);
  });

  it("el script usa el reanudaDe del checkpoint del job y ya no dice que la ventana «cabe en»", () => {
    const fuente = readFileSync(join(RAIZ, "scripts", "run-updated-manual.ts"), "utf8");
    expect(fuente).toMatch(/describirMedicionDeVentana\(\{/);
    expect(fuente).toMatch(/reanudaDe: salida\.checkpoint\?\.reanudaDe \?\? null/);
    // «el tope no cabe en…» es una precondición de presupuesto y sigue.
    expect(fuente).not.toMatch(/La ventana[^\n]*cabe en/);
  });
});

/**
 * El 48 de `updated` NO es presupuesto aprobado: es un guardrail de seguridad
 * para las mediciones manuales. Se nombra aparte para que no se lea como
 * presupuesto, y se conserva porque `reservar()` lo consulta: a 0, `--ensayo`,
 * `--reproducir` y `--real` no podrían reservar ni una request.
 */
describe("guardrail de medición manual frente a presupuesto aprobado", () => {
  it("updated: su techo por defecto ES el guardrail (48), y su tope aprobado sigue en 0", () => {
    expect(GUARDRAIL_DE_MEDICION_MANUAL.updated).toBe(48);
    expect(TECHO_MENSUAL_POR_DEFECTO.updated).toBe(
      GUARDRAIL_DE_MEDICION_MANUAL.updated,
    );
    expect(TOPE_POR_EJECUCION_POR_DEFECTO.updated).toBe(0);
  });

  it("todo pipeline con guardrail tiene tope 0: si se aprueba uno, sale del mapa", () => {
    for (const nombre of Object.keys(GUARDRAIL_DE_MEDICION_MANUAL)) {
      expect(
        TOPE_POR_EJECUCION_POR_DEFECTO[
          nombre as keyof typeof TOPE_POR_EJECUCION_POR_DEFECTO
        ],
      ).toBe(0);
    }
  });

  const reserva = (p: ReturnType<typeof leerPresupuesto>, delPipeline: number) =>
    decidirReserva({
      coste: 1,
      total: 0,
      delPipeline,
      deEstaEjecucion: 0,
      umbralGlobal: p.umbralGlobal,
      techoMensualDelPipeline: p.techoMensualPorPipeline.updated,
      topeDeLaEjecucion: p.topePorEjecucion.updated,
    });

  it("con el presupuesto del repositorio el guardrail no autoriza nada: tope 0", () => {
    const decision = reserva(leerPresupuesto({}), 0);
    expect(decision.concedida).toBe(false);
    if (!decision.concedida) expect(decision.motivo).toBe("tope_por_ejecucion");
  });

  it("en una medición manual (tope inyectado) acota lo que se gasta en el ciclo", () => {
    const p = leerPresupuesto({ STREAMING_API_PER_RUN_CAPS: "updated=4" });
    expect(reserva(p, 47).concedida).toBe(true);
    const tras48 = reserva(p, 48);
    expect(tras48.concedida).toBe(false);
    if (!tras48.concedida) expect(tras48.motivo).toBe("mensual_del_pipeline");
  });

  it("a 0, la medición manual no podría reservar ni la primera request", () => {
    const p = leerPresupuesto({
      STREAMING_API_PER_RUN_CAPS: "updated=4",
      STREAMING_API_MONTHLY_PIPELINE_BUDGETS: "updated=0",
    });
    const decision = reserva(p, 0);
    expect(decision.concedida).toBe(false);
    if (!decision.concedida) expect(decision.motivo).toBe("mensual_del_pipeline");
  });

  it("sin tope aprobado ni guardrail no hay medición manual: popularity y seed", () => {
    expect(() => exigirTopeDeMedicion("popularity", "4")).toThrow(
      /ni guardrail de medición manual/,
    );
    expect(() => exigirTopeDeMedicion("seed", "1")).toThrow(/ni guardrail/);
  });

  it("el error de un --tope fuera de rango dice guardrail, no techo mensual", () => {
    expect(() => exigirTopeDeMedicion("updated", "49")).toThrow(
      /su guardrail de medición manual: no hay presupuesto aprobado/,
    );
  });
});
