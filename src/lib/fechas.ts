/**
 * Fechas de la interfaz: siempre en `Europe/Madrid`, absolutas y cortas
 * (BRAND.md §6: «14 oct», con año solo si no es el actual).
 *
 * Todo lo que sale de aquí es **absoluto**: el HTML se cachea, y un «hoy»
 * escrito en el servidor sería mentira al día siguiente. El «hoy» y el «ayer»
 * los pone el cliente (`FreshnessStamp`).
 */

export const ZONA = "Europe/Madrid";
export const LOCALE = "es-ES";

const DIA_MES = new Intl.DateTimeFormat(LOCALE, {
  timeZone: ZONA,
  day: "numeric",
  month: "short",
});
const DIA_MES_ANIO = new Intl.DateTimeFormat(LOCALE, {
  timeZone: ZONA,
  day: "numeric",
  month: "short",
  year: "numeric",
});
const HORA = new Intl.DateTimeFormat(LOCALE, {
  timeZone: ZONA,
  hour: "2-digit",
  minute: "2-digit",
});
const EDICION = new Intl.DateTimeFormat(LOCALE, {
  timeZone: ZONA,
  weekday: "long",
  day: "numeric",
  month: "long",
});
const DIA_SEMANA = new Intl.DateTimeFormat(LOCALE, {
  timeZone: ZONA,
  weekday: "short",
  day: "numeric",
  month: "short",
});
const ANIO = new Intl.DateTimeFormat(LOCALE, { timeZone: ZONA, year: "numeric" });
const CLAVE_DIA = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONA,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** `sept.` → `sep`: el formato corto de Intl lleva punto y a veces cuatro letras. */
function limpiarMes(texto: string): string {
  return texto.replace(/\bsept\b/, "sep").replace(/\./g, "");
}

/** «14 oct», o «14 oct 2025» si no es el año de referencia. */
export function fechaCorta(instante: string, referencia: Date = new Date()): string {
  const fecha = new Date(instante);
  const mismoAnio = ANIO.format(fecha) === ANIO.format(referencia);
  return limpiarMes((mismoAnio ? DIA_MES : DIA_MES_ANIO).format(fecha));
}

/** «14 oct 2025», siempre con año. */
export function fechaConAnio(instante: string): string {
  return limpiarMes(DIA_MES_ANIO.format(new Date(instante)));
}

/** «sáb 27 sep»: la etiqueta de un día en la regla del radar. */
export function diaConSemana(instante: string): string {
  return limpiarMes(DIA_SEMANA.format(new Date(instante)).replace(",", ""));
}

/** El instante de mediodía (UTC) de un día `2026-09-28`: cae en ese día en Madrid. */
export function mediodia(dia: string): string {
  return `${dia}T12:00:00Z`;
}

/**
 * «hoy», «ayer», «mañana» o `null` para un día `2026-09-28`. Como
 * `diaRelativo`, solo para el cliente.
 */
export function diaCercano(dia: string, ahora: Date): "hoy" | "ayer" | "mañana" | null {
  const DIA = 24 * 60 * 60 * 1000;
  if (dia === diaEnMadrid(ahora)) return "hoy";
  if (dia === diaEnMadrid(new Date(ahora.getTime() - DIA))) return "ayer";
  if (dia === diaEnMadrid(new Date(ahora.getTime() + DIA))) return "mañana";
  return null;
}

/** «06:10». */
export function hora(instante: string): string {
  return HORA.format(new Date(instante));
}

/** «domingo, 28 de septiembre». */
export function fechaDeEdicion(instante: string): string {
  return EDICION.format(new Date(instante));
}

/** `2026-09-28`, el día en Madrid: sirve para comparar días sin líos de zona. */
export function diaEnMadrid(instante: string | Date): string {
  return CLAVE_DIA.format(typeof instante === "string" ? new Date(instante) : instante);
}

/**
 * «hoy», «ayer» o `null` si es otro día. Solo para el cliente: en el servidor
 * no se sabe cuándo se leerá el HTML.
 */
export function diaRelativo(instante: string, ahora: Date): "hoy" | "ayer" | null {
  const dia = diaEnMadrid(instante);
  if (dia === diaEnMadrid(ahora)) return "hoy";
  const ayer = new Date(ahora.getTime() - 24 * 60 * 60 * 1000);
  return dia === diaEnMadrid(ayer) ? "ayer" : null;
}
