/**
 * Escritura idempotente por lotes.
 *
 * **`ON CONFLICT` sobre la clave natural**, nunca `DELETE` + `INSERT`: el
 * invariante 7 de `docs/DATA-MODEL.md` pide que la idempotencia la garantice la
 * base de datos y no el cuidado de quien escribe el pipeline.
 *
 * `RETURNING (xmax = 0)` distingue inserción de actualización. **No se mira el
 * avance de la secuencia**: `bigint identity` consume números aunque la fila
 * acabe en conflicto, así que una secuencia que avanza no prueba que se haya
 * escrito nada.
 *
 * Los lotes son multi-fila para no hacer 13.515 viajes de ida y vuelta. El
 * tamaño se elige por tabla para que ningún `INSERT` se acerque al techo de
 * 65.535 parámetros de PostgreSQL.
 */
import type { EjecutorSql, ResultadoDeTabla } from "./contratos.ts";

export interface EspecificacionDeUpsert {
  readonly tabla: string;
  readonly columnas: readonly string[];
  /** Constraint de conflicto, por nombre. Ninguno llega a los 63 bytes. */
  readonly constraint: string;
  /** Columnas a refrescar. Vacío → `DO NOTHING`. */
  readonly actualizar: readonly string[];
  /**
   * Columnas de `actualizar` que **solo pueden avanzar**:
   * `GREATEST(actual, nuevo)`. Son instantes de observación. Reprocesar una
   * observación antigua no puede hacerlos retroceder, porque de ellos depende
   * saber qué observaciones ya se aplicaron (`deltas/opciones.ts`).
   */
  readonly monotonas?: readonly string[];
  /** Columnas extra del `RETURNING`, para resolver identificadores. */
  readonly devolver?: readonly string[];
  readonly tamanoLote: number;
}

interface FilaDevuelta {
  readonly insertada: boolean;
  readonly [columna: string]: unknown;
}

export interface ResultadoDeUpsert {
  readonly resumen: ResultadoDeTabla;
  readonly devueltas: readonly FilaDevuelta[];
}

export async function upsert(
  ejecutor: EjecutorSql,
  spec: EspecificacionDeUpsert,
  filas: readonly (readonly unknown[])[],
  colapsadas = 0,
): Promise<ResultadoDeUpsert> {
  const devueltas: FilaDevuelta[] = [];
  let insertadas = 0;

  const extra = spec.devolver ?? [];
  const conflicto =
    spec.actualizar.length === 0
      ? `ON CONFLICT ON CONSTRAINT ${spec.constraint} DO NOTHING`
      : `ON CONFLICT ON CONSTRAINT ${spec.constraint} DO UPDATE SET ` +
        spec.actualizar
          .map((c) =>
            spec.monotonas?.includes(c) === true
              ? `"${c}" = GREATEST(${spec.tabla}."${c}", EXCLUDED."${c}")`
              : `"${c}" = EXCLUDED."${c}"`,
          )
          .join(", ");

  for (let desde = 0; desde < filas.length; desde += spec.tamanoLote) {
    const lote = filas.slice(desde, desde + spec.tamanoLote);
    const valores: unknown[] = [];
    const tuplas = lote.map((fila) => {
      const marcadores = fila.map((valor) => {
        valores.push(valor);
        return `$${String(valores.length)}`;
      });
      return `(${marcadores.join(", ")})`;
    });

    const texto =
      `INSERT INTO ${spec.tabla} (${spec.columnas.map((c) => `"${c}"`).join(", ")})\n` +
      `VALUES ${tuplas.join(", ")}\n` +
      `${conflicto}\n` +
      `RETURNING (xmax = 0) AS insertada${extra.length ? ", " + extra.map((c) => `"${c}"`).join(", ") : ""}`;

    const salida = await ejecutor.ejecutar<FilaDevuelta>(texto, valores);
    for (const fila of salida) {
      devueltas.push(fila);
      if (fila.insertada) insertadas++;
    }
  }

  const devueltasTotales = devueltas.length;
  // Con DO NOTHING, una fila en conflicto no vuelve: la diferencia es lo
  // ignorado. Con DO UPDATE vuelven todas, así que la diferencia es cero.
  const ignoradas = filas.length - devueltasTotales;

  return {
    devueltas,
    resumen: {
      tabla: spec.tabla,
      intentadas: filas.length,
      insertadas,
      actualizadas: devueltasTotales - insertadas,
      ignoradas,
      colapsadas,
    },
  };
}
