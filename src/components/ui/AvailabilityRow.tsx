import type { Oferta, OfertaResumida, Plataforma } from "@/features/catalogo/modelo.ts";
import { calidad, describirOferta } from "@/features/catalogo/formato.ts";
import { compararTiposDeOferta } from "@/features/catalogo/reglas.ts";
import { cx } from "@/lib/cx.ts";
import { CatalogEvent } from "./CatalogEvent.tsx";
import { IconoExterno } from "./iconos.tsx";
import { PlatformBadge } from "./PlatformBadge.tsx";
import s from "./AvailabilityRow.module.css";

/**
 * Las ofertas de **una** plataforma, en su forma completa (ficha): tipo en
 * palabras, precio/calidad/idiomas **solo si los tenemos** (docs/DATA-SOURCES.md
 * §1.1), fecha de salida si la hay y un enlace explícito a la plataforma.
 */
export function AvailabilityRow({
  plataforma,
  ofertas,
}: {
  plataforma: Plataforma;
  ofertas: readonly Oferta[];
}) {
  const enlace = ofertas[0]?.enlace;
  return (
    <li className={s.grupo} data-plataforma={plataforma.id}>
      <p className={s.cabeza}>
        <span className={s.punto} aria-hidden="true" />
        <span className={s.nombre}>{plataforma.nombre}</span>
        <span className={s.tuya}>En tus plataformas</span>
      </p>
      <ul role="list" className={s.ofertas}>
        {ofertas.map((oferta) => (
          <li key={`${oferta.tipo}-${oferta.addon?.id ?? ""}`} className={s.oferta}>
            <span className={s.tipo}>{describirOferta(oferta)}</span>
            <Detalles oferta={oferta} />
            {oferta.disponibleHasta ? (
              <CatalogEvent
                movimiento={{
                  tipo: "se-va",
                  tituloId: "",
                  plataforma,
                  fecha: oferta.disponibleHasta,
                }}
              />
            ) : null}
          </li>
        ))}
      </ul>
      {enlace ? (
        <a className={s.ver} href={enlace} rel="noopener" target="_blank">
          Ver en {plataforma.nombre}
          <IconoExterno />
          <span className="sr-only">
            {" "}
            (abre la web de {plataforma.nombre} en otra pestaña)
          </span>
        </a>
      ) : null}
    </li>
  );
}

function Detalles({ oferta }: { oferta: Oferta }) {
  const partes: string[] = [];
  if (oferta.calidad) partes.push(calidad(oferta.calidad));
  if (oferta.idiomas?.audio.length)
    partes.push(`Audio: ${oferta.idiomas.audio.join(", ")}`);
  if (oferta.idiomas?.subtitulos.length)
    partes.push(`Subtítulos: ${oferta.idiomas.subtitulos.join(", ")}`);
  if (partes.length === 0) return null;
  return <span className={s.detalles}>{partes.join(" · ")}</span>;
}

/**
 * Forma compacta (hero, listas): una línea por plataforma con su mejor oferta.
 * Sin disponibilidad, lo dice (regla 7: no rellenar).
 */
export function AvailabilityCompact({
  ofertas,
  maximo = 2,
  className,
}: {
  ofertas: readonly OfertaResumida[];
  maximo?: number;
  className?: string | undefined;
}) {
  const mejores = new Map<string, OfertaResumida>();
  for (const o of [...ofertas].sort((a, b) => compararTiposDeOferta(a.tipo, b.tipo))) {
    if (!mejores.has(o.plataforma.id)) mejores.set(o.plataforma.id, o);
  }
  const lista = [...mejores.values()];
  if (lista.length === 0) {
    return (
      <p className={cx(s.sinOfertas, className)}>
        No está en ninguna plataforma ahora mismo
      </p>
    );
  }
  const visibles = lista.slice(0, maximo);
  const resto = lista.length - visibles.length;
  return (
    <ul role="list" className={cx(s.compacta, className)} aria-label="Dónde verla">
      {visibles.map((o) => (
        <li key={o.plataforma.id}>
          <PlatformBadge plataforma={o.plataforma} />
          <span className={s.tipoCompacto}>{describirOferta(o)}</span>
        </li>
      ))}
      {resto > 0 ? (
        <li className={s.resto}>
          y {resto === 1 ? "1 plataforma más" : `${resto} plataformas más`}
        </li>
      ) : null}
    </ul>
  );
}
