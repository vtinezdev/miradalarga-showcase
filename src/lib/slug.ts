/**
 * Slugs de ficha para el catálogo real (`/peliculas/{slug}`, `/series/{slug}`).
 *
 * Neon **no guarda slugs**: `site_title_slugs` está diferida a la Fase 3
 * (`docs/DATA-MODEL.md`: «generar los slugs después es un `UPDATE`»). Hasta
 * entonces el slug se **deriva**, de forma determinista, del título en español
 * y del `imdb_id`, que es la identidad estable del título (ADR 0001):
 *
 *     «La casa del faro» + tt1234567  →  la-casa-del-faro-tt1234567
 *
 * - **Estable y reproducible:** mismo título e id, mismo slug, en cualquier
 *   entorno y tras cualquier recarga (el `id` interno de la base no lo es).
 * - **Sin colisiones:** `imdb_id` es único en `external_titles`.
 * - **Resistente a cambios del texto:** la ficha se resuelve **solo por el
 *   sufijo** `tt…`. Si el proveedor retoca el título, el slug viejo sigue
 *   llevando a la misma ficha, que declara el nuevo como canónico.
 *
 * Solo son enrutables los `imdb_id` con forma `tt` + dígitos: el `CHECK` de la
 * base no la exige (`0004` solo impide el vacío), y un id de otra forma no
 * podría separarse del texto sin ambigüedad (`docs/NEON-ADAPTER.md` §5).
 */

/** Longitud máxima de la parte de texto, para URLs legibles. */
const MAXIMO_DEL_TEXTO = 80;

const IMDB_ENRUTABLE = /^tt\d{1,12}$/;
const SUFIJO = /(?:^|-)(tt\d{1,12})$/;

/** ¿Tiene este `imdb_id` la forma que un slug puede llevar? */
export function imdbEnrutable(imdbId: string): boolean {
  return IMDB_ENRUTABLE.test(imdbId);
}

/** «Ruido Blanco: en la Sierra» → «ruido-blanco-en-la-sierra». */
export function textoDeSlug(titulo: string): string {
  const plano = titulo
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (plano.length <= MAXIMO_DEL_TEXTO) return plano;
  // Se corta en un guion para no dejar media palabra.
  const corte = plano.slice(0, MAXIMO_DEL_TEXTO);
  const ultimo = corte.lastIndexOf("-");
  return (ultimo > 0 ? corte.slice(0, ultimo) : corte).replace(/-+$/, "");
}

/**
 * El slug canónico, o `null` si el `imdb_id` no es enrutable. Un título sin
 * letras latinas («東京») se queda en el sufijo: `tt1234567`.
 */
export function slugDeTitulo(titulo: string, imdbId: string): string | null {
  if (!imdbEnrutable(imdbId)) return null;
  const texto = textoDeSlug(titulo);
  return texto ? `${texto}-${imdbId}` : imdbId;
}

/**
 * El `imdb_id` que identifica un slug, o `null` si el slug no tiene sufijo
 * válido. La parte de texto **no se comprueba**: es presentación.
 */
export function imdbDeSlug(slug: string): string | null {
  if (slug.length > MAXIMO_DEL_TEXTO + 20) return null;
  return SUFIJO.exec(slug.toLowerCase())?.[1] ?? null;
}
