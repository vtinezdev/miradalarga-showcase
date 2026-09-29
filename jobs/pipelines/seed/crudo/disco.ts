/**
 * El crudo en disco: leerlo entero para verificarlo y escribirlo **inmutable**.
 *
 * Solo `node:fs`. Ni red ni base de datos: la verificación y la carga leen de
 * aquí con 0 requests (ADR 0009 §4).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { esRutaSegura } from "./huella.ts";

/** Todos los ficheros del crudo: ruta relativa con `/` → bytes exactos. */
export type ContenidoDelCrudo = ReadonlyMap<string, Uint8Array>;

/**
 * Lee **todo** lo que hay bajo `directorio`, sin filtrar nada: un fichero que
 * sobre tiene que verse para que la verificación lo rechace.
 */
export function leerDirectorioDelCrudo(directorio: string): ContenidoDelCrudo {
  if (!existsSync(directorio) || !statSync(directorio).isDirectory()) {
    throw new Error(`No existe el directorio del crudo: ${directorio}`);
  }
  const contenido = new Map<string, Uint8Array>();
  const recorrer = (relativo: string): void => {
    const absoluto = relativo === "" ? directorio : join(directorio, relativo);
    for (const nombre of readdirSync(absoluto).sort()) {
      const ruta = relativo === "" ? nombre : `${relativo}/${nombre}`;
      const stat = statSync(join(directorio, ruta));
      if (stat.isDirectory()) recorrer(ruta);
      else contenido.set(ruta, new Uint8Array(readFileSync(join(directorio, ruta))));
    }
  };
  recorrer("");
  return contenido;
}

/** Dónde escribe la captura cada fichero, en cuanto lo tiene. */
export interface SumideroDelCrudo {
  escribir(ruta: string, bytes: Uint8Array): void;
}

/**
 * Escribe en disco **sin sobrescribir nunca**: fichero temporal y `rename`, de
 * modo que un fichero existe entero o no existe. Un crudo cerrado es inmutable,
 * y un segundo intento de escribir la misma ruta es un error, no una
 * actualización.
 */
export function crearSumideroEnDisco(directorio: string): SumideroDelCrudo {
  return {
    escribir(ruta, bytes) {
      if (!esRutaSegura(ruta)) throw new Error(`Ruta insegura en el crudo: ${ruta}`);
      const destino = join(directorio, ruta);
      if (existsSync(destino)) {
        throw new Error(`El crudo es inmutable: ${ruta} ya existe.`);
      }
      mkdirSync(dirname(destino), { recursive: true });
      const temporal = `${destino}.tmp-${String(process.pid)}`;
      writeFileSync(temporal, bytes, { flag: "wx" });
      renameSync(temporal, destino);
    },
  };
}

/** Un sumidero en memoria, para ensayos y tests. */
export function crearSumideroEnMemoria(): SumideroDelCrudo & {
  readonly contenido: Map<string, Uint8Array>;
} {
  const contenido = new Map<string, Uint8Array>();
  return {
    contenido,
    escribir(ruta, bytes) {
      if (!esRutaSegura(ruta)) throw new Error(`Ruta insegura en el crudo: ${ruta}`);
      if (contenido.has(ruta))
        throw new Error(`El crudo es inmutable: ${ruta} ya existe.`);
      contenido.set(ruta, bytes);
    },
  };
}

/** Vuelca un crudo entero a un directorio nuevo. */
export function escribirCrudo(directorio: string, contenido: ContenidoDelCrudo): void {
  const sumidero = crearSumideroEnDisco(directorio);
  for (const [ruta, bytes] of contenido) sumidero.escribir(ruta, bytes);
}
