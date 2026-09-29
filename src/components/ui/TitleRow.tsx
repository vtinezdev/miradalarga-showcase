import type { ReactNode } from "react";
import type { TituloResumen } from "@/features/catalogo/modelo.ts";
import {
  anios,
  rutaDeFicha,
  temporadas,
  tipoDeObra,
} from "@/features/catalogo/formato.ts";
import { fechaCorta } from "@/lib/fechas.ts";
import { cx } from "@/lib/cx.ts";
import { PlatformBadges } from "./PlatformBadge.tsx";
import { TitleImage } from "./TitleImage.tsx";
import indice from "./IndiceInvertido.module.css";
import s from "./TitleRow.module.css";
import { Enlace } from "./Enlace.tsx";

/**
 * El título como fila de índice: el formato más reutilizado (radar, rankings,
 * búsqueda, móvil). Una sola zona de enlace —el título—; los chips no enlazan.
 *
 * Con `ordinal` es una entrada de ranking y se **invierte** al señalarla
 * (`IndiceInvertido.module.css`): el número toma cuerpo, nunca se convierte en
 * una puntuación.
 */
export function TitleRow({
  titulo,
  ordinal,
  nota,
  miniatura = true,
  resaltado,
  className,
}: {
  titulo: TituloResumen;
  ordinal?: number;
  nota?: ReactNode;
  miniatura?: boolean;
  /** El título con la coincidencia marcada (búsqueda); por defecto, el texto. */
  resaltado?: ReactNode;
  className?: string | undefined;
}) {
  const meta = [
    tipoDeObra(titulo.tipo),
    anios(titulo),
    titulo.tipo === "serie" ? temporadas(titulo.temporadas) : null,
    ...titulo.generos.slice(0, 2),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <article
      className={cx(
        s.fila,
        ordinal !== undefined && s.conOrdinal,
        ordinal !== undefined && indice.invertible,
        className,
      )}
    >
      {ordinal !== undefined ? (
        // La lista ordenada ya anuncia la posición: el número grande es visual.
        <span className={cx(s.ordinal, indice.ordinal)} aria-hidden="true">
          {ordinal}
        </span>
      ) : null}
      {miniatura ? (
        <TitleImage
          className={s.miniatura}
          titulo={titulo}
          imagen={titulo.imagenes.poster}
          proporcion="poster"
          sizes="48px"
        />
      ) : null}
      <div className={s.cuerpo}>
        <p className={s.titulo}>
          <Enlace href={rutaDeFicha(titulo)}>{resaltado ?? titulo.titulo}</Enlace>
        </p>
        <p className={s.meta}>{meta}</p>
        {nota ? <div className={s.nota}>{nota}</div> : null}
        <PlatformBadges plataformas={titulo.disponibilidad.map((o) => o.plataforma)} />
        {titulo.fueraDesde && titulo.disponibilidad.length === 0 ? (
          <p className={s.fuera}>
            Ya no está en ninguna plataforma que seguimos · desde el{" "}
            <time dateTime={titulo.fueraDesde}>{fechaCorta(titulo.fueraDesde)}</time>
          </p>
        ) : null}
      </div>
    </article>
  );
}
