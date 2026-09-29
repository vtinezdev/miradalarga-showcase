"use client";

import { abrirMisPlataformas } from "@/features/mis-plataformas/eventos.ts";
import { cx } from "@/lib/cx.ts";
import s from "./InvitacionMisPlataformas.module.css";

/**
 * «¿Cuáles tienes? Márcalas y te lo decimos». Se oculta **por CSS** cuando ya
 * hay selección (el atributo de `<html>` existe antes del primer pintado), así
 * que no aparece y desaparece al hidratar.
 */
export function InvitacionMisPlataformas({
  texto,
  className,
}: {
  texto: string;
  className?: string | undefined;
}) {
  return (
    <p className={cx("ml-sin-seleccion", s.invitacion, className)}>
      <button
        type="button"
        className="enlace"
        onClick={abrirMisPlataformas}
        aria-haspopup="dialog"
      >
        {texto}
      </button>
    </p>
  );
}
