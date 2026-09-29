"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { cx } from "@/lib/cx.ts";
import { IconoCerrar } from "./iconos.tsx";
import s from "./Sheet.module.css";

/**
 * Hoja o diálogo sobre `<dialog>` nativo (DS §8.7): el navegador ya da foco
 * atrapado, `Esc`, capa inerte detrás y retorno del foco al cerrar. Aquí solo
 * se añade el botón de cerrar visible y el cierre al pulsar fuera.
 *
 * - `inferior`: hoja que sube desde abajo en móvil y se centra desde tableta.
 * - `completa`: pantalla completa (menú móvil).
 */
export function Sheet({
  abierto,
  alCerrar,
  titulo,
  idTitulo,
  variante = "inferior",
  children,
}: {
  abierto: boolean;
  alCerrar: () => void;
  titulo: string;
  idTitulo: string;
  variante?: "inferior" | "completa";
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialogo = ref.current;
    if (!dialogo) return;
    if (abierto && !dialogo.open) {
      dialogo.showModal();
      // El navegador enfoca el primer control, que es «Cerrar»: un Espacio de
      // quien quería marcar algo cerraría la hoja. Si el contenido declara su
      // control principal, el foco va ahí.
      dialogo.querySelector<HTMLElement>("[data-foco-inicial]")?.focus();
    } else if (!abierto && dialogo.open) dialogo.close();
  }, [abierto]);

  return (
    <dialog
      ref={ref}
      className={cx(s.hoja, variante === "completa" ? s.completa : s.inferior)}
      aria-labelledby={idTitulo}
      onClose={alCerrar}
      onClick={(evento) => {
        // Solo el fondo: el contenido ocupa todo el diálogo salvo el ::backdrop.
        if (evento.target === evento.currentTarget) alCerrar();
      }}
    >
      <div className={s.contenido}>
        <div className={s.cabeza}>
          <h2 id={idTitulo} className={s.titulo}>
            {titulo}
          </h2>
          <button type="button" className={s.cerrar} onClick={alCerrar}>
            <IconoCerrar tamano="m" />
            <span className="sr-only">Cerrar</span>
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
