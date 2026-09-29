/**
 * **Las copias del crudo** (ADR 0009 §4, «Almacenamiento»): al menos **dos
 * copias verificadas por huella**, **una fuera del equipo que capturó**, antes
 * de cargar validación.
 *
 *   · `archivarCrudo` copia el directorio del crudo —solo el crudo: ni el diario
 *     ni nada de fuera— a un destino **vacío**, vuelve a leer la copia y la
 *     pasa por `seed:verificar`: la copia vale si y solo si su huella es la del
 *     original y verifica entera. Después la anota en el recibo.
 *   · **El recibo** vive al lado del crudo, fuera de él
 *     (`<capturaId>.copias.json`): qué copia, dónde, cuándo, con qué huella y si
 *     se declaró fuera del equipo. No lleva secretos.
 *   · `comprobarCopias` es lo que exige la carga: el original verifica, hay al
 *     menos una copia con la misma huella, y al menos una declarada fuera del
 *     equipo. Las copias accesibles se **vuelven a verificar**; una copia
 *     inaccesible solo cuenta por lo que se verificó al hacerla.
 *
 * ⚠️ «Fuera del equipo» lo **declara** quien archiva (`--fuera-del-equipo`): el
 * código no puede saber si una ruta montada es un disco externo o una carpeta
 * sincronizada. Lo que sí garantiza es que el destino no es el original y que
 * lo que hay allí es byte a byte el mismo crudo.
 *
 * Solo `node:fs`. Ni red ni base de datos.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { escribirCrudo, leerDirectorioDelCrudo } from "./disco.ts";
import { verificarCrudo } from "./verificar.ts";

export interface CopiaRegistrada {
  readonly destino: string;
  readonly fueraDelEquipo: boolean;
  readonly huella: string;
  readonly verificadaEl: string;
}

export interface ReciboDeCopias {
  readonly formato: "mirada-larga.seed.copias";
  readonly v: 1;
  readonly capturaId: string;
  readonly huella: string;
  readonly copias: readonly CopiaRegistrada[];
}

/** `.seed-runs/<capturaId>.copias.json`, al lado del crudo. */
export function rutaDelRecibo(directorioDelCrudo: string): string {
  const d = resolve(directorioDelCrudo);
  return join(dirname(d), `${basename(d)}.copias.json`);
}

export function leerRecibo(directorioDelCrudo: string): ReciboDeCopias | null {
  const ruta = rutaDelRecibo(directorioDelCrudo);
  if (!existsSync(ruta)) return null;
  const r = JSON.parse(readFileSync(ruta, "utf8")) as ReciboDeCopias;
  if (r.formato !== "mirada-larga.seed.copias" || r.v !== 1) {
    throw new Error(`Recibo de copias con formato desconocido: ${ruta}`);
  }
  return r;
}

/**
 * Cómo se verifica un directorio archivable: su huella y su identificador, o
 * lanza. Por defecto, el crudo de una captura; M1 trae el suyo
 * (`scripts/seed-archivar.ts`), porque su verificación necesita las
 * referencias del Spike.
 */
export type VerificarDirectorio = (directorio: string) => {
  readonly huella: string;
  readonly capturaId: string;
};

export function huellaVerificada(directorio: string): {
  huella: string;
  capturaId: string;
} {
  const v = verificarCrudo(leerDirectorioDelCrudo(directorio));
  if (!v.ok || v.huellaDelCrudo === null || v.resumen === null) {
    throw new Error(
      `El crudo de ${directorio} no verifica: ${v.problemas
        .slice(0, 3)
        .map((p) => p.codigo)
        .join(", ")}`,
    );
  }
  return { huella: v.huellaDelCrudo, capturaId: v.resumen.capturaId };
}

export function archivarCrudo(
  origen: string,
  destino: string,
  opciones: {
    readonly fueraDelEquipo: boolean;
    readonly ahora?: Date;
    readonly verificar?: VerificarDirectorio;
  },
): CopiaRegistrada {
  const verificar = opciones.verificar ?? huellaVerificada;
  const o = resolve(origen);
  const d = resolve(destino);
  if (o === d || d.startsWith(`${o}/`) || d.startsWith(`${o}\\`)) {
    throw new Error("La copia no puede ser el original ni estar dentro de él.");
  }
  if (existsSync(d) && readdirSync(d).length > 0) {
    throw new Error(`El destino de la copia no está vacío: ${d}`);
  }
  const original = verificar(o);
  escribirCrudo(d, leerDirectorioDelCrudo(o));
  const copia = verificar(d);
  if (copia.huella !== original.huella) {
    throw new Error("La copia no tiene la huella del original.");
  }
  const registrada: CopiaRegistrada = {
    destino: d,
    fueraDelEquipo: opciones.fueraDelEquipo,
    huella: copia.huella,
    verificadaEl: (opciones.ahora ?? new Date()).toISOString(),
  };
  const previo = leerRecibo(o);
  const recibo: ReciboDeCopias = {
    formato: "mirada-larga.seed.copias",
    v: 1,
    capturaId: original.capturaId,
    huella: original.huella,
    copias: [...(previo?.copias ?? []), registrada],
  };
  writeFileSync(rutaDelRecibo(o), `${JSON.stringify(recibo, null, 2)}\n`, "utf8");
  return registrada;
}

export interface EstadoDeCopias {
  readonly ok: boolean;
  readonly huella: string;
  readonly copiasValidas: number;
  readonly fueraDelEquipo: number;
  readonly problemas: readonly string[];
}

/**
 * **Lo que exige la carga de un crudo real**: original + al menos una copia con
 * su huella (dos copias en total), y al menos una declarada fuera del equipo.
 */
export function comprobarCopias(
  origen: string,
  verificar: VerificarDirectorio = huellaVerificada,
): EstadoDeCopias {
  const { huella } = verificar(resolve(origen));
  const recibo = leerRecibo(origen);
  const problemas: string[] = [];
  let validas = 0;
  let fuera = 0;
  if (recibo === null) problemas.push("no hay recibo de copias");
  else if (recibo.huella !== huella) problemas.push("el recibo es de otra huella");
  for (const c of recibo?.huella === huella ? recibo.copias : []) {
    if (c.huella !== huella) {
      problemas.push(`${c.destino}: otra huella`);
      continue;
    }
    if (existsSync(c.destino)) {
      try {
        if (verificar(c.destino).huella !== huella) {
          problemas.push(`${c.destino}: ya no tiene la huella del original`);
          continue;
        }
      } catch (error) {
        problemas.push(
          `${c.destino}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
    }
    validas++;
    if (c.fueraDelEquipo) fuera++;
  }
  if (validas < 1)
    problemas.push("hace falta al menos una copia verificada además del original");
  if (fuera < 1)
    problemas.push("hace falta al menos una copia fuera del equipo que capturó");
  return {
    ok: problemas.length === 0,
    huella,
    copiasValidas: validas,
    fueraDelEquipo: fuera,
    problemas,
  };
}
