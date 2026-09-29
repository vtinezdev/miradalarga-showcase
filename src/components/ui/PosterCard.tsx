import type { TituloResumen } from "@/features/catalogo/modelo.ts";
import { anios, rutaDeFicha, tipoDeObra } from "@/features/catalogo/formato.ts";
import { PlatformBadges } from "./PlatformBadge.tsx";
import { TitleImage } from "./TitleImage.tsx";
import s from "./PosterCard.module.css";
import { Enlace } from "./Enlace.tsx";

/**
 * Un título como tarjeta visual, donde la imagen tiene sentido (relacionados).
 * El póster nunca va sin su título en texto, y la tarjeta entera es un solo
 * enlace para no multiplicar destinos enfocables. Sin valoración.
 *
 * Al señalarla, el póster (o el cartel) se enciende y avanza unos píxeles y el
 * horizonte se traza bajo el título. Nada crece.
 */
export function PosterCard({ titulo }: { titulo: TituloResumen }) {
  return (
    <article className={s.tarjeta}>
      <TitleImage
        className={s.imagen}
        titulo={titulo}
        imagen={titulo.imagenes.poster}
        proporcion="poster"
        sizes="(min-width: 64rem) 240px, 45vw"
      />
      <div className={s.textos}>
        <p className={s.titulo}>
          <Enlace href={rutaDeFicha(titulo)}>{titulo.titulo}</Enlace>
        </p>
        <span className={s.horizonte} aria-hidden="true" />
        <p className={s.meta}>
          {tipoDeObra(titulo.tipo)} · {anios(titulo)}
        </p>
        <PlatformBadges plataformas={titulo.disponibilidad.map((o) => o.plataforma)} />
      </div>
    </article>
  );
}
