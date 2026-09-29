import type { IdPlataforma, Plataforma } from "./modelo.ts";

/**
 * **Presentación pública de las plataformas**: la única fuente de su nombre y
 * de su slug en la web. Cuatro identidades distintas, cada una en su sitio:
 *
 * | Qué | Ejemplo (HBO Max) | Dónde vive | Quién lo usa |
 * |---|---|---|---|
 * | id del proveedor | `hbo` | `external_platforms.source_id` · `PLATAFORMAS_MVP.sourceId` (jobs) | solo la ingesta |
 * | **id canónico** | `max` | `external_platforms.id` · `Plataforma.id` | toda la web: capacidades, Mis plataformas, filtros internos |
 * | **slug público** | `hbo-max` | **aquí** | URLs (`/plataformas/{slug}`, `?plataforma=`) |
 * | **nombre público** | «HBO Max» | **aquí** | todo texto visible |
 *
 * La web **nunca** ve el id del proveedor, y el nombre y el slug públicos **no
 * dependen** de cómo los llame el proveedor ni de lo que guarde Neon
 * (`external_platforms.name` y `public_slug` se quedan como referencia de la
 * ingesta; la web no los lee). Un rebranding es una línea aquí, sin migración
 * y sin tocar el id canónico, que es el que guardan el navegador (Mis
 * plataformas) y el contenido editorial.
 *
 * El id canónico **tiene** que coincidir con `PLATAFORMAS_MVP` de los jobs
 * (`tests/contract/plataformas-canonicas.test.ts`). El orden es el de
 * presentación en toda la web: neutro y estable.
 *
 * Presentación vigente a 2026-09-28: «Apple TV» (`apple-tv`) y «HBO Max»
 * (`hbo-max`). Sin producto publicado, los slugs anteriores no necesitan 301.
 */
export const PLATAFORMAS_PUBLICAS = [
  { id: "netflix", nombre: "Netflix", slug: "netflix" },
  { id: "prime", nombre: "Prime Video", slug: "prime-video" },
  { id: "disney", nombre: "Disney+", slug: "disney-plus" },
  { id: "max", nombre: "HBO Max", slug: "hbo-max" },
  { id: "apple", nombre: "Apple TV", slug: "apple-tv" },
  { id: "skyshowtime", nombre: "SkyShowtime", slug: "skyshowtime" },
] as const satisfies readonly Plataforma[];

export type IdPlataformaPublica = (typeof PLATAFORMAS_PUBLICAS)[number]["id"];

export const IDS_DE_PLATAFORMAS_PUBLICAS: readonly IdPlataforma[] =
  PLATAFORMAS_PUBLICAS.map((p) => p.id);

const POR_ID = new Map<IdPlataforma, Plataforma>(
  PLATAFORMAS_PUBLICAS.map((p) => [p.id, { ...p }]),
);

/** La presentación de un id canónico, o `null` si la web no publica esa plataforma. */
export function plataformaPublica(id: IdPlataforma): Plataforma | null {
  const p = POR_ID.get(id);
  return p ? { ...p } : null;
}

/** Posición de presentación: el orden de `PLATAFORMAS_PUBLICAS`. */
export function ordenDePlataforma(id: IdPlataforma): number {
  const i = IDS_DE_PLATAFORMAS_PUBLICAS.indexOf(id);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}
