import type { ReactNode } from "react";
import type { FilaDeRadar } from "@/features/catalogo/consultas.ts";
import type { TipoDeMovimiento } from "@/features/catalogo/modelo.ts";
import { anios, rutaDeFicha, tipoDeObra } from "@/features/catalogo/formato.ts";
import { diaEnMadrid } from "@/lib/fechas.ts";
import { cx } from "@/lib/cx.ts";
import { CatalogEvent } from "./CatalogEvent.tsx";
import { Enlace } from "./Enlace.tsx";
import { EtiquetaDeDia } from "./EtiquetaDeDia.tsx";
import { PistaTemporal } from "./PistaTemporal.tsx";
import s from "./ReglaTemporal.module.css";

/** Dentro de un día: primero lo que ya pasó, después lo anunciado. */
const ORDEN: Record<TipoDeMovimiento, number> = {
  llega: 0,
  "se-fue": 1,
  cambio: 2,
  "se-va": 3,
  proximamente: 4,
};

type Momento = "pasado" | "hoy" | "futuro";

function momentoDe(dia: string, hoy: string): Momento {
  return dia < hoy ? "pasado" : dia === hoy ? "hoy" : "futuro";
}

/**
 * El radar como **regla temporal** (interacción de firma 5): pasado ← HOY →
 * futuro. Una pieza editorial, no un panel: cada día es una columna con su
 * fecha y sus movimientos, y la línea del horizonte los une. El pasado es una
 * línea continua; el futuro, discontinua (aún no ha ocurrido); hoy, el punto
 * latón.
 *
 * Sirve los cinco tipos de movimiento, cada uno con su icono, texto y tono
 * (DS §1.3): el latón nunca es un estado, solo marca **hoy**.
 *
 * «Hoy» es el día de la **edición** (`referencia`), que el servidor conoce; el
 * nombre relativo («Hoy», «Ayer») lo pone el navegador, porque el HTML se
 * cachea. Todo el contenido está en el HTML, en orden cronológico: sin
 * JavaScript es una lista con scroll horizontal; la isla solo centra hoy y
 * añade los botones.
 */
export function ReglaTemporal({
  filas,
  referencia,
  etiqueta,
  notas,
}: {
  filas: readonly FilaDeRadar[];
  referencia: string;
  etiqueta: string;
  notas?: ReactNode;
}) {
  const hoy = diaEnMadrid(referencia);
  const porDia = new Map<string, FilaDeRadar[]>([[hoy, []]]);
  for (const f of filas) {
    const dia = diaEnMadrid(f.movimiento.fecha);
    porDia.set(dia, [...(porDia.get(dia) ?? []), f]);
  }
  const dias = [...porDia.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dia, delDia]) => ({
      dia,
      momento: momentoDe(dia, hoy),
      filas: [...delDia].sort(
        (a, b) =>
          Number(b.enListas) - Number(a.enListas) ||
          ORDEN[a.movimiento.tipo] - ORDEN[b.movimiento.tipo],
      ),
    }));

  return (
    <div className={s.regla}>
      <PistaTemporal etiqueta={etiqueta}>
        {dias.map(({ dia, momento, filas: delDia }) => (
          <li
            key={dia}
            className={cx(s.dia, s[momento])}
            data-hoy={momento === "hoy" ? "" : undefined}
          >
            <span className={s.marca} aria-hidden="true" />
            <h3 className={s.fecha}>
              <time dateTime={dia}>
                <EtiquetaDeDia dia={dia} />
              </time>
            </h3>
            {delDia.length > 0 ? (
              <ul role="list" className={s.eventos}>
                {delDia.map((f) => (
                  <li
                    key={`${f.movimiento.tipo}-${f.titulo.id}-${f.movimiento.plataforma.id}`}
                    className={s.evento}
                    data-tipo={f.movimiento.tipo}
                  >
                    <CatalogEvent movimiento={f.movimiento} />
                    <p className={s.titulo}>
                      <Enlace href={rutaDeFicha(f.titulo)}>{f.titulo.titulo}</Enlace>
                    </p>
                    <p className={s.meta}>
                      {tipoDeObra(f.titulo.tipo)} · {anios(f.titulo)}
                      {f.enListas ? (
                        <span className={s.enListas}> · En nuestras listas</span>
                      ) : null}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={s.vacio}>Nada registrado este día.</p>
            )}
          </li>
        ))}
      </PistaTemporal>
      {notas ? <div className={s.notas}>{notas}</div> : null}
    </div>
  );
}
