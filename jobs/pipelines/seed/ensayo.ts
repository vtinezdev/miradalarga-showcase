/**
 * **El crudo de ensayo** (milestone de validación del seed contra Neon).
 *
 * La captura real exige M1 y un presupuesto de 450 que **no existen todavía**
 * (ADR 0009 §3). Para ensayar la **carga** —transacción única, huella
 * canónica, idempotencia, rollback y ancla— contra una rama limpia hace falta
 * un crudo v1 verificable, y este es el más honesto posible con **0 requests**:
 *
 *   · **Cuerpos reales del proveedor**: la página 1 de los 12 estratos del
 *     Spike 1 (`spike-1/raw/003–014`, bloque B, 2026-09-21), desenvueltos de
 *     su `{meta, body}` y reserializados. Ningún show inventado.
 *   · **Pasados por el motor de captura de verdad** (`ejecutarCaptura`), con un
 *     libro de cuota **en memoria** y el reloj real: el formato, las huellas,
 *     el manifiesto y el ancla son exactamente los de una captura.
 *   · **Una sola ronda**: solo existe la página 1 de cada estrato, así que el
 *     objetivo es 1 y la captura cierra `objetivo_alcanzado` en la frontera de
 *     la ronda 1. Pedir una página 2 es un error, no una invención.
 *
 * ⚠️ **Lo que NO es real, y se dice:** las queries del manifiesto declaran el
 * orden del plan (`popularity_alltime`), pero los cuerpos se pidieron con el
 * orden por defecto; los instantes (`T0`, `S`, reservas, respuestas) son los
 * del reenvío, no los de la observación del 2026-09-21; la M1 del plan es
 * sintética (`M1_SINTETICA`), y la fila de la captura vive en memoria
 * (`DESTINO_DEL_ENSAYO`). Por eso un crudo de ensayo **solo** se carga en la
 * rama del seed, nunca en un destino que vaya a mantener `deltas` de verdad
 * (`esCrudoDeEnsayo`).
 *
 * Este módulo no lee disco, no conoce la red ni una base de datos: la fuente
 * se construye con cuerpos que le dan hechos.
 */
import type { Presupuesto } from "../../ops/contratos.ts";
import { calcularCiclo, leerPresupuesto } from "../../ops/presupuesto.ts";
import type { FuenteDePaginas } from "./captura.ts";
import type { PlanDelSeed } from "./crudo/formato.ts";
import {
  ESTRATOS_DEL_MVP,
  FORMATO_DEL_PLAN,
  MARGEN_DEL_ANCLA_SEGUNDOS,
  PARAMETROS_COMUNES,
  PLAZO_DEL_ANCLA_SEGUNDOS,
  VERSION_DEL_CRUDO,
} from "./crudo/formato.ts";

/** Todo `capturaId` de ensayo empieza así. Una captura real, nunca. */
export const PREFIJO_DE_ENSAYO = "ensayo-";

/** El «destino» de la captura de ensayo: un libro en memoria, no una base. */
export const DESTINO_DEL_ENSAYO = "memoria:ensayo";

/** Una ronda, 12 páginas: el tope y el techo del libro en memoria. */
export const PAGINAS_DEL_ENSAYO = ESTRATOS_DEL_MVP.length;

/**
 * El objetivo del plan de ensayo. Con solo la página 1 de cada estrato, la
 * única parada posible sin inventar una página 2 es la frontera de la ronda 1.
 */
export const OBJETIVO_DEL_ENSAYO = 1;

/**
 * La fila de M1 que declara el plan. **No hubo sonda**: es un valor que solo
 * satisface el formato v1, y es llamativo a propósito.
 */
export const M1_SINTETICA = "999999999";

/** El ciclo `YYYYMM` inmediatamente anterior. */
export function cicloAnterior(clave: number): number {
  const anio = Math.floor(clave / 100);
  const mes = clave % 100;
  return mes === 1 ? (anio - 1) * 100 + 12 : anio * 100 + mes - 1;
}

/**
 * El plan de ensayo: los 12 estratos en su orden fijo, objetivo 1, tope 12 y
 * una M1 sintética del ciclo anterior al de `inicio` —el único que el
 * verificador acepta—.
 */
export function planDeEnsayo(entrada: {
  readonly capturaId: string;
  readonly commit: string | null;
  readonly inicio: Date;
  readonly diaDeCiclo?: number;
}): PlanDelSeed {
  if (!entrada.capturaId.startsWith(PREFIJO_DE_ENSAYO)) {
    throw new Error(`Un crudo de ensayo se llama "${PREFIJO_DE_ENSAYO}…".`);
  }
  const diaDeCiclo = entrada.diaDeCiclo ?? 1;
  return {
    formato: FORMATO_DEL_PLAN,
    v: VERSION_DEL_CRUDO,
    capturaId: entrada.capturaId,
    commit: entrada.commit,
    pais: "es",
    parametrosComunes: { ...PARAMETROS_COMUNES },
    estratos: ESTRATOS_DEL_MVP.map((e) => ({
      ...e,
      orderBy: "popularity_alltime" as const,
      orderDirection: "desc" as const,
    })),
    objetivoUnicos: OBJETIVO_DEL_ENSAYO,
    tope: PAGINAS_DEL_ENSAYO,
    margenDelAnclaSegundos: MARGEN_DEL_ANCLA_SEGUNDOS,
    plazoDelAnclaSegundos: PLAZO_DEL_ANCLA_SEGUNDOS,
    m1: {
      runId: M1_SINTETICA,
      cicloClave: cicloAnterior(calcularCiclo(entrada.inicio, diaDeCiclo).clave),
      diaDeCiclo,
    },
  };
}

/**
 * El presupuesto **del libro en memoria**: 12 y 12 para `seed`, construido
 * desde un objeto literal —nunca desde `process.env`— y solo para esta
 * captura sin red. Los del repositorio siguen en 0/0.
 */
export function presupuestoDelEnsayo(): Presupuesto {
  return leerPresupuesto({
    STREAMING_API_PER_RUN_CAPS: `seed=${String(PAGINAS_DEL_ENSAYO)}`,
    STREAMING_API_MONTHLY_PIPELINE_BUDGETS: `seed=${String(PAGINAS_DEL_ENSAYO)}`,
  });
}

/**
 * La fuente que reenvía los cuerpos: **solo** la página 1 de cada estrato. Sin
 * cabeceras de cuota —no hubo proveedor—, así que el manifiesto las deja en
 * `null`. Cualquier otra petición lanza: la captura cierra `failed` antes que
 * fabricar una página.
 */
export function fuenteDeReplay(
  cuerpos: ReadonlyMap<string, Uint8Array>,
): FuenteDePaginas {
  return async (peticion, cuota) => {
    // Como la fuente real: primero la reserva, después la página.
    await cuota.pedirCuota();
    const estrato = peticion.estrato.estrato;
    if (peticion.cursorDeEntrada !== null) {
      throw new Error(
        `El crudo de ensayo solo tiene la página 1 de ${estrato}: no hay página ` +
          `para el cursor ${peticion.cursorDeEntrada}.`,
      );
    }
    const cuerpo = cuerpos.get(estrato);
    if (cuerpo === undefined) throw new Error(`Sin cuerpo de ensayo para ${estrato}.`);
    return { status: 200, cuerpo, cabeceras: {} };
  };
}

/** Lo mínimo de un crudo para saber si es de ensayo. */
export interface IdentidadDeCrudo {
  readonly plan: { readonly capturaId: string };
  readonly cierre: { readonly destino: string };
}

/**
 * **¿Es un crudo de ensayo?** Por cualquiera de las dos marcas: el prefijo del
 * `capturaId` o el destino en memoria. Uno solo basta para tratarlo como tal.
 */
export function esCrudoDeEnsayo(crudo: IdentidadDeCrudo): boolean {
  return (
    crudo.plan.capturaId.startsWith(PREFIJO_DE_ENSAYO) ||
    crudo.cierre.destino === DESTINO_DEL_ENSAYO
  );
}
