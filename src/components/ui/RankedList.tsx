import type { PosicionMejorValorada } from "@/features/catalogo/modelo.ts";
import { TitleRow } from "./TitleRow.tsx";
import s from "./RankedList.module.css";

/**
 * Ranking automático A (docs/RANKINGS.md). Una posición es un **ordinal**, nunca
 * una puntuación; la valoración que ordena es **ajena** y va pequeña y
 * atribuida. Sin firma, sin veredictos, sin vocabulario editorial.
 *
 * Si no hay elementos, el ranking no se publica: devuelve `null`.
 */
export function RankedList({
  posiciones,
  etiqueta,
}: {
  posiciones: readonly PosicionMejorValorada[];
  etiqueta: string;
}) {
  if (posiciones.length === 0) return null;
  return (
    <ol role="list" className={s.lista} aria-label={etiqueta}>
      {posiciones.map((p) => (
        <li key={p.titulo.id}>
          <TitleRow
            titulo={p.titulo}
            ordinal={p.posicion}
            miniatura={false}
            nota={
              <span className={s.valoracion}>
                <span className="cifras">{p.valoracion.valor}/100</span> · valoración
                externa ({p.valoracion.fuente})
              </span>
            }
          />
        </li>
      ))}
    </ol>
  );
}
