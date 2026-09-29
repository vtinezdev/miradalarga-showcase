import type { EntradaEditorial, TituloResumen } from "@/features/catalogo/modelo.ts";
import {
  anios,
  rutaDeFicha,
  temporadas,
  tipoDeObra,
} from "@/features/catalogo/formato.ts";
import { fechaCorta } from "@/lib/fechas.ts";
import { cx } from "@/lib/cx.ts";
import { AvailabilityCompact } from "./AvailabilityRow.tsx";
import { TitleImage } from "./TitleImage.tsx";
import s from "./EditorialEntry.module.css";
import { Enlace } from "./Enlace.tsx";

/**
 * Una entrada numerada de una lista editorial (DS §8.2): ordinal grande y fino,
 * título (`h2`), datos esenciales, etiqueta, **veredicto** y dónde verla.
 *
 * Si el título ya no está en ninguna plataforma, la entrada **se queda en su
 * sitio**, atenuada y con la fecha de salida: la lista nunca esconde en
 * silencio lo que se fue.
 */
export function EditorialEntry({
  entrada,
  titulo,
}: {
  entrada: EntradaEditorial;
  titulo: TituloResumen;
}) {
  const fuera = titulo.disponibilidad.length === 0;
  const datos = [
    tipoDeObra(titulo.tipo),
    anios(titulo),
    titulo.tipo === "serie" ? temporadas(titulo.temporadas) : null,
    ...titulo.generos.slice(0, 2),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <article
      className={cx(s.entrada, fuera && s.fuera)}
      data-fuera={fuera ? "" : undefined}
    >
      <span className={s.ordinal} aria-hidden="true">
        {entrada.orden}
      </span>
      <div className={s.cuerpo}>
        <p className="etiqueta">{datos}</p>
        <h2 className={s.titulo}>
          <span className="sr-only">{entrada.orden}. </span>
          <Enlace href={rutaDeFicha(titulo)}>{titulo.titulo}</Enlace>
        </h2>
        {entrada.etiqueta ? <p className={s.sello}>{entrada.etiqueta}</p> : null}
        <p className={s.veredicto}>{entrada.veredicto}</p>
        {fuera ? (
          <p className={s.salida}>
            Ya no está en ninguna plataforma que seguimos
            {titulo.fueraDesde ? (
              <>
                {" "}
                · desde el{" "}
                <time dateTime={titulo.fueraDesde}>
                  {fechaCorta(titulo.fueraDesde)}
                </time>
              </>
            ) : null}
          </p>
        ) : (
          <AvailabilityCompact ofertas={titulo.disponibilidad} maximo={3} />
        )}
      </div>
      <TitleImage
        className={s.poster}
        titulo={titulo}
        imagen={titulo.imagenes.poster}
        proporcion="poster"
        sizes="(min-width: 48rem) 120px, 72px"
      />
    </article>
  );
}
