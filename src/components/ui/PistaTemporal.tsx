"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { IconoFlecha } from "./iconos.tsx";
import s from "./ReglaTemporal.module.css";

/**
 * Isla de la regla temporal: al hidratar, lleva la pista a **hoy** (sin
 * animación: es la posición de partida, no un movimiento) y ofrece Antes · Hoy ·
 * Después para ratón y teclado. En táctil se desliza con el dedo y encaja día
 * a día (`scroll-snap`).
 */
export function PistaTemporal({
  etiqueta,
  children,
}: {
  etiqueta: string;
  children: ReactNode;
}) {
  const id = useId();
  const pista = useRef<HTMLOListElement>(null);
  const [limites, setLimites] = useState({ inicio: true, fin: false });
  // Hoy es la posición de partida. Mientras nadie haya tocado la regla, se
  // mantiene aunque cambien las medidas (fuentes que llegan, giro del móvil).
  const tocada = useRef(false);

  useEffect(() => {
    const el = pista.current;
    if (!el) return;
    const alinear = () => {
      const hoy = el.querySelector<HTMLElement>("[data-hoy]");
      if (hoy && !tocada.current) el.scrollLeft = hoy.offsetLeft - relleno(el);
    };
    const marcarTocada = () => {
      tocada.current = true;
    };
    alinear();
    for (const evento of ["pointerdown", "wheel", "keydown", "touchstart"] as const)
      el.addEventListener(evento, marcarTocada, { passive: true, once: true });
    let marco = 0;
    const medir = () => {
      marco = 0;
      const maximo = el.scrollWidth - el.clientWidth;
      const inicio = el.scrollLeft <= 1;
      const fin = el.scrollLeft >= maximo - 1;
      setLimites((previo) =>
        previo.inicio === inicio && previo.fin === fin ? previo : { inicio, fin },
      );
    };
    const programar = () => {
      if (!marco) marco = requestAnimationFrame(medir);
    };
    medir();
    el.addEventListener("scroll", programar, { passive: true });
    const tamano = new ResizeObserver(() => {
      alinear();
      programar();
    });
    tamano.observe(el);
    return () => {
      cancelAnimationFrame(marco);
      for (const evento of ["pointerdown", "wheel", "keydown", "touchstart"] as const)
        el.removeEventListener(evento, marcarTocada);
      el.removeEventListener("scroll", programar);
      tamano.disconnect();
    };
  }, []);

  const ir = (destino: "antes" | "hoy" | "despues") => {
    const el = pista.current;
    if (!el) return;
    tocada.current = true;
    const dias = [...el.children] as HTMLElement[];
    const posiciones = dias.map((d) => d.offsetLeft - relleno(el));
    const actual = el.scrollLeft;
    let left: number;
    if (destino === "hoy") {
      const hoy = el.querySelector<HTMLElement>("[data-hoy]");
      left = hoy ? hoy.offsetLeft - relleno(el) : 0;
    } else if (destino === "despues") {
      left = posiciones.find((p) => p > actual + 4) ?? el.scrollWidth;
    } else {
      left = [...posiciones].reverse().find((p) => p < actual - 4) ?? 0;
    }
    const reducido = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ left, behavior: reducido ? "auto" : "smooth" });
  };

  return (
    <>
      <div className={s.cabeza}>
        <p className={s.leyenda} aria-hidden="true">
          <span className={s.leyendaPasado}>Pasado</span>
          <span className={s.leyendaHoy}>Hoy</span>
          <span className={s.leyendaFuturo}>Futuro</span>
        </p>
        <div className={s.controles}>
          <button
            type="button"
            className={s.control}
            aria-controls={id}
            aria-disabled={limites.inicio}
            onClick={() => {
              if (!limites.inicio) ir("antes");
            }}
          >
            <IconoFlecha className={s.izquierda} />
            <span>Antes</span>
          </button>
          <button
            type="button"
            className={s.control}
            aria-controls={id}
            onClick={() => ir("hoy")}
          >
            Hoy
          </button>
          <button
            type="button"
            className={s.control}
            aria-controls={id}
            aria-disabled={limites.fin}
            onClick={() => {
              if (!limites.fin) ir("despues");
            }}
          >
            <span>Después</span>
            <IconoFlecha />
          </button>
        </div>
      </div>
      <ol ref={pista} id={id} role="list" className={s.pista} aria-label={etiqueta}>
        {children}
      </ol>
    </>
  );
}

function relleno(el: HTMLElement): number {
  return parseFloat(getComputedStyle(el).scrollPaddingInlineStart) || 0;
}
