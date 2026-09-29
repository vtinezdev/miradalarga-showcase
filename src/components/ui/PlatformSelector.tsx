"use client";

import { useId, useState } from "react";
import type { Plataforma } from "@/features/catalogo/modelo.ts";
import { useMisPlataformas } from "@/features/mis-plataformas/estado.ts";
import { cx } from "@/lib/cx.ts";
import { clasesDeBoton } from "./Button.tsx";
import { IconoCheck } from "./iconos.tsx";
import s from "./PlatformSelector.module.css";

/**
 * Marcar Mis plataformas (DS §8.6, INFORMATION-ARCHITECTURE.md §6).
 *
 * Casillas nativas —flechas, espacio y lector de pantalla funcionan sin código
 * propio— estilizadas como mosaico. **Se guarda al instante**, sin botón
 * «Guardar», y se confirma en una región `polite`.
 *
 * El aspecto «marcada» sale del CSS del atributo de `<html>`, igual que el
 * resaltado del resto de la página: está bien pintado antes de hidratar.
 *
 * Respuesta táctil (interacción de firma 4): al pulsar, la pieza cede un poco;
 * al marcar, se enciende su luz latón, entra la marca de verificación y el
 * borde pasa a latón. Todo son transiciones de CSS sobre las mismas
 * propiedades `--mia-*`: sin estado propio y sin nada que animar al cargar.
 */
export function PlatformSelector({
  plataformas,
  variante,
  llegadasDeLaSemana,
}: {
  plataformas: Plataforma[];
  variante: "en-linea" | "hoja";
  /** Solo portada: cuántos títulos llegaron a cada plataforma esta semana. */
  llegadasDeLaSemana?: Record<string, number>;
}) {
  const validos = plataformas.map((p) => p.id);
  const { seleccion, guardar } = useMisPlataformas(validos);
  const [aviso, setAviso] = useState("");
  const id = useId();
  const marcadas = new Set(seleccion);

  const aplicar = (ids: readonly string[]) => {
    const persistido = guardar(ids);
    const nombres = plataformas.filter((p) => ids.includes(p.id)).map((p) => p.nombre);
    if (!persistido)
      setAviso("No podemos guardarlo en este navegador: vale solo para esta visita.");
    else
      setAviso(
        nombres.length > 0
          ? `Guardado: ${nombres.join(", ")}.`
          : "Sin plataformas marcadas.",
      );
  };

  const llegadas =
    llegadasDeLaSemana && seleccion.length > 0
      ? seleccion.reduce((total, pid) => total + (llegadasDeLaSemana[pid] ?? 0), 0)
      : null;

  return (
    <fieldset
      className={cx(s.selector, variante === "hoja" ? s.hoja : s.enLinea)}
      aria-describedby={`${id}-ayuda`}
    >
      <legend className={variante === "hoja" ? "sr-only" : s.leyenda}>
        Mis plataformas
      </legend>
      <p id={`${id}-ayuda`} className={s.ayuda}>
        {llegadas !== null
          ? llegadas > 0
            ? `Esta semana han llegado ${llegadas} ${llegadas === 1 ? "título" : "títulos"} a tus plataformas.`
            : "Esta semana no ha llegado nada nuevo a tus plataformas."
          : "Marca las que tienes y te diremos qué está incluido."}
      </p>
      <ul role="list" className={s.mosaico}>
        {plataformas.map((p, i) => (
          <li key={p.id}>
            <label className={s.opcion} data-plataforma={p.id}>
              <input
                type="checkbox"
                className={s.casilla}
                name="plataforma"
                value={p.id}
                data-foco-inicial={variante === "hoja" && i === 0 ? "" : undefined}
                checked={marcadas.has(p.id)}
                onChange={(e) =>
                  aplicar(
                    e.currentTarget.checked
                      ? [...seleccion, p.id]
                      : seleccion.filter((x) => x !== p.id),
                  )
                }
              />
              <span className={s.luz} aria-hidden="true" />
              <span className={s.nombre}>{p.nombre}</span>
              <IconoCheck tamano="m" className={s.check} />
            </label>
          </li>
        ))}
      </ul>
      <div className={s.pie}>
        <p className={s.nota}>Se guarda solo en este navegador. Sin cuenta.</p>
        <button
          type="button"
          className={cx("ml-con-seleccion", clasesDeBoton.base, clasesDeBoton.texto)}
          onClick={() => aplicar([])}
        >
          Quitar todas
        </button>
      </div>
      <p className={s.aviso} role="status" aria-live="polite">
        {aviso}
      </p>
    </fieldset>
  );
}
