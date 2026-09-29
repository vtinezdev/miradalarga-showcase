/**
 * **La autorización del seed, ligada a un ciclo de cuota** (ADR 0009 §3).
 *
 * El seed no tiene presupuesto recurrente: `TECHO_MENSUAL_POR_DEFECTO.seed` y
 * `TOPE_POR_EJECUCION_POR_DEFECTO.seed` valen **0** y así se quedan. Lo que
 * gasta —M1 (≤ 10) en un ciclo y la captura (≤ 450) en el siguiente— lo
 * concede **una entrada de esta lista**, que lleva la clave del ciclo
 * (`YYYYMM`) y la fase. Fuera de ese ciclo, o para otra fase, el tope y el
 * techo efectivos son **0**: la autorización no se «recuerda revocar», caduca
 * sola al cambiar de ciclo.
 *
 * ⚖️ **Tres clases de cifra, separadas:**
 *
 *   · **Presupuesto aprobado** — solo lo que esté en `AUTORIZACIONES_DEL_SEED`,
 *     añadido en un commit tras la aprobación explícita de ese ciclo.
 *   · **Guardrail técnico** — `MAXIMO_POR_FASE`: lo que ADR 0009 acepta en
 *     principio (10 y 450). Una entrada que lo supere no se carga.
 *   · **Estimación** — `costes-medidos.ts` y el ADR (~276 esperadas, ~400 peor
 *     caso). No autoriza nada y este fichero no la importa.
 *
 * ⚖️ **Una sola autorización por ciclo**, de una sola fase: M1 y la captura no
 * comparten ciclo, por construcción.
 *
 * **Hoy: M1 de 202609** (≤ 10, caduca el 2026-10-01T00:00Z) **y la captura de
 * 202610** (≤ 450), que **no está activa hasta el 2026-10-01T00:00Z** y caduca
 * el 2026-11-01T00:00Z. Su misma entrada congela la rama histórica ese ciclo
 * (`congelacionDelDestino`).
 */
import type { FaseDelSeed, Presupuesto } from "./contratos.ts";
import { calcularCiclo } from "./presupuesto.ts";

/** Las fases del seed que gastan cuota. La carga nunca reserva. */
export type FaseQueGasta = Exclude<FaseDelSeed, "carga">;

export interface AutorizacionDelSeed {
  /** `YYYYMM` del ciclo de cuota, en UTC, con el día de ciclo del presupuesto. */
  readonly ciclo: number;
  readonly fase: FaseQueGasta;
  /** Requests de UNA ejecución. */
  readonly tope: number;
  /** Requests de TODO el ciclo para `seed`: incluye reanudaciones. */
  readonly techo: number;
  /** Fecha ISO de la aprobación. */
  readonly aprobadaEl: string;
  /** Dónde consta: el commit o la conversación que la aprobó. */
  readonly referencia: string;
}

/** 🛡️ Guardrail técnico: lo que ADR 0009 §3 acepta en principio por fase. */
export const MAXIMO_POR_FASE: Readonly<Record<FaseQueGasta, number>> = {
  sonda: 10,
  captura: 450,
};

/**
 * ⚖️ **Presupuesto aprobado del seed.** Una entrada por ciclo, añadida en el
 * commit de su aprobación. Es la única forma de que el seed gaste cuota.
 *
 *   · **202609 · sonda (M1) · 10/10** — aprobada el 2026-09-27
 *     (`aprobacion-m1-seed`). Solo M1. Caduca sola el 2026-10-01T00:00Z.
 *   · **202610 · captura · 450/450** — aprobada el 2026-09-27
 *     (`aprobacion-captura-seed-202610`): la captura de `seed-es-202610`
 *     contra la rama limpia del seed real, reanudaciones incluidas en el techo.
 *     **Inactiva antes del 2026-10-01T00:00Z** (0/0) y caduca sola el
 *     2026-11-01T00:00Z. Activa, congela la rama histórica todo el ciclo.
 */
export const AUTORIZACIONES_DEL_SEED: readonly AutorizacionDelSeed[] = [
  {
    ciclo: 202609,
    fase: "sonda",
    tope: 10,
    techo: 10,
    aprobadaEl: "2026-09-27",
    referencia: "aprobacion-m1-seed",
  },
  {
    ciclo: 202610,
    fase: "captura",
    tope: 450,
    techo: 450,
    aprobadaEl: "2026-09-27",
    referencia: "aprobacion-captura-seed-202610",
  },
];

function esClaveDeCiclo(c: number): boolean {
  return (
    Number.isInteger(c) && c >= 200001 && c <= 999912 && c % 100 >= 1 && c % 100 <= 12
  );
}

/**
 * Lanza si la lista no es coherente: ciclo válido, fase conocida, `1 ≤ tope ≤
 * techo ≤ máximo de la fase`, y **una sola entrada por ciclo**.
 */
export function validarAutorizaciones(lista: readonly AutorizacionDelSeed[]): void {
  const ciclos = new Set<number>();
  for (const a of lista) {
    const donde = `autorización del seed ${String(a.ciclo)}/${a.fase}`;
    if (!esClaveDeCiclo(a.ciclo)) throw new Error(`${donde}: ciclo YYYYMM inválido.`);
    if (!(a.fase in MAXIMO_POR_FASE))
      throw new Error(`${donde}: fase que no gasta cuota.`);
    if (!Number.isSafeInteger(a.tope) || a.tope < 1) {
      throw new Error(`${donde}: el tope es un entero ≥ 1.`);
    }
    if (!Number.isSafeInteger(a.techo) || a.techo < a.tope) {
      throw new Error(`${donde}: el techo del ciclo no puede ser menor que el tope.`);
    }
    if (a.techo > MAXIMO_POR_FASE[a.fase]) {
      throw new Error(
        `${donde}: ${String(a.techo)} supera el máximo aceptado para ${a.fase} ` +
          `(${String(MAXIMO_POR_FASE[a.fase])}). Ampliarlo exige reabrir ADR 0009 §3.`,
      );
    }
    if (a.aprobadaEl.trim() === "" || a.referencia.trim() === "") {
      throw new Error(`${donde}: sin fecha o referencia de aprobación.`);
    }
    if (ciclos.has(a.ciclo)) {
      throw new Error(
        `Dos autorizaciones del seed en el ciclo ${String(a.ciclo)}: M1 y la captura no comparten ciclo.`,
      );
    }
    ciclos.add(a.ciclo);
  }
}

/** La autorización de esa fase en el ciclo de `ahora`, o `null`. */
export function autorizacionVigente(
  fase: FaseQueGasta,
  ahora: Date,
  diaDeCiclo: number,
  lista: readonly AutorizacionDelSeed[] = AUTORIZACIONES_DEL_SEED,
): AutorizacionDelSeed | null {
  validarAutorizaciones(lista);
  const ciclo = calcularCiclo(ahora, diaDeCiclo).clave;
  return lista.find((a) => a.ciclo === ciclo && a.fase === fase) ?? null;
}

/**
 * El presupuesto **efectivo** del seed para esa fase en el ciclo de `ahora`:
 * el del repositorio con el tope y el techo de `seed` sustituidos por los de
 * la autorización, o **0/0** si no la hay. Ningún otro pipeline cambia.
 *
 * ⚠️ `reservar()` recalcula el ciclo en cada reserva y deniega con
 * `frontera_de_ciclo` si ha cambiado: una ejecución que cruce la medianoche
 * del día de ciclo no se lleva la autorización al ciclo siguiente.
 */
export function presupuestoDelSeed(
  base: Presupuesto,
  fase: FaseQueGasta,
  ahora: Date,
  lista: readonly AutorizacionDelSeed[] = AUTORIZACIONES_DEL_SEED,
): Presupuesto {
  const a = autorizacionVigente(fase, ahora, base.diaDeCiclo, lista);
  return {
    ...base,
    techoMensualPorPipeline: { ...base.techoMensualPorPipeline, seed: a?.techo ?? 0 },
    topePorEjecucion: { ...base.topePorEjecucion, seed: a?.tope ?? 0 },
  };
}
