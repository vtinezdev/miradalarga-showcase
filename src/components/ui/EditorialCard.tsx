import type { TarjetaDeLista } from "@/features/catalogo/consultas.ts";
import { rutaDeLista } from "@/features/catalogo/formato.ts";
import { cx } from "@/lib/cx.ts";
import { RecuentoMisPlataformas } from "./RecuentoMisPlataformas.tsx";
import { Signature } from "./Signature.tsx";
import { TitleImage } from "./TitleImage.tsx";
import s from "./EditorialCard.module.css";
import { Enlace } from "./Enlace.tsx";

/**
 * Una lista editorial en la portada (DS §8.2). Toda la tarjeta es un solo
 * enlace (el título, ampliado), y dice su estado vivo: «4 títulos · 4
 * disponibles hoy», más los tuyos si has marcado plataformas.
 *
 * - `principal` y `columna`: piezas del rail editorial, con los carteles arriba.
 * - `secundaria`: fila compacta (ficha, «Aparece en estas listas»).
 *
 * Al señalarla (ratón, foco o dedo), los carteles se encienden y avanzan unos
 * píxeles, y el horizonte se traza bajo el título. Nada crece.
 */
export function EditorialCard({
  lista,
  tamano,
  nivel = 3,
  plataformasValidas,
}: {
  lista: TarjetaDeLista;
  tamano: "principal" | "columna" | "secundaria";
  nivel?: 2 | 3;
  plataformasValidas: string[];
}) {
  const Titulo = nivel === 2 ? "h2" : "h3";
  return (
    <article
      className={cx(
        s.tarjeta,
        tamano === "principal" && s.principal,
        tamano === "columna" && s.columna,
        tamano === "secundaria" && s.secundaria,
      )}
    >
      <div className={s.portada} aria-hidden="true">
        {lista.portada.map((t) => (
          <TitleImage
            key={t.id}
            className={s.poster}
            titulo={t}
            imagen={t.imagenes.poster}
            proporcion="poster"
            sizes={
              tamano === "principal"
                ? "(min-width: 64rem) 200px, 30vw"
                : tamano === "columna"
                  ? "120px"
                  : "72px"
            }
          />
        ))}
      </div>
      <div className={s.textos}>
        <p className={cx("etiqueta", s.antetitulo)}>Lista editorial</p>
        <Titulo className={s.titulo}>
          <Enlace href={rutaDeLista(lista.slug)}>{lista.titulo}</Enlace>
        </Titulo>
        <span className={s.horizonte} aria-hidden="true" />
        {tamano === "principal" ? (
          <p className={s.entradilla}>{lista.entradilla}</p>
        ) : null}
        <p className={s.estado}>
          {lista.numeroDeTitulos} títulos · {lista.disponiblesHoy} disponibles hoy
          <RecuentoMisPlataformas
            plataformasPorTitulo={lista.plataformasPorTitulo}
            validos={plataformasValidas}
          />
        </p>
        <Signature autor={lista.autor} revisada={lista.revisada} className={s.firma} />
      </div>
    </article>
  );
}
