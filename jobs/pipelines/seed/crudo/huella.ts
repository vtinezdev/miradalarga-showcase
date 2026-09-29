/**
 * Huellas del crudo: sha256 de cada fichero, el fichero `SHA256SUMS` y la
 * **huella del crudo**, que es el sha256 de ese fichero (ADR 0009 §4).
 *
 * `SHA256SUMS` sigue el formato de `sha256sum` de GNU —`<hash>  <ruta>`, dos
 * espacios—, **ordenado por ruta** y con salto de línea final. Así se puede
 * comprobar a mano, fuera de este código, con `sha256sum -c SHA256SUMS`.
 *
 * Funciones puras sobre bytes. Nada de disco, red ni base de datos.
 */
import { createHash } from "node:crypto";

/** sha256 en hexadecimal minúsculo. */
export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Una línea de `SHA256SUMS`. */
export interface SumaDeFichero {
  readonly ruta: string;
  readonly sha256: string;
}

/**
 * Una ruta relativa segura dentro del crudo: sin `..`, sin raíz, sin barra
 * invertida y sin segmentos vacíos. Un `SHA256SUMS` que apuntara fuera del
 * directorio haría verificar ficheros que no son del crudo.
 */
export function esRutaSegura(ruta: string): boolean {
  if (ruta === "" || ruta.startsWith("/") || ruta.includes("\\")) return false;
  return ruta.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

/** Compara por código de unidad: el orden de `sort()` sin locale, estable entre máquinas. */
const porRuta = (a: SumaDeFichero, b: SumaDeFichero): number =>
  a.ruta < b.ruta ? -1 : a.ruta > b.ruta ? 1 : 0;

/** El contenido exacto de `SHA256SUMS` para esas sumas. */
export function construirSumas(sumas: readonly SumaDeFichero[]): string {
  return [...sumas]
    .sort(porRuta)
    .map((s) => `${s.sha256}  ${s.ruta}\n`)
    .join("");
}

export type SumasLeidas =
  | { readonly ok: true; readonly sumas: readonly SumaDeFichero[] }
  | { readonly ok: false; readonly problema: string };

const LINEA = /^([0-9a-f]{64}) {2}(\S(?:.*\S)?)$/;

/**
 * Lee `SHA256SUMS` **estrictamente**: una línea por fichero, ordenadas, sin
 * repetidas, rutas seguras y salto de línea final. Un fichero reescrito a mano
 * con otro orden cambia la huella del crudo, así que se rechaza en vez de
 * normalizarlo.
 */
export function leerSumas(texto: string): SumasLeidas {
  if (texto === "" || !texto.endsWith("\n")) {
    return { ok: false, problema: "vacío o sin salto de línea final" };
  }
  const sumas: SumaDeFichero[] = [];
  const lineas = texto.slice(0, -1).split("\n");
  for (const [i, linea] of lineas.entries()) {
    const m = LINEA.exec(linea);
    if (m === null) {
      return { ok: false, problema: `línea ${String(i + 1)} con formato inválido` };
    }
    const ruta = m[2] ?? "";
    if (!esRutaSegura(ruta)) {
      return { ok: false, problema: `línea ${String(i + 1)}: ruta insegura "${ruta}"` };
    }
    sumas.push({ sha256: m[1] ?? "", ruta });
  }
  if (new Set(sumas.map((s) => s.ruta)).size !== sumas.length) {
    return { ok: false, problema: "rutas repetidas" };
  }
  if (construirSumas(sumas) !== texto) {
    return { ok: false, problema: "no está ordenado por ruta" };
  }
  return { ok: true, sumas };
}

/** **La huella del crudo**: su identidad en todo lo demás. */
export function huellaDelCrudo(textoDeSumas: string): string {
  return sha256(textoDeSumas);
}

/**
 * JSON con las claves de cada objeto **ordenadas**, sin espacios. Para las
 * huellas calculadas —la del catálogo—, donde el orden de inserción de las
 * claves no puede cambiar el resultado. `undefined` se omite como en
 * `JSON.stringify`.
 */
export function jsonCanonico(valor: unknown): string {
  if (valor === null || typeof valor !== "object")
    return JSON.stringify(valor) ?? "null";
  if (valor instanceof Date) return JSON.stringify(valor.toISOString());
  if (Array.isArray(valor)) return `[${valor.map(jsonCanonico).join(",")}]`;
  const objeto = valor as Record<string, unknown>;
  const claves = Object.keys(objeto)
    .filter((k) => objeto[k] !== undefined)
    .sort();
  return `{${claves.map((k) => `${JSON.stringify(k)}:${jsonCanonico(objeto[k])}`).join(",")}}`;
}

/** Cómo se escriben `plan.json` y `manifiesto.json`: legible y con salto final. */
export function jsonDeFichero(valor: unknown): string {
  return `${JSON.stringify(valor, null, 2)}\n`;
}
