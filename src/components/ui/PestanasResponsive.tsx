"use client";

import {
  useCallback,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cx } from "@/lib/cx.ts";
import s from "./PestanasResponsive.module.css";

/**
 * Columnas que en pantallas estrechas se convierten en pestañas (SCREENS.md
 * §1): radar y rankings de la portada.
 *
 * - El servidor, y el navegador sin JavaScript, pintan **todas las columnas**
 *   apiladas con su `h3`: nada queda escondido sin forma de verlo.
 * - Por debajo del punto de corte, al hidratar, aparecen las pestañas con la
 *   semántica completa de WAI-ARIA (flechas, Inicio, Fin). Por encima no hay
 *   pestañas ni roles de pestaña: son columnas.
 *
 * El contenido de todos los paneles viaja en el HTML: cambiar de pestaña no
 * pide nada al servidor.
 */
export function PestanasResponsive({
  etiqueta,
  paneles,
  hasta,
  className,
}: {
  etiqueta: string;
  paneles: { id: string; titulo: string; contenido: ReactNode }[];
  /** Ancho a partir del cual se ven como columnas. */
  hasta: "48rem" | "64rem";
  className?: string | undefined;
}) {
  const consulta =
    hasta === "64rem" ? "(max-width: 63.98rem)" : "(max-width: 47.98rem)";
  const suscribir = useCallback(
    (avisar: () => void) => {
      const mq = window.matchMedia(consulta);
      mq.addEventListener("change", avisar);
      return () => mq.removeEventListener("change", avisar);
    },
    [consulta],
  );
  const estrecho = useSyncExternalStore(
    suscribir,
    () => window.matchMedia(consulta).matches,
    () => false,
  );
  const [activa, setActiva] = useState(0);
  const base = useId();
  const pestanas = useRef<(HTMLButtonElement | null)[]>([]);

  const alTeclado = (evento: KeyboardEvent<HTMLButtonElement>) => {
    const ultimo = paneles.length - 1;
    const destino =
      evento.key === "ArrowRight"
        ? activa === ultimo
          ? 0
          : activa + 1
        : evento.key === "ArrowLeft"
          ? activa === 0
            ? ultimo
            : activa - 1
          : evento.key === "Home"
            ? 0
            : evento.key === "End"
              ? ultimo
              : null;
    if (destino === null) return;
    evento.preventDefault();
    setActiva(destino);
    pestanas.current[destino]?.focus();
  };

  return (
    <div className={cx(s.contenedor, estrecho ? s.pestanas : s.columnas, className)}>
      {estrecho ? (
        <div role="tablist" aria-label={etiqueta} className={s.lista}>
          {paneles.map((p, i) => (
            <button
              key={p.id}
              ref={(nodo) => {
                pestanas.current[i] = nodo;
              }}
              type="button"
              role="tab"
              id={`${base}-pestana-${p.id}`}
              aria-controls={`${base}-panel-${p.id}`}
              aria-selected={i === activa}
              tabIndex={i === activa ? 0 : -1}
              className={s.pestana}
              onClick={() => setActiva(i)}
              onKeyDown={alTeclado}
            >
              {p.titulo}
            </button>
          ))}
        </div>
      ) : null}
      {paneles.map((p, i) => (
        <section
          key={p.id}
          className={s.panel}
          {...(estrecho
            ? {
                role: "tabpanel",
                id: `${base}-panel-${p.id}`,
                "aria-labelledby": `${base}-pestana-${p.id}`,
                hidden: i !== activa,
                tabIndex: 0,
              }
            : { "aria-labelledby": `${base}-titulo-${p.id}` })}
        >
          <h3 id={`${base}-titulo-${p.id}`} className={estrecho ? "sr-only" : s.titulo}>
            {p.titulo}
          </h3>
          {p.contenido}
        </section>
      ))}
    </div>
  );
}
