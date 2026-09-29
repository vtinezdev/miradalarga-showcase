/**
 * Reglas de la búsqueda por título (SCREENS.md §6), sin origen de datos: las
 * usa el adaptador de desarrollo para buscar y la interfaz para resaltar. El
 * adaptador de Neon hace lo mismo en SQL (`translate` + `LIKE`, sin extensiones:
 * `src/db/queries/catalogo-sql.ts`); lo que no puede cambiar es el criterio: sin
 * mayúsculas ni tildes, y todas las palabras.
 */

/** Límite de longitud de la consulta: lo que pasa de aquí no es un título. */
export const LONGITUD_MAXIMA = 100;
/** Con menos, cualquier título coincide y el resultado no ayuda. */
export const LONGITUD_MINIMA = 2;

/** Un carácter a su forma de comparación: sin tildes ni diacríticos, en minúscula. */
function base(caracter: string): string {
  return caracter.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("es-ES");
}

/** «Norte Magnético» → «norte magnetico». Colapsa los espacios. */
export function normalizar(texto: string): string {
  return [...texto].map(base).join("").replace(/\s+/g, " ").trim();
}

/** La consulta tal y como llega de la URL, recortada y sin espacios de sobra. */
export function limpiarConsulta(crudo: string | string[] | undefined): string {
  const texto = Array.isArray(crudo) ? (crudo[0] ?? "") : (crudo ?? "");
  return texto.replace(/\s+/g, " ").trim().slice(0, LONGITUD_MAXIMA);
}

export function palabras(consulta: string): string[] {
  return normalizar(consulta).split(" ").filter(Boolean);
}

/**
 * Puntuación de un texto frente a la consulta, o `null` si no coincide (falta
 * alguna palabra). Menor es mejor: 0 exacto, 1 empieza por la consulta, 2 una
 * palabra del título empieza por la primera de la consulta, 3 el resto.
 */
export function puntuar(texto: string, consulta: string): number | null {
  const t = normalizar(texto);
  const q = normalizar(consulta);
  const ps = palabras(consulta);
  if (ps.length === 0 || !ps.every((p) => t.includes(p))) return null;
  if (t === q) return 0;
  if (t.startsWith(q)) return 1;
  if (t.split(" ").some((w) => w.startsWith(ps[0]!))) return 2;
  return 3;
}

export interface Tramo {
  texto: string;
  resaltado: boolean;
}

/**
 * Parte un título en tramos, marcando la primera aparición de cada palabra de
 * la consulta. Trabaja sobre el texto original (con sus tildes): el índice de
 * cada carácter normalizado apunta a su carácter de origen.
 */
export function resaltar(titulo: string, consulta: string): Tramo[] {
  const caracteres = [...titulo];
  let plano = "";
  const origen: number[] = [];
  caracteres.forEach((c, i) => {
    const b = base(c);
    plano += b;
    // Una entrada por unidad UTF-16, que es lo que cuenta `indexOf`.
    origen.push(...new Array<number>(b.length).fill(i));
  });

  const marcados = new Array<boolean>(caracteres.length).fill(false);
  for (const p of palabras(consulta)) {
    const inicio = plano.indexOf(p);
    if (inicio === -1) continue;
    for (let k = inicio; k < inicio + p.length; k++) marcados[origen[k]!] = true;
  }

  const tramos: Tramo[] = [];
  caracteres.forEach((c, i) => {
    const ultimo = tramos.at(-1);
    if (ultimo && ultimo.resaltado === marcados[i]) ultimo.texto += c;
    else tramos.push({ texto: c, resaltado: marcados[i]! });
  });
  return tramos;
}
