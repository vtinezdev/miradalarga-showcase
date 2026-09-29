import type { ComponentType } from "react";
import type { Movimiento, TipoDeMovimiento } from "@/features/catalogo/modelo.ts";
import { fechaConAnio, fechaCorta } from "@/lib/fechas.ts";
import { cx } from "@/lib/cx.ts";
import {
  IconoCalendario,
  IconoCambio,
  IconoLlega,
  IconoReloj,
  IconoSale,
} from "./iconos.tsx";
import s from "./CatalogEvent.module.css";

const ICONO: Record<TipoDeMovimiento, ComponentType> = {
  llega: IconoLlega,
  "se-va": IconoReloj,
  proximamente: IconoCalendario,
  "se-fue": IconoSale,
  cambio: IconoCambio,
};

/** El icono de un tipo de movimiento, el mismo en todo el sitio. */
export function IconoDeMovimiento({ tipo }: { tipo: TipoDeMovimiento }) {
  const Icono = ICONO[tipo];
  return <Icono />;
}

/**
 * Un movimiento del catálogo, con icono **y** texto y el color de su estado
 * (DS §1.3). El latón nunca representa un estado.
 *
 * `contexto="ficha"` cuenta la historia del título («En Netflix desde el 3 mar
 * 2024»); `contexto="radar"`, la noticia («Nuevo en Netflix · 26 sep»).
 */
export function CatalogEvent({
  movimiento,
  contexto = "radar",
  className,
}: {
  movimiento: Movimiento;
  contexto?: "radar" | "ficha";
  className?: string | undefined;
}) {
  const Icono = ICONO[movimiento.tipo];
  return (
    <span className={cx(s.evento, className)} data-tipo={movimiento.tipo}>
      <Icono />
      <span>{texto(movimiento, contexto)}</span>
    </span>
  );
}

function texto(m: Movimiento, contexto: "radar" | "ficha") {
  const p = m.plataforma.nombre;
  const fecha = (
    <time dateTime={m.fecha}>
      {contexto === "ficha" ? fechaConAnio(m.fecha) : fechaCorta(m.fecha)}
    </time>
  );
  switch (m.tipo) {
    case "llega":
      return contexto === "ficha" ? (
        <>
          En {p} desde el {fecha}
        </>
      ) : (
        <>
          Nuevo en {p} · {fecha}
        </>
      );
    case "se-va":
      return (
        <>
          Se va de {p} el {fecha}
        </>
      );
    case "proximamente":
      return (
        <>
          Llega a {p} el {fecha}
        </>
      );
    case "se-fue":
      return (
        <>
          Salió de {p} el {fecha}
        </>
      );
    case "cambio":
      return (
        <>
          {m.detalle ?? "Cambio en la oferta"} en {p} · {fecha}
        </>
      );
  }
}
