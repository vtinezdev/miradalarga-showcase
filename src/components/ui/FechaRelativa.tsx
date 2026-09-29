"use client";

import { useSyncExternalStore } from "react";
import { diaRelativo, fechaCorta, hora } from "@/lib/fechas.ts";
import s from "./FechaRelativa.module.css";

// La fecha de hoy no avisa cuando cambia: basta con leerla al hidratar.
function sinSuscripcion() {
  return () => {
    /* nada que desuscribir */
  };
}

/**
 * «hoy, 06:10» / «ayer, 06:10» / «el 27 sep, 06:10».
 *
 * El servidor escribe siempre la forma absoluta: el HTML se cachea, y un «hoy»
 * servido mañana sería falso. Al hidratar, el navegador —que sí sabe qué día es—
 * la cambia por la relativa si procede. La forma absoluta es siempre la más
 * ancha, así que se deja debajo, invisible, reservando el hueco: el texto
 * hidratado cabe en la misma caja y la línea no cambia de longitud (CLS).
 */
export function FechaRelativa({
  instante,
  conHora = true,
}: {
  instante: string;
  conHora?: boolean;
}) {
  const absoluta = `el ${fechaCorta(instante)}`;
  const sufijo = conHora ? `, ${hora(instante)}` : "";
  const texto = useSyncExternalStore(
    sinSuscripcion,
    () => diaRelativo(instante, new Date()) ?? absoluta,
    () => absoluta,
  );
  return (
    <span className={s.reserva}>
      <span aria-hidden="true" className={s.hueco}>
        {absoluta}
        {sufijo}
      </span>
      <span className={s.visible}>
        {texto}
        {sufijo}
      </span>
    </span>
  );
}
