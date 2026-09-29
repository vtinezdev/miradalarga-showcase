/**
 * **El plan de la captura, fijado desde M1** (ADR 0009 §1, §3, §4). Función
 * pura: un resultado de M1 **verificado y utilizable** → `plan.json` v1.
 *
 *   · Cada estrato lleva el `order_by` que M1 decidió para su plataforma, y el
 *     plan guarda esas decisiones con su motivo (`m1.decisiones`).
 *   · El plan referencia la fila y **el ciclo** de la M1 que lo respalda y la
 *     huella de `m1.json`: la captura solo arranca en el ciclo siguiente
 *     (`m1_caducada`), y un plan no puede atribuirse otra medición.
 *   · El tope del plan es el máximo aceptado para la captura (450). Lo que se
 *     puede gastar de verdad lo decide la autorización del ciclo
 *     (`autorizacion-del-seed.ts`), no el plan.
 */
import { MAXIMO_POR_FASE } from "../../ops/autorizacion-del-seed.ts";
import type { PlanDelSeed } from "./crudo/formato.ts";
import {
  ESTRATOS_DEL_MVP,
  FORMATO_DEL_PLAN,
  MARGEN_DEL_ANCLA_SEGUNDOS,
  OBJETIVO_DE_UNICOS,
  PARAMETROS_COMUNES,
  PLAZO_DEL_ANCLA_SEGUNDOS,
  VERSION_DEL_CRUDO,
  planV1,
} from "./crudo/formato.ts";
import type { VerificacionDeM1 } from "./m1.ts";

export function construirPlanDesdeM1(
  m1: VerificacionDeM1,
  opciones: {
    readonly capturaId: string;
    readonly commit: string | null;
    readonly tope?: number;
    readonly objetivoUnicos?: number;
  },
): PlanDelSeed {
  const r = m1.resultado;
  if (!m1.ok || !m1.utilizable || r === null || m1.huella === null) {
    throw new Error(
      "M1 no es utilizable: tiene que verificar, terminar succeeded y haber medido sus 10 estratos.",
    );
  }
  const orden = new Map(r.decisiones.map((d) => [d.plataforma, d.orderBy]));
  return planV1.parse({
    formato: FORMATO_DEL_PLAN,
    v: VERSION_DEL_CRUDO,
    capturaId: opciones.capturaId,
    commit: opciones.commit,
    pais: "es",
    parametrosComunes: { ...PARAMETROS_COMUNES },
    estratos: ESTRATOS_DEL_MVP.map((e) => ({
      ...e,
      orderBy: orden.get(e.plataforma) ?? "rating",
      orderDirection: "desc" as const,
    })),
    objetivoUnicos: opciones.objetivoUnicos ?? OBJETIVO_DE_UNICOS,
    tope: opciones.tope ?? MAXIMO_POR_FASE.captura,
    margenDelAnclaSegundos: MARGEN_DEL_ANCLA_SEGUNDOS,
    plazoDelAnclaSegundos: PLAZO_DEL_ANCLA_SEGUNDOS,
    m1: {
      runId: r.runId,
      cicloClave: r.cicloClave,
      diaDeCiclo: r.diaDeCiclo,
      huellaDelResultado: m1.huella,
      decisiones: r.decisiones,
    },
  });
}
