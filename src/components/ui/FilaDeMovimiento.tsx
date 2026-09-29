import type { FilaDeRadar } from "@/features/catalogo/consultas.ts";
import { cx } from "@/lib/cx.ts";
import { CatalogEvent } from "./CatalogEvent.tsx";
import { TitleRow } from "./TitleRow.tsx";
import s from "./FilaDeMovimiento.module.css";

/**
 * Un movimiento del catálogo como fila de índice: el estado (icono, texto y
 * tono) encima del título y, si está en nuestras listas, dicho con texto. «Se
 * fue» pesa menos que el resto (SCREENS.md §4).
 */
export function FilaDeMovimiento({ fila }: { fila: FilaDeRadar }) {
  return (
    <TitleRow
      className={cx(fila.movimiento.tipo === "se-fue" && s.seFue)}
      titulo={fila.titulo}
      nota={
        <>
          <CatalogEvent movimiento={fila.movimiento} />
          {fila.enListas ? (
            <span className={s.enListas}> · En nuestras listas</span>
          ) : null}
        </>
      }
    />
  );
}
