/**
 * **La compuerta de `production`** (ADR 0009 §9 «C · Listo para cargar
 * `production`», ADR 0010): lo que un crudo tiene que haber superado en
 * validación antes de que `production` lo acepte. Funciones puras: los
 * ficheros los lee el script.
 *
 * ⚖️ **Un crudo refutado por M4 nunca se carga en `production`.** La
 * compuerta no se fía del `<capturaId>.m4.json` que dejó `seed:m4`: exige
 * además **recalcular M4** desde los crudos del primer `deltas` que ese
 * fichero nombra, y que el resultado recalculado coincida y no refute. Un
 * informe editado a mano, perdido o de otra huella niega; un recálculo que no
 * se puede hacer, también (fail closed).
 *
 * Lo que exige, además de M4:
 *
 *   · crudo **real** (un crudo de ensayo nunca va a `production`);
 *   · **recibo de aceptación** de la rama del seed real (dos etapas, abajo):
 *     misma huella del crudo, huella canónica leída de PostgreSQL igual a la
 *     del crudo, mismo `S`, primer `deltas` desde `S`, bootstrap completo y
 *     ningún `added` sobre ofertas del seed.
 */
import type { InformeM4 } from "./m4.ts";

/**
 * **El recibo de aceptación**, al lado del crudo, en dos etapas y en la rama
 * del seed real:
 *
 *   1. `seed:validar` (exit 0) escribe `carga`: la huella canónica **leída de
 *      PostgreSQL** tras la carga. Es la única ocasión de leerla: el primer
 *      `deltas` cambia el catálogo después.
 *   2. `seed:validar:primer-deltas` (exit 0) añade `primerDeltas`: su
 *      `ventana.from`, la fila que completó el bootstrap y que no emitió
 *      `added` sobre ofertas del seed.
 */
export interface ReciboDeAceptacion {
  readonly formato: "mirada-larga.seed.aceptacion";
  readonly v: 1;
  readonly capturaId: string;
  /** Huella del crudo. */
  readonly huella: string;
  /** `S`, ISO. */
  readonly ancla: string;
  /** La rama que aceptó. */
  readonly rama: string;
  readonly carga: {
    /** Huella canónica leída de PostgreSQL tras la carga. */
    readonly huellaCanonicaLeida: string;
    /** Fila del ancla, texto decimal. */
    readonly anclaRunId: string;
    /** `now()` del servidor al validar, ISO. */
    readonly validadaEl: string;
  };
  readonly primerDeltas: {
    /** `ops_sync_runs.id` del primer `deltas` completo, texto decimal. */
    readonly bootstrapRunId: string;
    /** `ventana.from` del primer `deltas`, ISO. Tiene que ser `S`. */
    readonly primerFrom: string;
    /** `added` sobre ofertas que ya estaban en el seed, sin baja previa: 0. */
    readonly addedSobreOfertasDelSeed: number;
    /** `now()` del servidor al validar, ISO. */
    readonly validadoEl: string;
  } | null;
}

/** Lo que `seed:m4` deja al lado del crudo. Solo lo que la compuerta lee. */
export interface M4Guardado {
  readonly capturaId: string;
  readonly huellaDelCrudo: string;
  /** Los directorios de `.deltas-runs/` que usó, por su nombre. */
  readonly deltas: readonly string[];
  readonly resultado: InformeM4["resultado"];
  readonly permiteProduction: boolean;
  readonly muestras: number;
  readonly retrasoMaximoObservadoSegundos: number | null;
}

export interface CrudoParaLaCompuerta {
  readonly huella: string;
  readonly huellaCanonica: string;
  readonly capturaId: string;
  readonly ancla: Date;
  readonly esEnsayo: boolean;
}

export interface EntradaDeLaCompuerta {
  readonly crudo: CrudoParaLaCompuerta;
  readonly ramaDeAceptacion: string;
  readonly aceptacion: ReciboDeAceptacion | null;
  readonly m4Guardado: M4Guardado | null;
  /** `null` si no se pudo recalcular (sin crudos de `deltas`, ilegibles…). */
  readonly m4Recalculado: Pick<
    InformeM4,
    "resultado" | "muestras" | "retrasoMaximoObservadoSegundos"
  > | null;
}

export interface EstadoDeLaCompuerta {
  readonly ok: boolean;
  readonly problemas: readonly string[];
}

export function evaluarCompuertaDeProduction(
  e: EntradaDeLaCompuerta,
): EstadoDeLaCompuerta {
  const p: string[] = [];
  const { crudo } = e;

  if (crudo.esEnsayo) p.push("es un crudo de ensayo: nunca va a production");

  // ── Aceptación en validación ───────────────────────────────────────────────
  const a = e.aceptacion;
  if (a === null) {
    p.push("sin recibo de aceptación: la rama del seed real no ha validado este crudo");
  } else {
    if (a.formato !== "mirada-larga.seed.aceptacion" || a.v !== 1) {
      p.push("recibo de aceptación con formato desconocido");
    }
    if (a.huella !== crudo.huella) p.push("la aceptación es de otra huella del crudo");
    if (a.capturaId !== crudo.capturaId) p.push("la aceptación es de otra captura");
    if (Date.parse(a.ancla) !== crudo.ancla.getTime()) {
      p.push("el S aceptado no es el S del crudo");
    }
    if (a.rama !== e.ramaDeAceptacion) {
      p.push(`la aceptación es de ${a.rama}, no de ${e.ramaDeAceptacion}`);
    }
    if (a.carga.huellaCanonicaLeida !== crudo.huellaCanonica) {
      p.push("la huella canónica leída en validación no es la del crudo");
    }
    const d = a.primerDeltas;
    if (d === null) {
      p.push(
        "la validación no ha aceptado todavía el primer deltas (bootstrap incompleto)",
      );
    } else {
      if (Date.parse(d.primerFrom) !== crudo.ancla.getTime()) {
        p.push("el primer deltas de validación no empezó exactamente en S");
      }
      if (!/^[1-9]\d*$/.test(d.bootstrapRunId)) {
        p.push("la aceptación no nombra el primer deltas completo");
      }
      if (d.addedSobreOfertasDelSeed !== 0) {
        p.push("el primer deltas de validación emitió added sobre ofertas del seed");
      }
    }
  }

  // ── M4 ─────────────────────────────────────────────────────────────────────
  const g = e.m4Guardado;
  const r = e.m4Recalculado;
  if (g === null) {
    p.push("sin informe de M4 (<capturaId>.m4.json): M4 no se ha ejecutado");
  } else {
    if (g.huellaDelCrudo !== crudo.huella) p.push("el informe de M4 es de otra huella");
    if (g.capturaId !== crudo.capturaId) p.push("el informe de M4 es de otra captura");
    if (g.deltas.length === 0)
      p.push("el informe de M4 no nombra ningún primer deltas");
    if (g.resultado === "refutado" || !g.permiteProduction) {
      p.push(
        "M4 REFUTA el margen de 1 h: este crudo no va a production con este ancla",
      );
    }
  }
  if (r === null) {
    p.push("M4 no se puede recalcular desde los crudos del primer deltas");
  } else {
    if (r.resultado === "refutado") {
      p.push("M4 recalculado REFUTA el margen de 1 h: este crudo no va a production");
    }
    if (
      g !== null &&
      (g.resultado !== r.resultado ||
        g.muestras !== r.muestras ||
        g.retrasoMaximoObservadoSegundos !== r.retrasoMaximoObservadoSegundos)
    ) {
      p.push("el informe de M4 guardado no coincide con el recalculado");
    }
  }

  return { ok: p.length === 0, problemas: p };
}
