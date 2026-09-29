import type { ReactNode } from "react";
import { cx } from "@/lib/cx.ts";
import { Breadcrumbs } from "./Breadcrumbs.tsx";
import s from "./PageHeader.module.css";

/**
 * Cabecera de las páginas de sección (hubs, listas, radar, búsqueda): miga de
 * pan, antetítulo, `h1`, entradilla y una línea de estado. Tipográfica siempre
 * —ninguna depende de una imagen (ADR 0008)— y con el horizonte bajo el título,
 * que se traza al llegar (firma 1), como en la ficha sin imagen.
 *
 * - `editorial`: filete latón sobre el antetítulo (listas firmadas, C).
 * - `dato`: sin filete (radar, hubs, búsqueda).
 */
export function PageHeader({
  titulo,
  antetitulo,
  entradilla,
  migas,
  tipo = "dato",
  tamano = "hub",
  children,
  className,
}: {
  titulo: ReactNode;
  antetitulo?: string;
  entradilla?: ReactNode;
  migas?: { etiqueta: string; href?: string }[];
  tipo?: "editorial" | "dato";
  /** `lista`: el título de una lista editorial, más grande. */
  tamano?: "hub" | "lista";
  /** Línea de estado bajo la entradilla: recuentos, comprobación, acciones. */
  children?: ReactNode;
  className?: string | undefined;
}) {
  return (
    <header className={cx("contenedor", s.cabecera, className)}>
      {migas ? <Breadcrumbs elementos={migas} /> : null}
      <div className={cx(s.bloque, tipo === "editorial" && s.editorial)}>
        {antetitulo ? (
          <p className={cx("etiqueta", s.antetitulo)}>{antetitulo}</p>
        ) : null}
        <h1 className={cx(s.titulo, tamano === "lista" && s.tituloLista)}>{titulo}</h1>
        <span className={s.horizonte} aria-hidden="true" />
        {entradilla ? <div className={s.entradilla}>{entradilla}</div> : null}
        {children ? <div className={s.estado}>{children}</div> : null}
      </div>
    </header>
  );
}
