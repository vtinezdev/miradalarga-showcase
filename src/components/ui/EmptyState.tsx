import type { ReactNode } from "react";
import { cx } from "@/lib/cx.ts";
import s from "./EmptyState.module.css";
import { Enlace } from "./Enlace.tsx";

/**
 * Estado vacío con salida útil (DS §8.8): dice **por qué** está vacío y ofrece
 * adónde ir. Nunca «0 resultados» a secas. Mensaje a un lado, salidas al otro;
 * apilado en móvil.
 *
 * `motivo` queda en el HTML (`data-motivo`) y cambia el tono: `capacidad` y
 * `sin-datos` son límites de la fuente, no errores; `no-encontrado` es un 404.
 * `compacto` es el vacío dentro de una sección (filtros, un bloque de un hub):
 * no compite con el `h1` de la página.
 */
export function EmptyState({
  titulo,
  explicacion,
  acciones = [],
  motivo = "sin-resultados",
  nivel = 2,
  compacto = false,
  children,
  className,
}: {
  titulo: string;
  explicacion: ReactNode;
  acciones?: { etiqueta: string; href: string }[];
  motivo?: "sin-resultados" | "sin-datos" | "capacidad" | "no-encontrado";
  nivel?: 1 | 2 | 3;
  compacto?: boolean;
  /** Salidas que no son enlaces (p. ej. «Quitar filtros»). */
  children?: ReactNode;
  className?: string | undefined;
}) {
  const Titulo = nivel === 1 ? "h1" : nivel === 2 ? "h2" : "h3";
  const hayAcciones = acciones.length > 0 || children;
  return (
    <div
      className={cx(s.vacio, compacto && s.compacto, className)}
      data-motivo={motivo}
    >
      <div className={s.mensaje}>
        <Titulo className={s.titulo}>{titulo}</Titulo>
        <div className={s.explicacion}>{explicacion}</div>
      </div>
      {hayAcciones ? (
        <ul role="list" className={s.acciones}>
          {acciones.map((a) => (
            <li key={a.href}>
              <Enlace href={a.href}>{a.etiqueta}</Enlace>
            </li>
          ))}
          {children ? <li>{children}</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
