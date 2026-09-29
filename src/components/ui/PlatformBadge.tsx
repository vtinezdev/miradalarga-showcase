import type { Plataforma } from "@/features/catalogo/modelo.ts";
import { cx } from "@/lib/cx.ts";
import s from "./PlatformBadge.module.css";

/**
 * Nombre de plataforma como chip neutro, sin colores corporativos (BRAND.md §7).
 *
 * Si la plataforma está en Mis plataformas, el CSS generado en el layout activa
 * `--mia-*` sobre `[data-plataforma]`: aparece el punto latón y el texto
 * accesible «, en tus plataformas». Sin JavaScript de React y sin mover nada.
 */
export function PlatformBadge({
  plataforma,
  tamano = "s",
}: {
  plataforma: Plataforma;
  tamano?: "s" | "m";
}) {
  return (
    <span
      className={cx(s.badge, tamano === "m" && s.m)}
      data-plataforma={plataforma.id}
    >
      <span className={s.punto} aria-hidden="true" />
      {plataforma.nombre}
      <span className={s.mia}>, en tus plataformas</span>
    </span>
  );
}

/** Chips de las plataformas de una lista de ofertas, sin repetir plataforma. */
export function PlatformBadges({
  plataformas,
}: {
  plataformas: readonly Plataforma[];
}) {
  const unicas = [...new Map(plataformas.map((p) => [p.id, p])).values()];
  if (unicas.length === 0) return null;
  return (
    <ul role="list" className={s.lista} aria-label="Disponible en">
      {unicas.map((p) => (
        <li key={p.id}>
          <PlatformBadge plataforma={p} />
        </li>
      ))}
    </ul>
  );
}
