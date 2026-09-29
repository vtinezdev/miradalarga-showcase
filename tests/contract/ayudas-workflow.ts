/**
 * Lectura estructural de un workflow de `.github/workflows/`, **sin
 * ejecutarlo** y sin parser de YAML: no hay uno en el proyecto y no se añade
 * para esto. Las comprobaciones van por bloques y por sangría sobre el texto
 * **sin comentarios**, que pueden nombrar lo que el código prohíbe sin que eso
 * sea un uso.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const RAIZ = join(import.meta.dirname, "..", "..");

export interface Paso {
  readonly nombre: string;
  readonly texto: string;
}

/** `clave: valor` de una línea cualquiera, con la sangría que tenga. */
export const valorDe = (texto: string, clave: string): string | undefined =>
  new RegExp(`^\\s*${clave}:\\s*(.+)$`, "m").exec(texto)?.[1]?.trim();

export function leerWorkflow(fichero: string) {
  const CRUDO = readFileSync(join(RAIZ, ".github", "workflows", fichero), "utf8");

  /** El YAML sin comentarios de línea ni de cola. Ningún valor lleva `#`. */
  const CODIGO = CRUDO.split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/\s+#.*$/, ""))
    .filter((l) => l.trim() !== "")
    .join("\n");

  const LINEAS = CODIGO.split("\n");

  /** Las líneas de un bloque de primer nivel (`on:`, `concurrency:`…), sin la cabecera. */
  function bloque(clave: string): string[] {
    const inicio = LINEAS.findIndex((l) => l === `${clave}:`);
    if (inicio === -1) return [];
    const fin = LINEAS.findIndex((l, i) => i > inicio && /^\S/.test(l));
    return LINEAS.slice(inicio + 1, fin === -1 ? undefined : fin);
  }

  /** Los pasos del job, cada uno con su texto completo. */
  const PASOS: readonly Paso[] = CODIGO.split(/\n(?= {6}- name: )/)
    .slice(1)
    .map((t) => ({ nombre: /- name: (.*)/.exec(t)?.[1]?.trim() ?? "?", texto: t }));

  const paso = (fragmento: string): Paso | undefined =>
    PASOS.find((p) => p.texto.includes(fragmento));

  return { CRUDO, CODIGO, LINEAS, bloque, PASOS, paso };
}
