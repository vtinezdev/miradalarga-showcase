import { cx } from "@/lib/cx.ts";
import s from "./SectionIndex.module.css";

/**
 * Índice local de secciones de un hub (INFORMATION-ARCHITECTURE.md §3,
 * «Secundaria»): anclas a las secciones que **existen** en esta página. En
 * móvil, una fila con scroll horizontal y un fundido que dice que continúa: es
 * la única excepción a «nada de scroll horizontal» en la navegación, y solo con
 * enlaces de texto.
 */
export function SectionIndex({
  secciones,
  className,
}: {
  secciones: { id: string; etiqueta: string }[];
  className?: string | undefined;
}) {
  if (secciones.length < 2) return null;
  return (
    <nav aria-label="En esta página" className={cx("contenedor", s.indice, className)}>
      <ul role="list" className={s.lista}>
        {secciones.map((x) => (
          <li key={x.id}>
            <a href={`#${x.id}`} className={s.enlace}>
              {x.etiqueta}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
