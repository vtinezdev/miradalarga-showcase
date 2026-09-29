import type { ReactNode } from "react";
import { cx } from "@/lib/cx.ts";
import s from "./Button.module.css";
import { Enlace } from "./Enlace.tsx";

/**
 * Botón con aspecto de botón que **navega**: es un `<a>`, no un `<button>`
 * (DS §8.7). Un solo `principal` por pantalla.
 */
export function ButtonLink({
  href,
  children,
  variante = "principal",
  className,
}: {
  href: string;
  children: ReactNode;
  variante?: "principal" | "secundario";
  className?: string | undefined;
}) {
  return (
    <Enlace
      href={href}
      className={cx(
        s.boton,
        variante === "principal" ? s.principal : s.secundario,
        className,
      )}
    >
      {children}
    </Enlace>
  );
}

/** Mismas clases para los `<button>` que las necesiten (hojas, selector). */
export const clasesDeBoton = {
  base: s.boton,
  principal: s.principal,
  secundario: s.secundario,
  texto: s.texto,
};
