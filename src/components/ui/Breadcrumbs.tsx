import s from "./Breadcrumbs.module.css";
import { Enlace } from "./Enlace.tsx";

/**
 * Miga de pan (DS §8.1). El último elemento es la página actual: sin enlace y
 * con `aria-current`. Sus datos estructurados los emite la página.
 */
export function Breadcrumbs({
  elementos,
}: {
  elementos: { etiqueta: string; href?: string }[];
}) {
  return (
    <nav aria-label="Migas de pan" className={s.migas}>
      <ol role="list" className={s.lista}>
        {elementos.map((e, i) => {
          const ultimo = i === elementos.length - 1;
          return (
            <li key={`${e.etiqueta}-${i}`} className={s.elemento}>
              {e.href && !ultimo ? (
                <Enlace href={e.href}>{e.etiqueta}</Enlace>
              ) : (
                <span aria-current={ultimo ? "page" : undefined}>{e.etiqueta}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
