"use client";

import { Fragment, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import {
  alCambiarMisPlataformas,
  useMisPlataformas,
} from "@/features/mis-plataformas/estado.ts";

/**
 * Isla mínima de «Dónde verla»: recibe los grupos **ya renderizados en el
 * servidor** y solo cambia su orden para subir tus plataformas
 * (INFORMATION-ARCHITECTURE.md §6). El servidor manda el orden neutro; el
 * reordenado ocurre al hidratar y no cambia la altura del contenedor.
 *
 * Mover nodos del DOM mantiene el orden de lectura y de tabulación igual al
 * visual, cosa que `order` de CSS no haría.
 *
 * Cuando **tú** cambias la selección, los grupos se deslizan a su nuevo sitio
 * (FLIP con la Web Animations API, `--duration-reorder`): se ve qué ha subido y
 * por qué. El reordenado al cargar la página no se anima (nada se mueve solo),
 * y con movimiento reducido el cambio es instantáneo. El contenedor no cambia
 * de altura: ningún salto de maquetación.
 */
export function OfertasOrdenadas({
  grupos,
  validos,
  className,
}: {
  grupos: { plataformaId: string; nodo: ReactNode }[];
  validos: string[];
  className?: string | undefined;
}) {
  const { seleccion } = useMisPlataformas(validos);
  const lista = useRef<HTMLUListElement>(null);
  const posiciones = useRef(new Map<string, number>());
  const cambioDelUsuario = useRef(false);

  useEffect(
    () =>
      alCambiarMisPlataformas(() => {
        cambioDelUsuario.current = true;
      }),
    [],
  );

  const mias = new Set(seleccion);
  const ordenados =
    mias.size === 0
      ? grupos
      : [
          ...grupos.filter((g) => mias.has(g.plataformaId)),
          ...grupos.filter((g) => !mias.has(g.plataformaId)),
        ];
  const orden = ordenados.map((g) => g.plataformaId).join(" ");

  // Tras cada orden nuevo: medir, y si el cambio lo hizo alguien, animar desde
  // la posición anterior. `offsetTop` no depende del scroll de la página.
  useLayoutEffect(() => {
    const ul = lista.current;
    if (!ul) return;
    const anteriores = posiciones.current;
    const actuales = new Map<string, number>();
    const hijos = [...ul.children] as HTMLElement[];
    for (const hijo of hijos) {
      const id = hijo.dataset.plataforma;
      if (id) actuales.set(id, hijo.offsetTop);
    }
    const animar =
      cambioDelUsuario.current &&
      anteriores.size > 0 &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (animar) {
      // Los valores salen de los tokens (DS §5.2), no de literales.
      const estilo = getComputedStyle(ul);
      const duracion = parseFloat(estilo.getPropertyValue("--duration-reorder")) || 300;
      const curva = estilo.getPropertyValue("--ease-standard").trim() || "ease";
      for (const hijo of hijos) {
        const id = hijo.dataset.plataforma;
        const antes = id ? anteriores.get(id) : undefined;
        const ahora = id ? actuales.get(id) : undefined;
        if (antes === undefined || ahora === undefined || antes === ahora) continue;
        hijo.animate(
          [{ transform: `translateY(${antes - ahora}px)` }, { transform: "none" }],
          { duration: duracion, easing: curva },
        );
      }
    }
    cambioDelUsuario.current = false;
    posiciones.current = actuales;
  }, [orden]);

  return (
    <ul ref={lista} role="list" className={className}>
      {ordenados.map((g) => (
        <Fragment key={g.plataformaId}>{g.nodo}</Fragment>
      ))}
    </ul>
  );
}
