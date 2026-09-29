/**
 * Lo que `external_title_images` necesita y el contrato canónico todavía no da.
 *
 * ⚠️ **Deuda consciente.** `ImagenCanonica` solo lleva `tipo` y `urlPorAncho`,
 * así que la caducidad, el placeholder y el idioma hay que sacarlos de la URL
 * aquí. Eso es conocimiento del proveedor viviendo fuera del adaptador, que es
 * justo lo que `docs/ARCHITECTURE.md` no quiere.
 *
 * No se arregla ahora a propósito: el pipeline de imágenes —intercambiable por
 * fuente, con `source` y R2 + CDN propio (D6, ADR 0008)— todavía no
 * existe. Cuando se construya, esto
 * se muda al adaptador o el contrato canónico crece. Mientras tanto queda
 * aquí, aislado en un fichero y señalado.
 *
 * **Nunca se descarga ni se cachea un binario.** Solo se guarda la referencia.
 */

/** Los cuatro conjuntos del proveedor, traducidos al enum del esquema. */
const TIPOS: Readonly<Record<string, string>> = {
  poster_vertical: "vertical_poster",
  poster_horizontal: "horizontal_poster",
  fondo_vertical: "vertical_backdrop",
  fondo_horizontal: "horizontal_backdrop",
};

export function tipoDeImagen(tipoCanonico: string): string | null {
  return TIPOS[tipoCanonico] ?? null;
}

export interface MetadatosDeImagen {
  /** Caducidad de la URL firmada, parseada del parámetro `Expires`. */
  readonly caducaEn: Date | null;
  /** 📏 155 de 13.515 URLs son el SVG genérico del proveedor. */
  readonly esPlaceholder: boolean;
  /**
   * Idioma del segmento de la ruta, o `null` si no lo lleva.
   *
   * 📏 Los *backdrops* nunca llevan idioma, y los pósters no siempre: 7.485 de
   * 13.515 referencias lo traen. Ese `null` es lo que obliga a que la clave
   * de la tabla use `NULLS NOT DISTINCT`.
   */
  readonly idioma: string | null;
}

/** El placeholder genérico del proveedor. No es una imagen. */
const RUTA_PLACEHOLDER = "/media/image.svg";

/** `…/es/poster.jpg` → `es`. Dos letras justo antes del nombre del fichero. */
const SEGMENTO_DE_IDIOMA = /\/([a-z]{2})\/[^/]+\.(?:jpg|jpeg|png|webp|avif)/i;

export function analizarUrlDeImagen(url: string): MetadatosDeImagen {
  let caducaEn: Date | null = null;
  try {
    const expira = new URL(url).searchParams.get("Expires");
    if (expira !== null && /^\d+$/.test(expira)) {
      // UNIX en segundos, igual que el resto de marcas del proveedor.
      caducaEn = new Date(Number(expira) * 1000);
    }
  } catch {
    // Una URL ilegible no es motivo para perder la referencia: se guarda sin
    // caducidad y `url_expires_at` queda en «no consta».
  }

  const idioma = SEGMENTO_DE_IDIOMA.exec(url)?.[1]?.toLowerCase() ?? null;

  return {
    caducaEn,
    esPlaceholder: url.includes(RUTA_PLACEHOLDER),
    idioma,
  };
}
