import type { Autor } from "@/features/catalogo/modelo.ts";
import { fechaCorta } from "@/lib/fechas.ts";
import { cx } from "@/lib/cx.ts";
import s from "./Signature.module.css";
import { Enlace } from "./Enlace.tsx";

/**
 * Firma y fecha de revisión de lo editorial (C). **Nunca** en un ranking: si hay
 * firma hay criterio humano, y eso tiene que ser evidente (docs/RANKINGS.md).
 */
export function Signature({
  autor,
  revisada,
  className,
}: {
  autor: Autor;
  revisada: string;
  className?: string | undefined;
}) {
  return (
    <p className={cx(s.firma, className)}>
      Por <Enlace href={`/autores/${autor.slug}`}>{autor.nombre}</Enlace> · revisada el{" "}
      <time dateTime={revisada}>{fechaCorta(revisada)}</time>
    </p>
  );
}
