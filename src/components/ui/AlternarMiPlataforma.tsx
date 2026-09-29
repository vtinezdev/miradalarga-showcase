"use client";

import { useState } from "react";
import type { Plataforma } from "@/features/catalogo/modelo.ts";
import { useMisPlataformas } from "@/features/mis-plataformas/estado.ts";
import { IconoCheck } from "./iconos.tsx";
import s from "./AlternarMiPlataforma.module.css";

/**
 * «Añadir a Mis plataformas» en el hub de una plataforma (firma 4): la misma
 * respuesta física que el selector —cede al pulsar, se enciende la luz latón,
 * entra la marca— sin abrir la hoja.
 *
 * El texto visible sale del CSS del atributo de `<html>` (`--mia-*`), así que es
 * correcto **antes de hidratar** y no salta. El nombre del botón dice la acción
 * («Añadir…» / «… Quitar»), sin `aria-pressed` encima: un solo estado. El
 * servidor nunca sabe qué plataformas tienes.
 */
export function AlternarMiPlataforma({
  plataforma,
  validos,
}: {
  plataforma: Plataforma;
  validos: string[];
}) {
  const { seleccion, guardar } = useMisPlataformas(validos);
  const [aviso, setAviso] = useState("");
  const mia = seleccion.includes(plataforma.id);

  return (
    <>
      <button
        type="button"
        className={s.boton}
        data-plataforma={plataforma.id}
        onClick={() => {
          const siguiente = mia
            ? seleccion.filter((id) => id !== plataforma.id)
            : [...seleccion, plataforma.id];
          const persistido = guardar(siguiente);
          setAviso(
            !persistido
              ? "No podemos guardarlo en este navegador: vale solo para esta visita."
              : mia
                ? `${plataforma.nombre} ya no está en tus plataformas.`
                : `${plataforma.nombre} guardada en tus plataformas.`,
          );
        }}
      >
        <span className={s.luz} aria-hidden="true" />
        <IconoCheck tamano="m" className={s.check} />
        <span className={s.siMia}>
          En tus plataformas <span className={s.quitar}>· Quitar</span>
          <span className="sr-only">: {plataforma.nombre}</span>
        </span>
        <span className={s.noMia}>
          Añadir a Mis plataformas<span className="sr-only">: {plataforma.nombre}</span>
        </span>
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {aviso}
      </span>
    </>
  );
}
