"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import s from "./Header.module.css";

/**
 * El titulillo de revista en la cabecera: el nombre de la sección que se está
 * leyendo («Radar del catálogo»). Lo declaran las secciones con `data-folio`.
 *
 * Es **decorativo** (`aria-hidden`): los encabezados ya dicen dónde estás. Solo
 * observa con `IntersectionObserver`, sin escuchar el scroll: nada se recalcula
 * mientras nada cruza la franja superior. Sin JavaScript, simplemente no hay folio.
 */
export function FolioCorrido() {
  // La cabecera vive en el layout: al navegar hay que observar las secciones
  // nuevas, y el folio de la página anterior deja de valer.
  const ruta = usePathname();
  const [leido, setLeido] = useState({ ruta, folio: "" });
  const folio = leido.ruta === ruta ? leido.folio : "";

  useEffect(() => {
    const secciones = [...document.querySelectorAll<HTMLElement>("main [data-folio]")];
    if (secciones.length === 0) return;
    const visibles = new Set<HTMLElement>();
    const alto =
      document.querySelector("body > header")?.getBoundingClientRect().height ?? 56;
    const observador = new IntersectionObserver(
      (cambios) => {
        for (const c of cambios) {
          const el = c.target as HTMLElement;
          if (c.isIntersecting) visibles.add(el);
          else visibles.delete(el);
        }
        // La última en orden de documento que toca la franja bajo la cabecera.
        const actual = secciones.filter((el) => visibles.has(el)).at(-1);
        setLeido({ ruta, folio: actual?.dataset.folio ?? "" });
      },
      // Franja fina justo bajo la cabecera: la sección que la ocupa es la que se lee.
      { rootMargin: `-${Math.round(alto) + 1}px 0px -80% 0px` },
    );
    for (const el of secciones) observador.observe(el);
    return () => observador.disconnect();
  }, [ruta]);

  return (
    <span className={s.folio} aria-hidden="true">
      {folio ? (
        <span key={folio} className={s.textoFolio}>
          {folio}
        </span>
      ) : null}
    </span>
  );
}
