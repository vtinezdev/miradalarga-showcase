/**
 * Traducción de los avisos de `/changes` al modelo canónico.
 *
 * Funciones puras: sin red, sin reloj, sin base de datos. Lo que no se sabe se
 * devuelve como `null`, nunca como un valor por defecto inventado (CLAUDE.md,
 * regla 7).
 *
 * ⚠️ **Aquí no se decide nada sobre el histórico.** Un aviso dice qué oferta
 * hay que volver a mirar; el `event_type` lo decide la comparación de estados
 * del pipeline, nunca esta traducción.
 */
import type { AvisoCanonico, TituloCanonico } from "../contracts.ts";
import { normalizarShow } from "./normalizar.ts";
import type { CambioProveedor, RespuestaCambiosProveedor } from "./schema.ts";

/** Una página de `/changes` ya traducida: avisos + los títulos que los acompañan. */
export interface PaginaDeCambios {
  readonly avisos: readonly AvisoCanonico[];
  /** `idProveedor` → título completo. 📏 Cubre el 100 % de los avisos. */
  readonly titulos: ReadonlyMap<string, TituloCanonico>;
  /**
   * `idProveedor` de los shows que llegaron **sin identidad utilizable**
   * (`normalizarImdbId`). No están en `titulos`, así que sus avisos quedan sin
   * show, como si el proveedor no lo hubiera mandado; esto solo dice por qué.
   */
  readonly showsSinIdentidad: ReadonlySet<string>;
  readonly hayMas: boolean;
  readonly cursorSiguiente: string | null;
}

export function normalizarCambio(cambio: CambioProveedor): AvisoCanonico {
  return {
    tipo: cambio.changeType,
    idProveedor: cambio.showId,
    tipoTitulo: cambio.showType === "series" ? "serie" : "pelicula",
    plataformaId: cambio.service.id,
    tipoOferta: cambio.streamingOptionType,
    // El `id`, nunca el `name`: dos addons distintos comparten nombre (ADR 0005).
    addon: cambio.addon?.id ?? null,
    enlace: cambio.link ?? null,
    instante: new Date(cambio.timestamp * 1000),
  };
}

/**
 * Traduce una respuesta entera.
 *
 * `normalizarShow` se reutiliza **sin modificar**: 📏 los 110 shows medidos en
 * `/changes` cumplen el mismo `showProveedor` que los de `shows/search/filters`.
 *
 * Un show sin identidad no entra en `titulos`: sus avisos quedan **sin show**,
 * la semántica que los cuatro pipelines ya comparten para un aviso que no se
 * puede atribuir a un título.
 */
export function normalizarPaginaDeCambios(
  respuesta: RespuestaCambiosProveedor,
  pais: string,
): PaginaDeCambios {
  const titulos = new Map<string, TituloCanonico>();
  const showsSinIdentidad = new Set<string>();
  for (const [showId, show] of Object.entries(respuesta.shows)) {
    const titulo = normalizarShow(show, pais);
    if (titulo === null) showsSinIdentidad.add(showId);
    else titulos.set(showId, titulo);
  }

  return {
    avisos: respuesta.changes.map(normalizarCambio),
    titulos,
    showsSinIdentidad,
    hayMas: respuesta.hasMore ?? false,
    cursorSiguiente: respuesta.nextCursor ?? null,
  };
}
