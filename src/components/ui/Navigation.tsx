import { DESTINOS } from "@/lib/navegacion.ts";
import { cx } from "@/lib/cx.ts";
import { EnlaceDeNavegacion } from "./EnlaceDeNavegacion.tsx";
import s from "./Navigation.module.css";

/** Los cinco destinos primarios, desde escritorio (`--bp-lg`). */
export function Navigation({ className }: { className?: string | undefined }) {
  return (
    <nav aria-label="Principal" className={cx(s.nav, className)}>
      <ul role="list" className={s.lista}>
        {DESTINOS.map((d) => (
          <li key={d.href}>
            <EnlaceDeNavegacion
              href={d.href}
              etiqueta={d.etiqueta}
              className={s.enlace}
            />
          </li>
        ))}
      </ul>
    </nav>
  );
}
