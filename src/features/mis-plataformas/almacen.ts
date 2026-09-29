/**
 * Persistencia de Mis plataformas (INFORMATION-ARCHITECTURE.md §6).
 *
 * `localStorage`, clave `ml.plataformas`, valor JSON versionado:
 * `{ "v": 1, "ids": ["netflix", "max"], "actualizado": "…" }`. Los `ids` son
 * los de `external_platforms`, nunca nombres (ADR 0005).
 *
 * Funciones puras sobre un `Storage` inyectado: se prueban sin navegador, y un
 * `localStorage` inaccesible (modo privado estricto, cuota) nunca rompe la
 * página, solo deja de persistir.
 */

export const CLAVE = "ml.plataformas";
export const VERSION = 1;
/** Atributo de `<html>` que lee el CSS para resaltar sin JavaScript de React. */
export const ATRIBUTO = "data-mis-plataformas";

interface Guardado {
  v: typeof VERSION;
  ids: string[];
  actualizado: string;
}

type Almacen = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * Lee la selección. Descarta en silencio versiones desconocidas, basura e
 * identificadores que no son plataformas válidas.
 */
export function leerSeleccion(
  almacen: Almacen | null,
  validos: ReadonlySet<string>,
): string[] {
  if (!almacen) return [];
  let crudo: string | null;
  try {
    crudo = almacen.getItem(CLAVE);
  } catch {
    return [];
  }
  if (!crudo) return [];
  try {
    const dato: unknown = JSON.parse(crudo);
    if (!esGuardado(dato)) return [];
    return normalizar(dato.ids, validos);
  } catch {
    return [];
  }
}

/** Guarda la selección. Devuelve `false` si el navegador no deja guardar. */
export function guardarSeleccion(
  almacen: Almacen | null,
  ids: readonly string[],
  validos: ReadonlySet<string>,
  ahora: Date = new Date(),
): boolean {
  if (!almacen) return false;
  const limpios = normalizar(ids, validos);
  try {
    if (limpios.length === 0) {
      almacen.removeItem(CLAVE);
    } else {
      const dato: Guardado = {
        v: VERSION,
        ids: limpios,
        actualizado: ahora.toISOString(),
      };
      almacen.setItem(CLAVE, JSON.stringify(dato));
    }
    return true;
  } catch {
    return false;
  }
}

/** Sin duplicados, solo válidos, en el orden de `validos` (estable y predecible). */
export function normalizar(
  ids: readonly unknown[],
  validos: ReadonlySet<string>,
): string[] {
  const elegidos = new Set(
    ids.filter((id): id is string => typeof id === "string" && validos.has(id)),
  );
  return [...validos].filter((id) => elegidos.has(id));
}

function esGuardado(dato: unknown): dato is Guardado {
  return (
    typeof dato === "object" &&
    dato !== null &&
    (dato as { v?: unknown }).v === VERSION &&
    Array.isArray((dato as { ids?: unknown }).ids)
  );
}

/** Acceso defensivo: en algunos navegadores leer `localStorage` ya lanza. */
export function almacenDelNavegador(): Almacen | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Script que corre en `<head>` **antes del primer pintado**: copia la selección
 * al atributo de `<html>` para que el resaltado sea solo CSS, sin parpadeo ni
 * salto de maquetación (react-best-practices: `rendering-hydration-no-flicker`).
 *
 * Es texto, no una función serializada: no depende de nada del bundle.
 */
export function scriptInicial(validos: readonly string[]): string {
  return `(function(){try{var v=${JSON.stringify(validos)};var d=JSON.parse(localStorage.getItem(${JSON.stringify(
    CLAVE,
  )})||"null");if(!d||d.v!==${VERSION}||!Array.isArray(d.ids))return;var s=v.filter(function(i){return d.ids.indexOf(i)!==-1});if(s.length)document.documentElement.setAttribute(${JSON.stringify(
    ATRIBUTO,
  )},s.join(" "))}catch(e){}})();`;
}
