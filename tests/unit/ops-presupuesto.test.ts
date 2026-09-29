/**
 * Los techos y la decisión de reservar.
 *
 * ── Por qué este fichero es tan insistente con las unidades ─────────────────
 *
 * 📏 `docs/DATA-SOURCES.md` §1.8 tiene **dos tablas con unidades distintas**:
 * una de coste **por recorrido completo** y otra de régimen **mensual**. Al
 * construir la configuración se mezclaron, y el tope por ejecución acabó
 * valiendo el agregado del mes: para un pipeline diario **nunca podía saltar**.
 * El «límite duro de subrequests por job» del Plan §8.5 existía, estaba
 * probado, y no protegía de nada.
 *
 * No lo detectó ningún test porque todos probaban que el **mecanismo**
 * funcionaba, no que el **número** significara lo que debía. Los invariantes de
 * abajo prueban lo segundo.
 */
import { describe, expect, it } from "vitest";

import {
  NOMBRES_DE_PIPELINE,
  PIPELINE_ID,
  type NombreDePipeline,
} from "../../jobs/ops/contratos.ts";
import { COSTE_ESPERADO_POR_EJECUCION } from "../../jobs/ops/costes-medidos.ts";
import {
  EXCEPCIONES_AL_INVARIANTE,
  GUARDRAIL_DE_MEDICION_MANUAL,
  TECHO_MENSUAL_POR_DEFECTO,
  TOPE_POR_EJECUCION_POR_DEFECTO,
  calcularUmbralGlobal,
  decidirReserva,
  leerPresupuesto,
} from "../../jobs/ops/presupuesto.ts";

/** Techos deliberadamente altos, para aislar el límite que cada caso prueba. */
const SIN_ESTORBOS = {
  coste: 1,
  total: 0,
  delPipeline: 0,
  deEstaEjecucion: 0,
  umbralGlobal: 1_000_000,
  techoMensualDelPipeline: 1_000_000,
  topeDeLaEjecucion: 1_000_000,
} as const;

/**
 * Configuración **inyectada** para probar el mecanismo.
 *
 * ⚠️ Ningún pipeline real se habilita para que un test pase. Los valores por
 * defecto del repositorio siguen a 0, que es lo que dice la verdad: todavía no
 * hay ningún job aprobado para gastar API.
 */
const PRUEBA = leerPresupuesto({
  STREAMING_API_MONTHLY_BUDGET: "1000",
  STREAMING_API_MONTHLY_PIPELINE_BUDGETS: "seed=900",
  STREAMING_API_PER_RUN_CAPS: "seed=900",
});

describe("tres mapas, tres unidades, ningún solapamiento", () => {
  it("el techo mensual cubre todos los pipelines y solo lleva cifras mensuales", () => {
    for (const nombre of NOMBRES_DE_PIPELINE) {
      expect(TECHO_MENSUAL_POR_DEFECTO[nombre]).toBeGreaterThanOrEqual(0);
    }
    // Ninguna cifra es una estimación de consumo. `deltas`, `expiring` y
    // `upcoming` son presupuesto aprobado —124 (31 × tope 4), 60 (5 × tope 12)
    // y 40 (5 × tope 8), límites operativos; sus políticas se congelan más
    // abajo— y `updated` es su guardrail de medición manual.
    expect(TECHO_MENSUAL_POR_DEFECTO.deltas).toBe(124);
    expect(TECHO_MENSUAL_POR_DEFECTO.expiring).toBe(60);
    expect(TECHO_MENSUAL_POR_DEFECTO.upcoming).toBe(40);
    expect(TECHO_MENSUAL_POR_DEFECTO.updated).toBe(48);
  });

  it("popularity NO tiene presupuesto: techo 0 y tope 0", () => {
    // Valía 343, la estimación histórica del Spike 1 (~300 + ~43). Sin
    // pipeline, sin tope y sin cadencia aprobados, no era presupuesto: solo
    // inflaba la suma. Aprobarlo exige decidir techo y tope, con medición.
    expect(TECHO_MENSUAL_POR_DEFECTO.popularity).toBe(0);
    expect(TOPE_POR_EJECUCION_POR_DEFECTO.popularity).toBe(0);
    const p = leerPresupuesto({});
    expect(p.techoMensualPorPipeline.popularity).toBe(0);
    expect(p.topePorEjecucion.popularity).toBe(0);
    const decision = decidirReserva({
      ...SIN_ESTORBOS,
      techoMensualDelPipeline: p.techoMensualPorPipeline.popularity,
      topeDeLaEjecucion: p.topePorEjecucion.popularity,
    });
    expect(decision.concedida).toBe(false);
  });

  it("seed y reconcile NO tienen techo mensual: su cifra es por recorrido", () => {
    expect(TECHO_MENSUAL_POR_DEFECTO.seed).toBe(0);
    expect(TECHO_MENSUAL_POR_DEFECTO.reconcile).toBe(0);
    // Y su ~272 sí existe, pero en el mapa que no autoriza nada.
    expect(COSTE_ESPERADO_POR_EJECUCION.seed).toBe(272);
    expect(COSTE_ESPERADO_POR_EJECUCION.reconcile).toBe(272);
  });

  it("el coste esperado es null donde no hay medición POR EJECUCIÓN", () => {
    // Un promedio mensual no se convierte en coste por ejecución dividiéndolo:
    // eso sería inventar una medición que nadie hizo.
    for (const nombre of [
      "deltas",
      "expiring",
      "upcoming",
      "updated",
      "popularity",
    ] as const) {
      expect(COSTE_ESPERADO_POR_EJECUCION[nombre]).toBeNull();
    }
  });

  it("todo pipeline aparece en los tres mapas, sin huecos", () => {
    expect(Object.keys(TECHO_MENSUAL_POR_DEFECTO).sort()).toEqual(
      [...NOMBRES_DE_PIPELINE].sort(),
    );
    expect(Object.keys(TOPE_POR_EJECUCION_POR_DEFECTO).sort()).toEqual(
      [...NOMBRES_DE_PIPELINE].sort(),
    );
    expect(Object.keys(COSTE_ESPERADO_POR_EJECUCION).sort()).toEqual(
      [...NOMBRES_DE_PIPELINE].sort(),
    );
  });
});

describe("el coste esperado NO autoriza a gastar", () => {
  it("seed tiene 272 medidas y aun así no puede reservar ni una", () => {
    const p = leerPresupuesto({});
    expect(COSTE_ESPERADO_POR_EJECUCION.seed).toBe(272);
    expect(p.techoMensualPorPipeline.seed).toBe(0);
    expect(p.topePorEjecucion.seed).toBe(0);

    const decision = decidirReserva({
      ...SIN_ESTORBOS,
      techoMensualDelPipeline: p.techoMensualPorPipeline.seed,
      topeDeLaEjecucion: p.topePorEjecucion.seed,
    });
    expect(decision.concedida).toBe(false);
  });

  it("`presupuesto.ts` no importa el mapa de costes, y no puede verlo", async () => {
    // Guardia estructural, igual que la de la capa anticorrupción: si algún día
    // alguien conectara el coste medido a la decisión, volvería el defecto.
    //
    // Se mira el CÓDIGO, no la prosa: el fichero cita `costes-medidos.ts` en sus
    // comentarios a propósito, para explicar dónde vive cada unidad. Citarlo es
    // documentación; importarlo sería el defecto.
    const { readFile } = await import("node:fs/promises");
    const fuente = await readFile(
      new URL("../../jobs/ops/presupuesto.ts", import.meta.url),
      "utf8",
    );
    const sinBloques = fuente.split("*/").map((t) => t.split("/*")[0] ?? "");
    const codigo = sinBloques
      .join("")
      .split("\n")
      .filter((linea) => !linea.trimStart().startsWith("//"))
      .join("\n");

    expect(codigo).not.toContain("costes-medidos");
    expect(codigo).not.toContain("COSTE_ESPERADO");
    // Y la comprobación se comprueba a sí misma: si el despojado de comentarios
    // se rompiera, este test pasaría por vacío y no vigilaría nada.
    expect(codigo).toContain("export function leerPresupuesto");
  });
});

describe("el tope por ejecución no hereda del techo mensual", () => {
  it("por defecto es 0 para todos salvo los jobs aprobados: deltas (4), expiring (12) y upcoming (8)", () => {
    const p = leerPresupuesto({});
    const aprobados: Partial<Record<NombreDePipeline, number>> = {
      deltas: 4,
      expiring: 12,
      upcoming: 8,
    };
    for (const nombre of NOMBRES_DE_PIPELINE) {
      expect(`${nombre}=${String(p.topePorEjecucion[nombre])}`).toBe(
        `${nombre}=${String(aprobados[nombre] ?? 0)}`,
      );
    }
  });

  it("un techo mensual alto NO abre el tope por ejecución", () => {
    // Éste es el defecto, exactamente. Con el fallback, un pipeline diario
    // habría podido gastar el techo del mes entero en una sola ejecución.
    // Se prueba con `updated`, que no tiene tope aprobado.
    const p = leerPresupuesto({
      STREAMING_API_MONTHLY_PIPELINE_BUDGETS: "updated=150",
    });
    expect(p.techoMensualPorPipeline.updated).toBe(150);
    expect(p.topePorEjecucion.updated).toBe(0);

    const decision = decidirReserva({
      ...SIN_ESTORBOS,
      techoMensualDelPipeline: p.techoMensualPorPipeline.updated,
      topeDeLaEjecucion: p.topePorEjecucion.updated,
    });
    expect(decision.concedida).toBe(false);
    if (!decision.concedida) expect(decision.motivo).toBe("tope_por_ejecucion");
  });

  it("los dos mapas se leen de variables distintas y no se pisan", () => {
    const p = leerPresupuesto({
      STREAMING_API_MONTHLY_PIPELINE_BUDGETS: "deltas=60",
      STREAMING_API_PER_RUN_CAPS: "deltas=4",
    });
    expect(p.techoMensualPorPipeline.deltas).toBe(60);
    expect(p.topePorEjecucion.deltas).toBe(4);
    // Y no se contaminan entre sí.
    expect(p.techoMensualPorPipeline.upcoming).toBe(40);
    expect(p.topePorEjecucion.upcoming).toBe(8);
    expect(p.techoMensualPorPipeline.updated).toBe(48);
    expect(p.topePorEjecucion.updated).toBe(0);
  });

  it("un tope de 0 deniega siempre, sea cual sea el margen restante", () => {
    const decision = decidirReserva({ ...SIN_ESTORBOS, topeDeLaEjecucion: 0 });
    expect(decision.concedida).toBe(false);
    if (!decision.concedida) {
      expect(decision.motivo).toBe("tope_por_ejecucion");
      expect(decision.techo).toBe(0);
    }
  });
});

describe("la política de `deltas` (opción C, 2026-09-23)", () => {
  /** El ciclo más largo posible: 31 días naturales, en UTC. */
  const DIAS_DEL_CICLO_MAS_LARGO = 31;

  it("mensual = 124 y por ejecución = 4, en el repositorio y en lo leído", () => {
    expect(TECHO_MENSUAL_POR_DEFECTO.deltas).toBe(124);
    expect(TOPE_POR_EJECUCION_POR_DEFECTO.deltas).toBe(4);
    const p = leerPresupuesto({});
    expect(p.techoMensualPorPipeline.deltas).toBe(124);
    expect(p.topePorEjecucion.deltas).toBe(4);
  });

  it("124 = 31 días × tope 4: un límite operativo, no una previsión", () => {
    // Si alguien cambia el tope sin repensar el techo, esto lo ve.
    expect(TECHO_MENSUAL_POR_DEFECTO.deltas).toBe(
      DIAS_DEL_CICLO_MAS_LARGO * TOPE_POR_EJECUCION_POR_DEFECTO.deltas,
    );
  });

  it("la suma de techos es 272 y deja 628 de margen hasta el umbral global de 900", () => {
    const suma = Object.values(TECHO_MENSUAL_POR_DEFECTO).reduce((n, x) => n + x, 0);
    const p = leerPresupuesto({});
    expect(suma).toBe(272);
    expect(p.umbralGlobal).toBe(900);
    expect(p.umbralGlobal - suma).toBe(628);
    // 224 de presupuesto aprobado + 48 del guardrail de medición de `updated`.
    const aprobado =
      TECHO_MENSUAL_POR_DEFECTO.deltas +
      TECHO_MENSUAL_POR_DEFECTO.expiring +
      TECHO_MENSUAL_POR_DEFECTO.upcoming;
    expect(aprobado).toBe(224);
    expect(suma - aprobado).toBe(GUARDRAIL_DE_MEDICION_MANUAL.updated);
  });

  it("un día normal —2 medidas— nunca lo alcanza: 31 × 2 = 62", () => {
    const decision = decidirReserva({
      ...SIN_ESTORBOS,
      delPipeline: DIAS_DEL_CICLO_MAS_LARGO * 2 - 1,
      techoMensualDelPipeline: TECHO_MENSUAL_POR_DEFECTO.deltas,
      topeDeLaEjecucion: TOPE_POR_EJECUCION_POR_DEFECTO.deltas,
    });
    expect(decision.concedida).toBe(true);
  });

  it("la QUINTA request de una ejecución se deniega aunque sobre techo mensual", () => {
    const p = leerPresupuesto({});
    const decision = decidirReserva({
      coste: 1,
      total: 10,
      delPipeline: 4, // lo de esta misma ejecución: quedan 120 en el mes
      deEstaEjecucion: 4,
      umbralGlobal: p.umbralGlobal,
      techoMensualDelPipeline: p.techoMensualPorPipeline.deltas,
      topeDeLaEjecucion: p.topePorEjecucion.deltas,
    });
    expect(decision.concedida).toBe(false);
    if (!decision.concedida) {
      expect(decision.motivo).toBe("tope_por_ejecucion");
      expect(decision.consumido).toBe(4);
      expect(decision.techo).toBe(4);
    }
  });

  it("y la cuarta todavía se concede", () => {
    const p = leerPresupuesto({});
    const decision = decidirReserva({
      coste: 1,
      total: 10,
      delPipeline: 3,
      deEstaEjecucion: 3,
      umbralGlobal: p.umbralGlobal,
      techoMensualDelPipeline: p.techoMensualPorPipeline.deltas,
      topeDeLaEjecucion: p.topePorEjecucion.deltas,
    });
    expect(decision.concedida).toBe(true);
  });

  it("el umbral global sigue mandando por encima del techo de deltas", () => {
    const p = leerPresupuesto({});
    const decision = decidirReserva({
      coste: 1,
      total: p.umbralGlobal,
      delPipeline: 0,
      deEstaEjecucion: 0,
      umbralGlobal: p.umbralGlobal,
      techoMensualDelPipeline: p.techoMensualPorPipeline.deltas,
      topeDeLaEjecucion: p.topePorEjecucion.deltas,
    });
    expect(decision.concedida).toBe(false);
    if (!decision.concedida) expect(decision.motivo).toBe("global");
  });
});

describe("la política de `expiring` (2026-09-24)", () => {
  /** 📏 Fila 44: un recorrido completo del horizonte de 31 días. */
  const MEDIDO_POR_RECORRIDO = 6;
  /** Semanas que un ciclo de 31 días puede empezar: el máximo de ejecuciones. */
  const EJECUCIONES_MAXIMAS_POR_CICLO = 5;

  it("tope = 12 por ejecución y techo = 60 al mes, en el repositorio y en lo leído", () => {
    expect(TOPE_POR_EJECUCION_POR_DEFECTO.expiring).toBe(12);
    expect(TECHO_MENSUAL_POR_DEFECTO.expiring).toBe(60);
    const p = leerPresupuesto({});
    expect(p.topePorEjecucion.expiring).toBe(12);
    expect(p.techoMensualPorPipeline.expiring).toBe(60);
  });

  it("12 = el doble de lo medido (6): margen operativo, no previsión", () => {
    expect(TOPE_POR_EJECUCION_POR_DEFECTO.expiring).toBe(2 * MEDIDO_POR_RECORRIDO);
  });

  it("60 = 5 ejecuciones × tope 12: si cambia el tope, esto lo ve", () => {
    expect(TECHO_MENSUAL_POR_DEFECTO.expiring).toBe(
      EJECUCIONES_MAXIMAS_POR_CICLO * TOPE_POR_EJECUCION_POR_DEFECTO.expiring,
    );
  });

  it("el consumo esperado con lo medido (24–30) cabe con holgura en el techo", () => {
    const esperadoMaximo = EJECUCIONES_MAXIMAS_POR_CICLO * MEDIDO_POR_RECORRIDO;
    expect([4 * MEDIDO_POR_RECORRIDO, esperadoMaximo]).toEqual([24, 30]);
    const decision = decidirReserva({
      ...SIN_ESTORBOS,
      delPipeline: esperadoMaximo - 1,
      techoMensualDelPipeline: TECHO_MENSUAL_POR_DEFECTO.expiring,
      topeDeLaEjecucion: TOPE_POR_EJECUCION_POR_DEFECTO.expiring,
    });
    expect(decision.concedida).toBe(true);
  });

  it("la 12.ª request de una ejecución se concede", () => {
    const p = leerPresupuesto({});
    const decision = decidirReserva({
      coste: 1,
      total: 11,
      delPipeline: 11,
      deEstaEjecucion: 11,
      umbralGlobal: p.umbralGlobal,
      techoMensualDelPipeline: p.techoMensualPorPipeline.expiring,
      topeDeLaEjecucion: p.topePorEjecucion.expiring,
    });
    expect(decision.concedida).toBe(true);
  });

  it("la 13.ª se deniega por tope, aunque sobre techo mensual y global", () => {
    const p = leerPresupuesto({});
    const decision = decidirReserva({
      coste: 1,
      total: 12,
      delPipeline: 12, // quedan 48 en el mes y 888 en el ciclo
      deEstaEjecucion: 12,
      umbralGlobal: p.umbralGlobal,
      techoMensualDelPipeline: p.techoMensualPorPipeline.expiring,
      topeDeLaEjecucion: p.topePorEjecucion.expiring,
    });
    expect(decision.concedida).toBe(false);
    if (!decision.concedida) {
      expect(decision.motivo).toBe("tope_por_ejecucion");
      expect(decision.consumido).toBe(12);
      expect(decision.techo).toBe(12);
    }
  });

  it("una sexta ejecución de 12 en el mismo ciclo la frena el techo mensual", () => {
    const p = leerPresupuesto({});
    const decision = decidirReserva({
      coste: 1,
      total: 60,
      delPipeline: 60,
      deEstaEjecucion: 0,
      umbralGlobal: p.umbralGlobal,
      techoMensualDelPipeline: p.techoMensualPorPipeline.expiring,
      topeDeLaEjecucion: p.topePorEjecucion.expiring,
    });
    expect(decision.concedida).toBe(false);
    if (!decision.concedida) expect(decision.motivo).toBe("mensual_del_pipeline");
  });

  it("el presupuesto global sigue por debajo de 900: suma de techos ≤ umbral", () => {
    const p = leerPresupuesto({});
    const suma = Object.values(p.techoMensualPorPipeline).reduce((n, x) => n + x, 0);
    expect(p.umbralGlobal).toBe(900);
    expect(suma).toBeLessThanOrEqual(p.umbralGlobal);
    // Y deltas y expiring juntos, a pleno techo, quedan muy lejos.
    expect(p.techoMensualPorPipeline.deltas + p.techoMensualPorPipeline.expiring).toBe(
      184,
    );
  });

  it("y el global sigue mandando por encima del techo de expiring", () => {
    const p = leerPresupuesto({});
    const decision = decidirReserva({
      coste: 1,
      total: p.umbralGlobal,
      delPipeline: 0,
      deEstaEjecucion: 0,
      umbralGlobal: p.umbralGlobal,
      techoMensualDelPipeline: p.techoMensualPorPipeline.expiring,
      topeDeLaEjecucion: p.topePorEjecucion.expiring,
    });
    expect(decision.concedida).toBe(false);
    if (!decision.concedida) expect(decision.motivo).toBe("global");
  });
});

describe("la política de `upcoming` (2026-09-24)", () => {
  /** 📏 Fila 50: un recorrido completo del horizonte de 31 días. */
  const MEDIDO_POR_RECORRIDO = 3;
  /** Semanas que un ciclo de 31 días puede empezar: el máximo de ejecuciones. */
  const EJECUCIONES_MAXIMAS_POR_CICLO = 5;

  it("tope = 8 por ejecución y techo = 40 al mes, en el repositorio y en lo leído", () => {
    expect(TOPE_POR_EJECUCION_POR_DEFECTO.upcoming).toBe(8);
    expect(TECHO_MENSUAL_POR_DEFECTO.upcoming).toBe(40);
    const p = leerPresupuesto({});
    expect(p.topePorEjecucion.upcoming).toBe(8);
    expect(p.techoMensualPorPipeline.upcoming).toBe(40);
  });

  it("8 es más del doble de lo medido (3): margen operativo, no previsión", () => {
    expect(TOPE_POR_EJECUCION_POR_DEFECTO.upcoming).toBeGreaterThan(
      2 * MEDIDO_POR_RECORRIDO,
    );
  });

  it("40 = 5 ejecuciones × tope 8: si cambia el tope, esto lo ve", () => {
    expect(TECHO_MENSUAL_POR_DEFECTO.upcoming).toBe(
      EJECUCIONES_MAXIMAS_POR_CICLO * TOPE_POR_EJECUCION_POR_DEFECTO.upcoming,
    );
  });

  it("el consumo esperado con lo medido (12–15) cabe con holgura en el techo", () => {
    const esperadoMaximo = EJECUCIONES_MAXIMAS_POR_CICLO * MEDIDO_POR_RECORRIDO;
    expect([4 * MEDIDO_POR_RECORRIDO, esperadoMaximo]).toEqual([12, 15]);
    const decision = decidirReserva({
      ...SIN_ESTORBOS,
      delPipeline: esperadoMaximo - 1,
      techoMensualDelPipeline: TECHO_MENSUAL_POR_DEFECTO.upcoming,
      topeDeLaEjecucion: TOPE_POR_EJECUCION_POR_DEFECTO.upcoming,
    });
    expect(decision.concedida).toBe(true);
  });

  it("la 8.ª request de una ejecución se concede", () => {
    const p = leerPresupuesto({});
    const decision = decidirReserva({
      coste: 1,
      total: 7,
      delPipeline: 7,
      deEstaEjecucion: 7,
      umbralGlobal: p.umbralGlobal,
      techoMensualDelPipeline: p.techoMensualPorPipeline.upcoming,
      topeDeLaEjecucion: p.topePorEjecucion.upcoming,
    });
    expect(decision.concedida).toBe(true);
  });

  it("la 9.ª se deniega por tope, aunque sobre techo mensual y global", () => {
    const p = leerPresupuesto({});
    const decision = decidirReserva({
      coste: 1,
      total: 8,
      delPipeline: 8, // quedan 32 en el mes y 892 en el ciclo
      deEstaEjecucion: 8,
      umbralGlobal: p.umbralGlobal,
      techoMensualDelPipeline: p.techoMensualPorPipeline.upcoming,
      topeDeLaEjecucion: p.topePorEjecucion.upcoming,
    });
    expect(decision.concedida).toBe(false);
    if (!decision.concedida) {
      expect(decision.motivo).toBe("tope_por_ejecucion");
      expect(decision.consumido).toBe(8);
      expect(decision.techo).toBe(8);
    }
  });

  it("cinco ejecuciones al tope caben; una sexta no: la frena el techo mensual", () => {
    const p = leerPresupuesto({});
    const reservar = (delPipeline: number, deEstaEjecucion: number) =>
      decidirReserva({
        coste: 1,
        total: delPipeline,
        delPipeline,
        deEstaEjecucion,
        umbralGlobal: p.umbralGlobal,
        techoMensualDelPipeline: p.techoMensualPorPipeline.upcoming,
        topeDeLaEjecucion: p.topePorEjecucion.upcoming,
      });
    // La última request de la quinta ejecución al tope: 4 × 8 + 7 = 39.
    expect(reservar(4 * 8 + 7, 7).concedida).toBe(true);
    // La primera de la sexta, con las cinco anteriores agotando 8 cada una.
    const sexta = reservar(5 * 8, 0);
    expect(sexta.concedida).toBe(false);
    if (!sexta.concedida) {
      expect(sexta.motivo).toBe("mensual_del_pipeline");
      expect(sexta.consumido).toBe(40);
      expect(sexta.techo).toBe(40);
    }
  });

  it("la suma global de techos sigue por debajo del umbral de 900", () => {
    const p = leerPresupuesto({});
    const suma = Object.values(p.techoMensualPorPipeline).reduce((n, x) => n + x, 0);
    expect(p.umbralGlobal).toBe(900);
    expect(suma).toBeLessThan(p.umbralGlobal);
    // Los tres jobs registrados juntos, a pleno techo: 124 + 60 + 40.
    expect(
      p.techoMensualPorPipeline.deltas +
        p.techoMensualPorPipeline.expiring +
        p.techoMensualPorPipeline.upcoming,
    ).toBe(224);
  });

  it("y el global sigue mandando por encima del techo de upcoming", () => {
    const p = leerPresupuesto({});
    const decision = decidirReserva({
      coste: 1,
      total: p.umbralGlobal,
      delPipeline: 0,
      deEstaEjecucion: 0,
      umbralGlobal: p.umbralGlobal,
      techoMensualDelPipeline: p.techoMensualPorPipeline.upcoming,
      topeDeLaEjecucion: p.topePorEjecucion.upcoming,
    });
    expect(decision.concedida).toBe(false);
    if (!decision.concedida) expect(decision.motivo).toBe("global");
  });
});

describe("el invariante tope ≤ techo mensual", () => {
  it("hoy no hay ninguna excepción registrada, y esa es la respuesta correcta", () => {
    expect(Object.keys(EXCEPCIONES_AL_INVARIANTE)).toHaveLength(0);
  });

  it("los valores por defecto del repositorio lo cumplen", () => {
    for (const nombre of NOMBRES_DE_PIPELINE) {
      const mensual = TECHO_MENSUAL_POR_DEFECTO[nombre];
      const porEjecucion = TOPE_POR_EJECUCION_POR_DEFECTO[nombre];
      if (mensual > 0 && porEjecucion > 0) {
        expect(porEjecucion).toBeLessThanOrEqual(mensual);
      }
    }
  });

  it("aborta si una configuración lo viola", () => {
    expect(() =>
      leerPresupuesto({
        STREAMING_API_MONTHLY_PIPELINE_BUDGETS: "deltas=60",
        STREAMING_API_PER_RUN_CAPS: "deltas=61",
      }),
    ).toThrow(/supera su techo/);
  });

  it("no se aplica cuando el techo mensual es 0: ahí manda el 0, que ya deniega", () => {
    const p = leerPresupuesto({ STREAMING_API_PER_RUN_CAPS: "seed=50" });
    expect(p.techoMensualPorPipeline.seed).toBe(0);
    expect(p.topePorEjecucion.seed).toBe(50);
    // Sigue sin poder gastar: el techo mensual de 0 corta antes.
    const decision = decidirReserva({
      ...SIN_ESTORBOS,
      techoMensualDelPipeline: 0,
      topeDeLaEjecucion: 50,
    });
    expect(decision.concedida).toBe(false);
    if (!decision.concedida) expect(decision.motivo).toBe("mensual_del_pipeline");
  });
});

describe("el umbral del 90 %", () => {
  it("es 900 con el plan gratuito", () => {
    expect(calcularUmbralGlobal(1000, 0.9)).toBe(900);
  });

  it("redondea hacia abajo, nunca hacia arriba", () => {
    // 0,9 × 999 = 899,1. Hacia arriba serían 900, y 900 > el 90 % permitido.
    expect(calcularUmbralGlobal(999, 0.9)).toBe(899);
    expect(calcularUmbralGlobal(1001, 0.9)).toBe(900);
  });

  it("se graba en budget_limit el umbral, no el bruto contractual", () => {
    expect(PRUEBA.presupuestoMensual).toBe(1000);
    expect(PRUEBA.umbralGlobal).toBe(900);
  });
});

describe("la frontera exacta del techo global", () => {
  it("concede la request que deja el contador justo en el umbral", () => {
    const decision = decidirReserva({ ...SIN_ESTORBOS, total: 899, umbralGlobal: 900 });
    expect(decision.concedida).toBe(true);
    if (decision.concedida) expect(decision.consumidoTrasReservar).toBe(900);
  });

  it("deniega la siguiente, la que lo rebasaría", () => {
    const decision = decidirReserva({ ...SIN_ESTORBOS, total: 900, umbralGlobal: 900 });
    expect(decision.concedida).toBe(false);
    if (!decision.concedida) {
      expect(decision.motivo).toBe("global");
      expect(decision.techo).toBe(900);
    }
  });

  it("deja 100 requests de margen intacto sobre un plan de 1.000", () => {
    let consumido = 0;
    while (
      decidirReserva({ ...SIN_ESTORBOS, total: consumido, umbralGlobal: 900 }).concedida
    ) {
      consumido += 1;
    }
    expect(consumido).toBe(900);
    expect(1000 - consumido).toBe(100);
  });

  it("el global manda aunque el pipeline tenga margen de sobra", () => {
    const decision = decidirReserva({
      ...SIN_ESTORBOS,
      total: 900,
      umbralGlobal: 900,
      techoMensualDelPipeline: 500,
    });
    expect(decision.concedida).toBe(false);
    if (!decision.concedida) expect(decision.motivo).toBe("global");
  });
});

describe("un pipeline desconocido falla cerrado", () => {
  it("en el mapa de techos mensuales", () => {
    expect(() =>
      leerPresupuesto({ STREAMING_API_MONTHLY_PIPELINE_BUDGETS: "delta=60" }),
    ).toThrow(/pipeline desconocido/);
  });

  it("y también en el de topes por ejecución", () => {
    expect(() => leerPresupuesto({ STREAMING_API_PER_RUN_CAPS: "seeed=5" })).toThrow(
      /pipeline desconocido/,
    );
  });

  it("el error dice QUÉ variable se estaba leyendo", () => {
    // Los dos mapas tienen la misma forma y unidades distintas: un error que no
    // diga cuál se está leyendo deja pasar una cifra en la unidad equivocada.
    expect(() => leerPresupuesto({ STREAMING_API_PER_RUN_CAPS: "x=1" })).toThrow(
      /STREAMING_API_PER_RUN_CAPS/,
    );
    expect(() =>
      leerPresupuesto({ STREAMING_API_MONTHLY_PIPELINE_BUDGETS: "x=1" }),
    ).toThrow(/STREAMING_API_MONTHLY_PIPELINE_BUDGETS/);
  });
});

describe("la configuración aborta en vez de caer a un valor por defecto", () => {
  it("rechaza un presupuesto que no es un entero", () => {
    expect(() => leerPresupuesto({ STREAMING_API_MONTHLY_BUDGET: "mil" })).toThrow(
      /entero/,
    );
    expect(() => leerPresupuesto({ STREAMING_API_MONTHLY_BUDGET: "-5" })).toThrow(
      /entero/,
    );
    expect(() => leerPresupuesto({ STREAMING_API_MONTHLY_BUDGET: "1e3" })).toThrow(
      /entero/,
    );
  });

  it("rechaza un presupuesto de 0", () => {
    expect(() => leerPresupuesto({ STREAMING_API_MONTHLY_BUDGET: "0" })).toThrow(
      /no puede ser 0/,
    );
  });

  it("rechaza una fracción fuera de (0, 1]", () => {
    expect(() => leerPresupuesto({ STREAMING_API_BUDGET_STOP_FRACTION: "0" })).toThrow(
      /\(0, 1\]/,
    );
    expect(() =>
      leerPresupuesto({ STREAMING_API_BUDGET_STOP_FRACTION: "1.5" }),
    ).toThrow(/\(0, 1\]/);
  });

  it("acepta una fracción de 1, que es «sin margen de reserva»", () => {
    expect(
      leerPresupuesto({ STREAMING_API_BUDGET_STOP_FRACTION: "1" }).umbralGlobal,
    ).toBe(1000);
  });
});

describe("la identidad del lock de pipeline", () => {
  it("cubre todo el vocabulario cerrado", () => {
    for (const nombre of NOMBRES_DE_PIPELINE) {
      expect(Number.isSafeInteger(PIPELINE_ID[nombre])).toBe(true);
    }
    expect(Object.keys(PIPELINE_ID)).toHaveLength(NOMBRES_DE_PIPELINE.length);
  });

  it("no repite ningún entero: una colisión excluiría dos pipelines entre sí", () => {
    const ids: number[] = NOMBRES_DE_PIPELINE.map(
      (n: NombreDePipeline) => PIPELINE_ID[n],
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});
