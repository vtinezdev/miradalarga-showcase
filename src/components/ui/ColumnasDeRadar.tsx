import type { ColumnaDeRadar } from "@/features/catalogo/consultas-hubs.ts";
import { FilaDeMovimiento } from "./FilaDeMovimiento.tsx";
import { PestanasResponsive } from "./PestanasResponsive.tsx";
import s from "./ColumnasDeRadar.module.css";

const TITULO: Record<ColumnaDeRadar["tipo"], string> = {
  llega: "Acaba de llegar",
  "se-va": "Se va pronto",
  proximamente: "Próximamente",
};

/**
 * El radar de un hub en tres columnas —Acaba de llegar · Se va pronto ·
 * Próximamente—, vertical y escaneable: en los hubs se lee como índice, no se
 * recorre en el tiempo (la regla temporal es de la portada y de `/radar`).
 *
 * Cada columna dice **por qué** está vacía o qué no cubre, con la frase ya
 * redactada por la consulta: no soportado, no medido o ausencia real
 * (INFORMATION-ARCHITECTURE.md §7). En móvil y tableta, pestañas; el HTML trae
 * las tres.
 */
export function ColumnasDeRadar({
  columnas,
  etiqueta,
}: {
  columnas: readonly ColumnaDeRadar[];
  etiqueta: string;
}) {
  return (
    <PestanasResponsive
      etiqueta={etiqueta}
      // Tres columnas solo caben desde escritorio; en tableta quedaban 2 + 1.
      hasta="64rem"
      paneles={columnas.map((c) => ({
        id: c.tipo,
        titulo: TITULO[c.tipo],
        contenido: (
          <div className={s.columna}>
            {c.filas.length > 0 ? (
              <ul role="list" className={s.filas}>
                {c.filas.map((f) => (
                  <li
                    key={`${f.movimiento.tipo}-${f.titulo.id}-${f.movimiento.plataforma.id}`}
                  >
                    <FilaDeMovimiento fila={f} />
                  </li>
                ))}
              </ul>
            ) : null}
            {c.nota ? (
              <p className={c.filas.length > 0 ? s.nota : s.vacia}>{c.nota}</p>
            ) : null}
          </div>
        ),
      }))}
    />
  );
}
