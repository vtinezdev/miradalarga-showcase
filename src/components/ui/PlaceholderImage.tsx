import type { TipoDeObra } from "@/features/catalogo/modelo.ts";
import { anios, tipoDeObra } from "@/features/catalogo/formato.ts";
import s from "./PlaceholderImage.module.css";

/**
 * El cartel tipográfico (VISUAL-DIRECTION.md §3.3): el placeholder editorial es
 * un activo de marca, no un hueco. Campo tonal y altura del horizonte se eligen
 * de forma **determinista** a partir del `id`, así que un mismo título siempre
 * tiene el mismo cartel y una fila de carteles no es monótona.
 *
 * Decorativo (`aria-hidden`): el título real siempre está como texto al lado.
 */
export function PlaceholderImage({
  id,
  titulo,
  tipo,
  anio,
  anioFin,
  proporcion,
}: {
  id: string;
  titulo: string;
  tipo: TipoDeObra;
  anio: number;
  anioFin?: number | undefined;
  proporcion: "poster" | "fondo";
}) {
  const semilla = hash(id);
  return (
    <div
      className={proporcion === "poster" ? s.poster : s.fondo}
      data-campo={(semilla % 4) + 1}
      data-horizonte={(Math.floor(semilla / 4) % 3) + 1}
      data-placeholder=""
      aria-hidden="true"
    >
      <span className={s.meta}>
        {tipoDeObra(tipo)} ·{" "}
        {anios(anioFin === undefined ? { anio } : { anio, anioFin })}
      </span>
      <span className={s.titulo}>{titulo}</span>
      <span className={s.horizonte} />
    </div>
  );
}

/** FNV-1a de 32 bits: estable entre servidor y cliente, sin dependencias. */
export function hash(texto: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
