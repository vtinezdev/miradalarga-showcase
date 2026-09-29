import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  ATRIBUTO,
  almacenDelNavegador,
  guardarSeleccion,
  leerSeleccion,
  normalizar,
} from "./almacen.ts";

/**
 * Estado de cliente de Mis plataformas, sin contexto ni librería de estado.
 *
 * La fuente única en la página es el atributo `data-mis-plataformas` de
 * `<html>`: lo escribe el script de `<head>` antes del primer pintado, lo
 * escribe `guardar()` y lo reescribe un cambio hecho en otra pestaña. Los
 * componentes se suscriben con `useSyncExternalStore`; en el servidor la
 * selección es siempre vacía, así que **el HTML servido nunca depende de ella**
 * (Plan §5: nada de personalizar el SSR).
 */

const EVENTO = "ml:mis-plataformas";

function leerAtributo(): string {
  return document.documentElement.getAttribute(ATRIBUTO) ?? "";
}

function escribirAtributo(ids: readonly string[]): void {
  const raiz = document.documentElement;
  if (ids.length > 0) raiz.setAttribute(ATRIBUTO, ids.join(" "));
  else raiz.removeAttribute(ATRIBUTO);
  window.dispatchEvent(new Event(EVENTO));
}

const servidor = () => "";

/**
 * Avisa solo de los cambios **hechos por alguien** (en esta pestaña o en otra),
 * nunca de la lectura inicial al hidratar. Sirve para animar la consecuencia de
 * marcar una plataforma sin animar la página al cargar.
 */
export function alCambiarMisPlataformas(avisar: () => void): () => void {
  window.addEventListener(EVENTO, avisar);
  return () => window.removeEventListener(EVENTO, avisar);
}

export interface MisPlataformas {
  /** Ids seleccionados; vacío en el servidor y hasta hidratar. */
  seleccion: readonly string[];
  /** Guarda y difunde. Devuelve `false` si el navegador no deja persistir. */
  guardar: (ids: readonly string[]) => boolean;
}

export function useMisPlataformas(validos: readonly string[]): MisPlataformas {
  const clave = validos.join(" ");
  const conjunto = useMemo(() => new Set(clave.split(" ").filter(Boolean)), [clave]);

  const suscribir = useCallback(
    (avisar: () => void) => {
      const alCambiarEnOtraPestana = (evento: StorageEvent) => {
        if (evento.storageArea !== window.localStorage) return;
        escribirAtributo(leerSeleccion(almacenDelNavegador(), conjunto));
      };
      window.addEventListener(EVENTO, avisar);
      window.addEventListener("storage", alCambiarEnOtraPestana);
      return () => {
        window.removeEventListener(EVENTO, avisar);
        window.removeEventListener("storage", alCambiarEnOtraPestana);
      };
    },
    [conjunto],
  );

  const crudo = useSyncExternalStore(suscribir, leerAtributo, servidor);
  const seleccion = useMemo(
    () => normalizar(crudo.split(" "), conjunto),
    [crudo, conjunto],
  );

  const guardar = useCallback(
    (ids: readonly string[]) => {
      const limpios = normalizar(ids, conjunto);
      const persistido = guardarSeleccion(almacenDelNavegador(), limpios, conjunto);
      // Aunque no se pueda persistir, la selección vale para esta visita.
      escribirAtributo(limpios);
      return persistido;
    },
    [conjunto],
  );

  return { seleccion, guardar };
}
