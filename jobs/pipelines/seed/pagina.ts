/**
 * **Leer una página de `search/filters`** tal y como quedó en el crudo: la
 * misma regla en la captura, la reanudación y la sonda.
 *
 * Válida = HTTP 2xx, JSON UTF-8, envoltorio `{shows, hasMore?, nextCursor?}` y
 * **todos** los shows dentro del schema del proveedor. Un solo show fuera de
 * contrato invalida la página (ADR 0009 §1, enmienda del 2026-09-27); un
 * `imdbId` ausente o vacío no, se cuenta después como `sin_identidad`.
 */
import { paginaCrudaV1 } from "./crudo/formato.ts";
import type { ShowInvalido } from "./seleccion.ts";
import { validarShows } from "./seleccion.ts";

const decodificador = new TextDecoder("utf-8", { fatal: true });

export interface PaginaLeida {
  readonly shows: readonly unknown[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

export type LecturaDePagina =
  | { readonly valida: true; readonly pagina: PaginaLeida }
  | {
      readonly valida: false;
      readonly causa: "http" | "cuerpo_ilegible" | "envoltorio" | "show";
      readonly showInvalido: ShowInvalido | null;
    };

export function leerPagina(status: number, cuerpo: Uint8Array): LecturaDePagina {
  if (status < 200 || status > 299) {
    return { valida: false, causa: "http", showInvalido: null };
  }
  let json: unknown;
  try {
    json = JSON.parse(decodificador.decode(cuerpo));
  } catch {
    return { valida: false, causa: "cuerpo_ilegible", showInvalido: null };
  }
  const envoltorio = paginaCrudaV1.safeParse(json);
  if (!envoltorio.success) {
    return { valida: false, causa: "envoltorio", showInvalido: null };
  }
  const showInvalido = validarShows(envoltorio.data.shows);
  if (showInvalido !== null) return { valida: false, causa: "show", showInvalido };
  return {
    valida: true,
    pagina: {
      shows: envoltorio.data.shows,
      hasMore: envoltorio.data.hasMore ?? false,
      nextCursor: envoltorio.data.nextCursor ?? null,
    },
  };
}
