"use client";

import { useState, type ReactNode } from "react";
import { useMisPlataformas } from "@/features/mis-plataformas/estado.ts";
import { InvitacionMisPlataformas } from "./InvitacionMisPlataformas.tsx";
import s from "./SoloEnMisPlataformas.module.css";

/**
 * «Solo en mis plataformas · 12 de 18» (SCREENS.md §3, INFORMATION-ARCHITECTURE
 * §6): **resaltar es automático; ocultar, nunca**, salvo que el lector active
 * este conmutador. Apagado por defecto, así que el HTML servido —y lo que ve un
 * buscador— es la lista entera, y al hidratar nada se mueve.
 *
 * Sin selección no hay conmutador: hay una invitación a marcarlas. Las dos cosas
 * se deciden por CSS con el atributo de `<html>`, antes del primer pintado.
 *
 * Las entradas llegan ya renderizadas del servidor; aquí solo se decide cuáles
 * se pintan. El número de cada una es el del autor, no se renumera.
 */
export function SoloEnMisPlataformas({
  elementos,
  validos,
  etiqueta,
  nombre = "entradas",
  className,
}: {
  elementos: { clave: string; plataformas: string[]; nodo: ReactNode }[];
  validos: string[];
  /** Nombre accesible de la lista. */
  etiqueta: string;
  /** Qué se cuenta, en plural: «entradas», «títulos». */
  nombre?: string;
  className?: string | undefined;
}) {
  const { seleccion } = useMisPlataformas(validos);
  const [activo, setActivo] = useState(false);
  const [aviso, setAviso] = useState("");
  const mias = new Set(seleccion);
  const esMio = (e: { plataformas: string[] }) =>
    e.plataformas.some((p) => mias.has(p));
  const cuantas = elementos.filter(esMio).length;
  const filtrando = activo && mias.size > 0;
  const visibles = filtrando ? elementos.filter(esMio) : elementos;

  return (
    <div className={className}>
      <div className={s.barra}>
        <label className={`ml-con-seleccion ${s.conmutador}`}>
          <input
            type="checkbox"
            className={s.casilla}
            checked={activo}
            onChange={(e) => {
              const valor = e.currentTarget.checked;
              setActivo(valor);
              setAviso(
                valor
                  ? `Mostrando ${cuantas} de ${elementos.length} ${nombre}: solo las de tus plataformas.`
                  : `Mostrando las ${elementos.length} ${nombre}.`,
              );
            }}
          />
          <span className={s.interruptor} aria-hidden="true" />
          <span>
            Solo en mis plataformas
            <span className={`cifras ${s.recuento}`}>
              {" "}
              · {cuantas} de {elementos.length}
            </span>
          </span>
        </label>
        <InvitacionMisPlataformas texto="¿Cuáles tienes? Márcalas y te decimos cuáles puedes ver" />
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {aviso}
      </p>
      {filtrando && visibles.length === 0 ? (
        <p className={s.vacio}>
          Ninguna de estas {nombre} está hoy en tus plataformas.{" "}
          <button type="button" className="enlace" onClick={() => setActivo(false)}>
            Ver la lista entera
          </button>
        </p>
      ) : (
        <ol role="list" className={s.lista} aria-label={etiqueta}>
          {visibles.map((e) => (
            <li key={e.clave}>{e.nodo}</li>
          ))}
        </ol>
      )}
    </div>
  );
}
