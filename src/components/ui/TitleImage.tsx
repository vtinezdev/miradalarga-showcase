import type { ImagenPublicable, TituloResumen } from "@/features/catalogo/modelo.ts";
import { cx } from "@/lib/cx.ts";
import { PlaceholderImage } from "./PlaceholderImage.tsx";
import s from "./TitleImage.module.css";

/**
 * La abstracción de imagen del ADR 0008: **imagen publicable o cartel
 * tipográfico**, nunca otra cosa. Ninguna pantalla decide entre las dos: pasa
 * lo que el repositorio le dio. Las dos ramas ocupan exactamente el mismo hueco,
 * declarado antes de cargar (CLS).
 *
 * `alt=""` por defecto: el título de la obra está como texto al lado (DS §6.2).
 */
export function TitleImage({
  titulo,
  imagen,
  proporcion,
  sizes,
  prioridad = false,
  className,
}: {
  titulo: Pick<TituloResumen, "id" | "titulo" | "tipo" | "anio" | "anioFin">;
  imagen: ImagenPublicable | undefined;
  proporcion: "poster" | "fondo";
  sizes: string;
  prioridad?: boolean;
  className?: string | undefined;
}) {
  return (
    <div className={cx(s.hueco, className)} data-proporcion={proporcion}>
      {imagen ? (
        // `next/image` en vinext no optimiza (README de vinext): un <img> con
        // dimensiones declaradas hace lo mismo sin capa intermedia. Las variantes
        // `srcset` llegarán con el pipeline de imágenes de R2 (ADR 0008).
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className={s.imagen}
          src={imagen.url}
          width={imagen.ancho}
          height={imagen.alto}
          sizes={sizes}
          alt={imagen.alt ?? ""}
          loading={prioridad ? "eager" : "lazy"}
          fetchPriority={prioridad ? "high" : "auto"}
          decoding="async"
        />
      ) : (
        <PlaceholderImage
          id={titulo.id}
          titulo={titulo.titulo}
          tipo={titulo.tipo}
          anio={titulo.anio}
          anioFin={titulo.anioFin}
          proporcion={proporcion}
        />
      )}
    </div>
  );
}
