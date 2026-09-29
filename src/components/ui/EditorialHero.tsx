import type { CSSProperties } from "react";
import type { TarjetaDeLista } from "@/features/catalogo/consultas.ts";
import type { EntradaEditorial, TituloResumen } from "@/features/catalogo/modelo.ts";
import { rutaDeFicha, rutaDeLista } from "@/features/catalogo/formato.ts";
import { cx } from "@/lib/cx.ts";
import { AvailabilityCompact } from "./AvailabilityRow.tsx";
import { ButtonLink } from "./Button.tsx";
import { Signature } from "./Signature.tsx";
import indice from "./IndiceInvertido.module.css";
import s from "./EditorialHero.module.css";
import { Enlace } from "./Enlace.tsx";

/**
 * La selección principal de la portada (DS §8.2). **Fija, nunca rota.**
 *
 * Dos variantes de primera clase: `con-imagen` (banda que se funde con el fondo)
 * y `tipografica` (sin imagen: el titular manda y el sumario hace de portada).
 * El MVP puede salir sin imágenes publicables (ADR 0008): la tipográfica es la
 * que más se verá.
 *
 * Movimiento: al llegar, el horizonte se traza bajo la selección y el sumario
 * entra escalonado (una sola vez); el sumario es un índice que se invierte al
 * señalarlo. Con imagen, la banda se apaga al salir por arriba, sin moverse.
 */
export function EditorialHero({
  id,
  lista,
  entradas,
}: {
  id: string;
  lista: TarjetaDeLista;
  entradas: { entrada: EntradaEditorial; titulo: TituloResumen }[];
}) {
  const imagen = lista.imagen;
  return (
    <section
      className={cx(s.hero, imagen ? s.conImagen : s.tipografica)}
      aria-labelledby={id}
      data-folio="Selección de la semana"
    >
      {imagen ? (
        <div className={s.banda}>
          {/* eslint-disable-next-line @next/next/no-img-element -- ver TitleImage */}
          <img
            src={imagen.url}
            width={imagen.ancho}
            height={imagen.alto}
            alt={imagen.alt ?? ""}
            fetchPriority="high"
            decoding="async"
          />
        </div>
      ) : null}
      <div className={cx("contenedor", s.rejilla)}>
        <div className={s.principal}>
          <p className={cx("etiqueta", s.antetitulo)}>Selección de la semana</p>
          <h2 id={id} className={s.titular}>
            {lista.titulo}
          </h2>
          <p className={s.entradilla}>{lista.entradilla}</p>
          <Signature autor={lista.autor} revisada={lista.revisada} />
          <ButtonLink href={rutaDeLista(lista.slug)} className={s.boton}>
            Leer la lista
          </ButtonLink>
          <span className={s.horizonte} aria-hidden="true" />
        </div>
        {entradas.length > 0 ? (
          <ol role="list" className={s.sumario} aria-label={`En «${lista.titulo}»`}>
            {entradas.map(({ entrada, titulo }, i) => (
              <li
                key={titulo.id}
                className={cx(s.entrada, indice.invertible)}
                style={{ "--i": i } as CSSProperties}
              >
                <span className={cx(s.numero, indice.ordinal)} aria-hidden="true">
                  {entrada.orden}
                </span>
                <div className={s.cuerpoEntrada}>
                  <p className={s.tituloEntrada}>
                    <Enlace href={rutaDeFicha(titulo)}>{titulo.titulo}</Enlace>
                  </p>
                  <AvailabilityCompact ofertas={titulo.disponibilidad} maximo={2} />
                </div>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </section>
  );
}
