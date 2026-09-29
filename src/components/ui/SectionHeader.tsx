import type { ReactNode } from "react";
import { cx } from "@/lib/cx.ts";
import { IconoFlecha } from "./iconos.tsx";
import s from "./SectionHeader.module.css";
import { Enlace } from "./Enlace.tsx";

/**
 * Cabecera de sección con el separador horizonte (VISUAL-DIRECTION.md §2.2).
 *
 * - `editorial`: filete latón corto sobre el antetítulo (distintivo de C).
 * - `automatico`: enlace obligatorio a la metodología y **sin** vocabulario
 *   editorial (docs/RANKINGS.md).
 * - `dato`: ni lo uno ni lo otro.
 */
export function SectionHeader({
  id,
  titulo,
  nivel = 2,
  antetitulo,
  descripcion,
  enlace,
  tipo = "dato",
  oculto = false,
}: {
  id: string;
  titulo: string;
  nivel?: 2 | 3;
  antetitulo?: string;
  descripcion?: ReactNode;
  enlace?: { etiqueta: string; href: string };
  tipo?: "editorial" | "automatico" | "dato";
  /** Cabecera solo para lectores de pantalla (la sección se explica sola). */
  oculto?: boolean;
}) {
  const Titulo = nivel === 2 ? "h2" : "h3";
  if (oculto) {
    return (
      <Titulo id={id} className="sr-only">
        {titulo}
      </Titulo>
    );
  }
  return (
    <header className={cx(s.cabecera, tipo === "editorial" && s.editorial)}>
      <div className={s.fila}>
        <div className={s.textos}>
          {antetitulo ? (
            <p className={cx("etiqueta", s.antetitulo)}>{antetitulo}</p>
          ) : null}
          <Titulo id={id} className={nivel === 2 ? s.h2 : s.h3}>
            {titulo}
          </Titulo>
        </div>
        {enlace ? (
          <Enlace className={cx("enlace", s.enlace)} href={enlace.href}>
            {enlace.etiqueta}
            <IconoFlecha />
          </Enlace>
        ) : null}
      </div>
      {descripcion ? <div className={s.descripcion}>{descripcion}</div> : null}
    </header>
  );
}
