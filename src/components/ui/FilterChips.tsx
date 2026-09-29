"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cx } from "@/lib/cx.ts";
import { IconoCheck, IconoChevron } from "./iconos.tsx";
import s from "./FilterChips.module.css";

export interface OpcionDeFiltro {
  /** "" es «todo»: quita el filtro. */
  valor: string;
  etiqueta: string;
  recuento?: number | undefined;
  /** Solo tiene sentido con Mis plataformas marcadas: se oculta por CSS si no hay. */
  soloConSeleccion?: boolean;
}

/**
 * Filtros de selección única (DS §8.6): `<fieldset>` + `<legend>` y un botón por
 * opción con `aria-pressed`. Seleccionado = fondo tintado, borde latón **y**
 * marca de verificación: nunca solo color. Los chips **envuelven línea**, nunca
 * se cortan, y el recuento va en cifra con su separador para el lector de
 * pantalla («Llega, 23»).
 *
 * - `plegable`: en móvil, el grupo empieza plegado tras un botón que dice el
 *   valor actual (divulgación progresiva); desde tableta se ve siempre.
 * - `extra`: opciones secundarias tras «Más» (p. ej. «Cambios» en el radar).
 *
 * Un recuento cero no deshabilita el chip: elegirlo lleva a un estado vacío que
 * explica **por qué** (capacidad de la fuente o ausencia real).
 */
export function FilterChips({
  legend,
  opciones,
  valor,
  alCambiar,
  plegable = false,
  extra,
  className,
}: {
  legend: string;
  opciones: readonly OpcionDeFiltro[];
  valor: string;
  alCambiar: (valor: string) => void;
  plegable?: boolean;
  extra?: { etiqueta: string; opciones: readonly OpcionDeFiltro[] };
  className?: string | undefined;
}) {
  const id = useId();
  const [desplegado, setDesplegado] = useState(false);
  const enExtra =
    extra?.opciones.some((o) => o.valor === valor && valor !== "") ?? false;
  const [conExtra, setConExtra] = useState(false);
  const lista = useRef<HTMLUListElement>(null);
  // «Más» desaparece al pulsarlo: el foco pasa a la primera opción que revela,
  // en vez de perderse en <body>.
  useEffect(() => {
    if (conExtra) lista.current?.querySelector<HTMLElement>("[data-extra]")?.focus();
  }, [conExtra]);
  const actual =
    [...opciones, ...(extra?.opciones ?? [])].find((o) => o.valor === valor)
      ?.etiqueta ?? opciones[0]?.etiqueta;

  const chip = (o: OpcionDeFiltro, i: number, extra = false) => {
    const elegido = o.valor === valor;
    return (
      <li
        key={o.valor || "todo"}
        className={o.soloConSeleccion ? "ml-con-seleccion" : undefined}
      >
        <button
          type="button"
          className={cx(s.chip, o.recuento === 0 && !elegido && s.cero)}
          aria-pressed={elegido}
          data-extra={extra && i === 0 ? "" : undefined}
          onClick={() => alCambiar(o.valor)}
        >
          <IconoCheck className={s.check} />
          <span>{o.etiqueta}</span>
          {o.recuento !== undefined ? (
            <span className={cx("cifras", s.recuento)}>
              <span className="sr-only">, </span>
              {o.recuento}
            </span>
          ) : null}
        </button>
      </li>
    );
  };

  return (
    <fieldset
      className={cx(s.grupo, className)}
      data-plegable={plegable ? "" : undefined}
      data-desplegado={desplegado ? "" : undefined}
    >
      <legend className={s.legend}>{legend}</legend>
      {plegable ? (
        <button
          type="button"
          className={s.desplegar}
          aria-expanded={desplegado}
          aria-controls={id}
          onClick={() => setDesplegado((d) => !d)}
        >
          <span>{actual}</span>
          <IconoChevron className={s.chevron} />
          <span className="sr-only">: cambiar {legend.toLowerCase()}</span>
        </button>
      ) : null}
      <ul ref={lista} id={id} role="list" className={s.chips}>
        {opciones.map((o, i) => chip(o, i))}
        {extra ? (
          conExtra || enExtra ? (
            extra.opciones.map((o, i) => chip(o, i, true))
          ) : (
            <li>
              <button
                type="button"
                className={cx(s.chip, s.mas)}
                aria-expanded={false}
                onClick={() => setConExtra(true)}
              >
                <span>{extra.etiqueta}</span>
                <IconoChevron className={s.chevron} />
              </button>
            </li>
          )
        ) : null}
      </ul>
    </fieldset>
  );
}
