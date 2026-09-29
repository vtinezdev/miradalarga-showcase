import { cx } from "@/lib/cx.ts";
import { FechaRelativa } from "./FechaRelativa.tsx";
import s from "./FreshnessStamp.module.css";

/** «Comprobado hoy, 06:10»: igual en todas partes (DS §8.4, docs/SEO.md E-E-A-T). */
export function FreshnessStamp({
  instante,
  fuente,
  className,
}: {
  instante: string;
  fuente?: string;
  className?: string | undefined;
}) {
  return (
    <p className={cx(s.sello, className)}>
      Comprobado{" "}
      <time dateTime={instante}>
        <FechaRelativa instante={instante} />
      </time>
      {fuente ? <span className={s.fuente}> · Datos: {fuente}</span> : null}
    </p>
  );
}
