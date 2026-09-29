/**
 * La hora de pared en **`Europe/Madrid`**: la zona **editorial**.
 *
 * ── Dos zonas, dos conceptos. No se mezclan ─────────────────────────────────
 *
 *   · **Zona editorial — `Europe/Madrid`.** Fija el *bucket* diario de
 *     deduplicación del histórico (`jobs/pipelines/deltas/digest.ts`) y las
 *     fechas de producto. Vive aquí.
 *   · **Zona de facturación — UTC.** 📏 El proveedor reinicia la cuota a las
 *     00:00 UTC (`x-quota-reset: 2026-10-01T00:00:00Z`). El ciclo de
 *     presupuesto se calcula en UTC, en `presupuesto.ts`, y **no usa nada de
 *     este fichero**.
 *
 * ⚠️ Hasta el 2026-09-23 las dos compartían una sola constante `ZONA` en
 * `presupuesto.ts`, y el ciclo cortaba a las 00:00 de Madrid: 1–2 h antes que
 * el proveedor. Al separarlas, el bucket **no cambia** —forma parte de la
 * clave única de `external_availability_events`, y moverlo rompería la
 * idempotencia de los eventos ya escritos—; solo cambia el ciclo.
 */

/** La zona editorial. **Nunca** la del servidor, y nunca la de facturación. */
export const ZONA_EDITORIAL = "Europe/Madrid";

const FORMATO = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONA_EDITORIAL,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export interface HoraLocal {
  readonly anio: number;
  readonly mes: number;
  readonly dia: number;
  readonly hora: number;
  readonly minuto: number;
  readonly segundo: number;
}

/** La hora de pared en Madrid para un instante dado. */
export function horaEnMadrid(instante: Date): HoraLocal {
  const partes = FORMATO.formatToParts(instante);
  const leer = (tipo: Intl.DateTimeFormatPartTypes): number => {
    const parte = partes.find((p) => p.type === tipo);
    if (parte === undefined) throw new Error(`Intl no devolvió la parte "${tipo}".`);
    return Number.parseInt(parte.value, 10);
  };
  return {
    anio: leer("year"),
    mes: leer("month"),
    dia: leer("day"),
    hora: leer("hour"),
    minuto: leer("minute"),
    segundo: leer("second"),
  };
}

/** Desfase de Madrid respecto a UTC, en minutos, para ese instante concreto. */
function desfaseEnMinutos(instante: Date): number {
  const l = horaEnMadrid(instante);
  const comoSiFueraUtc = Date.UTC(
    l.anio,
    l.mes - 1,
    l.dia,
    l.hora,
    l.minuto,
    l.segundo,
  );
  // Los milisegundos se recortan a los dos lados: un desfase es siempre un
  // número entero de minutos, y restarlos de una marca con ms daría ruido.
  const base = Math.floor(instante.getTime() / 1000) * 1000;
  return (comoSiFueraUtc - base) / 60_000;
}

/**
 * El instante UTC de las 00:00 de Madrid de una fecha local.
 *
 * Dos pasadas: la primera conjetura el desfase situada en UTC, la segunda lo
 * corrige ya del lado correcto de un cambio de hora. La medianoche local
 * **siempre existe y es única**: los saltos de hora en España ocurren a las
 * 02:00/03:00, nunca a las 00:00.
 */
export function medianocheEnMadrid(anio: number, mes: number, dia: number): Date {
  const comoUtc = Date.UTC(anio, mes - 1, dia, 0, 0, 0);
  let instante = comoUtc;
  for (let pasada = 0; pasada < 2; pasada++) {
    instante = comoUtc - desfaseEnMinutos(new Date(instante)) * 60_000;
  }
  return new Date(instante);
}
