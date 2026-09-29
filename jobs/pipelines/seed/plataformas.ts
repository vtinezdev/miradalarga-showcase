/**
 * Las seis plataformas del MVP. **Referencia curada a mano, no ingerida.**
 *
 * Lleva decisiones nuestras que ninguna ingesta repone: el `id` propio, el slug
 * público y si está activa (`docs/DATA-MODEL.md`).
 *
 * 📏 **`max` es `hbo` en la fuente.** Separar nuestro `id` de `source_id`
 * convierte la trampa más cara del Spike 1 en una columna: el *join* de la
 * ingesta va siempre por `source_id`, y las URLs y el contenido editorial
 * hablan de `max`.
 *
 * ⚖️ Las otras cinco plataformas que existen en España —`mubi`, `curiosity`,
 * `plutotv`, `crunchyroll`, `zee5`— **están fuera del MVP por el ADR 0003**, y
 * por eso no aparecen aquí. Sus ofertas se descartan de forma explícita y
 * contada, nunca en silencio.
 */

export interface PlataformaCurada {
  readonly id: string;
  readonly nombre: string;
  readonly sourceId: string;
  readonly slugPublico: string;
  readonly activa: boolean;
}

export const FUENTE_DE_PLATAFORMAS = "streaming-availability";

export const PLATAFORMAS_MVP: readonly PlataformaCurada[] = [
  {
    id: "netflix",
    nombre: "Netflix",
    sourceId: "netflix",
    slugPublico: "netflix",
    activa: true,
  },
  {
    id: "prime",
    nombre: "Prime Video",
    sourceId: "prime",
    slugPublico: "prime-video",
    activa: true,
  },
  {
    id: "disney",
    nombre: "Disney+",
    sourceId: "disney",
    slugPublico: "disney-plus",
    activa: true,
  },
  {
    // 📏 La trampa: en la fuente se llama `hbo`.
    id: "max",
    nombre: "Max",
    sourceId: "hbo",
    slugPublico: "max",
    activa: true,
  },
  {
    id: "apple",
    nombre: "Apple TV",
    sourceId: "apple",
    slugPublico: "apple-tv",
    activa: true,
  },
  {
    id: "skyshowtime",
    nombre: "SkyShowtime",
    sourceId: "skyshowtime",
    slugPublico: "skyshowtime",
    activa: true,
  },
];

/** `source_id` del proveedor → `id` nuestro. Devuelve `null` si está fuera del MVP. */
export function plataformaDesdeFuente(sourceId: string): string | null {
  return PLATAFORMAS_MVP.find((p) => p.sourceId === sourceId)?.id ?? null;
}
