/**
 * **Dónde escribe la captura** (ADR 0009 §4, §5, §10): el crudo y su diario.
 *
 * ```
 * .seed-runs/<capturaId>/            EL CRUDO: lo único que se verifica, copia y carga
 *   plan.json · paginas/… · manifiesto.json · SHA256SUMS
 * .seed-runs/<capturaId>.diario/     el diario operativo, FUERA del crudo
 *   entradas/0001.json               la entrada de manifiesto de cada página, al llegar
 *   adopciones/0001.json             páginas adoptadas al reanudar (0 requests)
 *   retiradas/<runId>/…              páginas apartadas al reanudar: inválidas o huérfanas
 *   cierres/<runId>/…                el manifiesto y las sumas de un cierre anterior
 * ```
 *
 * ⚖️ **Nada se sobrescribe y nada se borra.** Cada fichero se escribe una vez
 * —temporal y `rename`: existe entero o no existe—. Reanudar no reescribe el
 * crudo: **aparta** al diario lo que ya no pertenece a él (una página inválida
 * que se vuelve a pedir, una página sin entrada, el cierre de una ejecución
 * cortada) y lo conserva como evidencia.
 *
 * ⚖️ **El diario no forma parte del crudo.** `seed:verificar` rechaza ficheros
 * de más; por eso vive al lado. Solo lo lee la reanudación: sin él, una captura
 * cortada **no se reanuda** (`crudo_incoherente`, 0 requests).
 *
 * Solo `node:fs`. Ni red ni base de datos.
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

export interface AlmacenDeCaptura {
  /** Escribe en el crudo. Una ruta existente es un error: el crudo es inmutable. */
  escribir(ruta: string, bytes: Uint8Array): void;
  leer(ruta: string): Uint8Array | null;
  /** Todas las rutas del crudo, ordenadas. */
  listar(): readonly string[];
  /** Mueve un fichero del crudo al diario. **Nunca borra.** */
  apartar(ruta: string, destinoEnDiario: string): void;
  escribirDiario(ruta: string, bytes: Uint8Array): void;
  /** Mueve un fichero dentro del diario. **Nunca borra.** */
  moverEnDiario(origen: string, destino: string): void;
  leerDiario(ruta: string): Uint8Array | null;
  /** Rutas del diario bajo `prefijo`, ordenadas. */
  listarDiario(prefijo: string): readonly string[];
}

function exigirSegura(ruta: string): void {
  if (!esRutaSegura(ruta)) throw new Error(`Ruta insegura: ${ruta}`);
}

function listarRecursivo(raiz: string): string[] {
  if (!existsSync(raiz)) return [];
  const salida: string[] = [];
  const recorrer = (relativo: string): void => {
    const absoluto = relativo === "" ? raiz : join(raiz, relativo);
    for (const nombre of readdirSync(absoluto).sort()) {
      const ruta = relativo === "" ? nombre : `${relativo}/${nombre}`;
      if (statSync(join(raiz, ruta)).isDirectory()) recorrer(ruta);
      else salida.push(ruta);
    }
  };
  recorrer("");
  return salida.sort();
}

function escribirUnaVez(destino: string, bytes: Uint8Array, ruta: string): void {
  if (existsSync(destino)) throw new Error(`Inmutable: ${ruta} ya existe.`);
  mkdirSync(dirname(destino), { recursive: true });
  const temporal = `${destino}.tmp-${String(process.pid)}`;
  writeFileSync(temporal, bytes, { flag: "wx" });
  renameSync(temporal, destino);
}

/** El diario de un crudo en disco: el directorio hermano `<crudo>.diario`. */
export function directorioDelDiario(directorioDelCrudo: string): string {
  return `${directorioDelCrudo.replace(/[\\/]+$/, "")}.diario`;
}

export function crearAlmacenEnDisco(directorio: string): AlmacenDeCaptura {
  const diario = directorioDelDiario(directorio);
  return {
    escribir(ruta, bytes) {
      exigirSegura(ruta);
      escribirUnaVez(join(directorio, ruta), bytes, ruta);
    },
    leer(ruta) {
      exigirSegura(ruta);
      const f = join(directorio, ruta);
      return existsSync(f) ? new Uint8Array(readFileSync(f)) : null;
    },
    // Sin filtrar los temporales: uno que sobrevive a una caída tiene que verse
    // para que la reanudación lo aparte; si no, el crudo final no verificaría.
    listar: () => listarRecursivo(directorio),
    apartar(ruta, destinoEnDiario) {
      exigirSegura(ruta);
      exigirSegura(destinoEnDiario);
      const origen = join(directorio, ruta);
      const destino = join(diario, destinoEnDiario);
      if (!existsSync(origen)) throw new Error(`No existe en el crudo: ${ruta}`);
      if (existsSync(destino))
        throw new Error(`Ya existe en el diario: ${destinoEnDiario}`);
      mkdirSync(dirname(destino), { recursive: true });
      renameSync(origen, destino);
    },
    escribirDiario(ruta, bytes) {
      exigirSegura(ruta);
      escribirUnaVez(join(diario, ruta), bytes, ruta);
    },
    moverEnDiario(origen, destino) {
      exigirSegura(origen);
      exigirSegura(destino);
      const de = join(diario, origen);
      const a = join(diario, destino);
      if (!existsSync(de)) throw new Error(`No existe en el diario: ${origen}`);
      if (existsSync(a)) throw new Error(`Ya existe en el diario: ${destino}`);
      mkdirSync(dirname(a), { recursive: true });
      renameSync(de, a);
    },
    leerDiario(ruta) {
      exigirSegura(ruta);
      const f = join(diario, ruta);
      return existsSync(f) ? new Uint8Array(readFileSync(f)) : null;
    },
    listarDiario: (prefijo) =>
      listarRecursivo(diario).filter(
        (r) => r.startsWith(prefijo) && !r.includes(".tmp-"),
      ),
  };
}

/** En memoria, para tests y ensayos. `contenido` es el crudo; `diario`, lo demás. */
export function crearAlmacenEnMemoria(
  inicial: {
    readonly contenido?: ReadonlyMap<string, Uint8Array>;
    readonly diario?: ReadonlyMap<string, Uint8Array>;
  } = {},
): AlmacenDeCaptura & {
  readonly contenido: Map<string, Uint8Array>;
  readonly diario: Map<string, Uint8Array>;
} {
  const contenido = new Map(inicial.contenido ?? []);
  const diario = new Map(inicial.diario ?? []);
  const ordenadas = (m: Map<string, Uint8Array>) => [...m.keys()].sort();
  return {
    contenido,
    diario,
    escribir(ruta, bytes) {
      exigirSegura(ruta);
      if (contenido.has(ruta)) throw new Error(`Inmutable: ${ruta} ya existe.`);
      contenido.set(ruta, bytes);
    },
    leer: (ruta) => contenido.get(ruta) ?? null,
    listar: () => ordenadas(contenido),
    apartar(ruta, destinoEnDiario) {
      exigirSegura(destinoEnDiario);
      const bytes = contenido.get(ruta);
      if (bytes === undefined) throw new Error(`No existe en el crudo: ${ruta}`);
      if (diario.has(destinoEnDiario)) {
        throw new Error(`Ya existe en el diario: ${destinoEnDiario}`);
      }
      diario.set(destinoEnDiario, bytes);
      contenido.delete(ruta);
    },
    escribirDiario(ruta, bytes) {
      exigirSegura(ruta);
      if (diario.has(ruta)) throw new Error(`Inmutable: ${ruta} ya existe.`);
      diario.set(ruta, bytes);
    },
    moverEnDiario(origen, destino) {
      exigirSegura(destino);
      const bytes = diario.get(origen);
      if (bytes === undefined) throw new Error(`No existe en el diario: ${origen}`);
      if (diario.has(destino)) throw new Error(`Ya existe en el diario: ${destino}`);
      diario.set(destino, bytes);
      diario.delete(origen);
    },
    leerDiario: (ruta) => diario.get(ruta) ?? null,
    listarDiario: (prefijo) => ordenadas(diario).filter((r) => r.startsWith(prefijo)),
  };
}
