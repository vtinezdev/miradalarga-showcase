"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cx } from "@/lib/cx.ts";
import { IconoFlecha } from "./iconos.tsx";
import s from "./RailEditorial.module.css";

/**
 * Rail editorial (interacción de firma 2, DS §8.2). **No es un carrusel**: no
 * avanza solo, no rota y no se usa para el contenido principal de una página.
 * Existe solo donde recorrer en horizontal tiene sentido editorial.
 *
 * - Scroll horizontal **nativo** con `scroll-snap`: el dedo, la rueda y el
 *   trackpad funcionan sin código. La primera pieza puede tener más jerarquía
 *   (`principal`) y la siguiente siempre asoma.
 * - El indicador es el horizonte de la marca: el punto latón recorre la línea
 *   según la posición.
 * - Botones anterior/siguiente para ratón y teclado (WCAG 2.5.7: nada exige
 *   arrastrar). Tab recorre los enlaces y el navegador desplaza al enfocado.
 *
 * El servidor pinta todas las piezas: sin JavaScript es una lista con scroll
 * horizontal. La isla solo añade los botones y el indicador.
 */
export function RailEditorial({
  etiqueta,
  elementos,
  className,
}: {
  etiqueta: string;
  elementos: { id: string; nodo: ReactNode; principal?: boolean }[];
  className?: string | undefined;
}) {
  const idPista = useId();
  const pista = useRef<HTMLUListElement>(null);
  const carro = useRef<HTMLSpanElement>(null);
  const [estado, setEstado] = useState({ desborda: false, inicio: true, fin: false });

  useEffect(() => {
    const el = pista.current;
    if (!el) return;
    let marco = 0;
    const medir = () => {
      marco = 0;
      const maximo = el.scrollWidth - el.clientWidth;
      const desborda = maximo > 1;
      // Sin nada que recorrer, el punto descansa al final del horizonte (la marca).
      const progreso = desborda ? Math.min(1, Math.max(0, el.scrollLeft / maximo)) : 1;
      // Valor transitorio: va directo al estilo, sin pasar por React.
      carro.current?.style.setProperty("--progreso", String(progreso));
      const inicio = el.scrollLeft <= 1;
      const fin = el.scrollLeft >= maximo - 1;
      setEstado((previo) =>
        previo.desborda === desborda && previo.inicio === inicio && previo.fin === fin
          ? previo
          : { desborda, inicio, fin },
      );
    };
    const programar = () => {
      if (!marco) marco = requestAnimationFrame(medir);
    };
    medir();
    el.addEventListener("scroll", programar, { passive: true });
    const tamano = new ResizeObserver(programar);
    tamano.observe(el);
    return () => {
      cancelAnimationFrame(marco);
      el.removeEventListener("scroll", programar);
      tamano.disconnect();
    };
  }, []);

  const mover = (sentido: 1 | -1) => {
    const el = pista.current;
    if (!el) return;
    const relleno = parseFloat(getComputedStyle(el).scrollPaddingInlineStart) || 0;
    const posiciones = [...el.children].map(
      (hijo) => (hijo as HTMLElement).offsetLeft - relleno,
    );
    const actual = el.scrollLeft;
    const destino =
      sentido === 1
        ? (posiciones.find((p) => p > actual + 4) ?? el.scrollWidth)
        : ([...posiciones].reverse().find((p) => p < actual - 4) ?? 0);
    const reducido = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ left: destino, behavior: reducido ? "auto" : "smooth" });
  };

  return (
    <div className={cx(s.rail, estado.desborda && s.desborda, className)}>
      <ul
        ref={pista}
        id={idPista}
        role="list"
        className={s.pista}
        aria-label={etiqueta}
      >
        {elementos.map((e) => (
          <li key={e.id} className={cx(s.pieza, e.principal && s.principal)}>
            {e.nodo}
          </li>
        ))}
      </ul>
      <div className={s.pie}>
        <div className={s.horizonte} aria-hidden="true">
          <span ref={carro} className={s.carro} />
        </div>
        <div className={s.controles}>
          <button
            type="button"
            className={s.boton}
            aria-controls={idPista}
            aria-disabled={estado.inicio}
            onClick={() => {
              if (!estado.inicio) mover(-1);
            }}
          >
            <IconoFlecha className={s.izquierda} />
            <span className="sr-only">Anterior</span>
          </button>
          <button
            type="button"
            className={s.boton}
            aria-controls={idPista}
            aria-disabled={estado.fin}
            onClick={() => {
              if (!estado.fin) mover(1);
            }}
          >
            <IconoFlecha />
            <span className="sr-only">Siguiente</span>
          </button>
        </div>
      </div>
    </div>
  );
}
