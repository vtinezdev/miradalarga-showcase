/**
 * Dobles para probar `deltas` **en modo real** sin base de datos: dos
 * conexiones —ops y datos— sobre la misma tabla `ops_sync_runs`.
 *
 * Lo compartido entre `deltas-checkpoint.test.ts` y
 * `deltas-programado.test.ts`. Lo que un doble no puede demostrar —que Neon
 * se porta así— lo mide `pnpm db:validate:checkpoint`.
 */
import type { EjecutorSql } from "../../jobs/ops/contratos.ts";
import type { LibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import type { BaseEnMemoria } from "./base-en-memoria.ts";

/**
 * La conexión de DATOS: transacciones de verdad sobre `base`, y lo que toque
 * `ops_sync_runs` se aplica al libro **solo al confirmar**. Dentro de la
 * transacción, el `UPDATE … RETURNING id` ve la fila viva y devuelve su id,
 * como PostgreSQL.
 */
export function conexionDeDatos(
  base: BaseEnMemoria,
  libro: LibroEnMemoria,
  opciones: { fallarAlEscribirCheckpoint?: () => boolean } = {},
) {
  let pendientes: { texto: string; valores: readonly unknown[] }[] = [];
  const control: string[] = [];
  const ejecutor: EjecutorSql = {
    async ejecutar<T>(texto: string, valores: readonly unknown[] = []) {
      const t = texto.trim();
      if (t === "BEGIN") {
        control.push(t);
        pendientes = [];
        return base.ejecutor.ejecutar<T>(texto, valores);
      }
      if (t === "COMMIT") {
        control.push(t);
        const r = await base.ejecutor.ejecutar<T>(texto, valores);
        for (const p of pendientes) await libro.ejecutor.ejecutar(p.texto, p.valores);
        pendientes = [];
        return r;
      }
      if (t === "ROLLBACK") {
        control.push(t);
        pendientes = [];
        return base.ejecutor.ejecutar<T>(texto, valores);
      }
      if (t.includes("ops_sync_runs")) {
        control.push("checkpoint");
        if (opciones.fallarAlEscribirCheckpoint?.() === true) {
          throw new Error("fallo inyectado al escribir el checkpoint");
        }
        const viva = libro.filas.find(
          (f) => f.id === Number(valores[0]) && f.status === "running",
        );
        if (viva === undefined) return [] as readonly T[];
        pendientes.push({ texto, valores });
        return [{ id: viva.id }] as unknown as readonly T[];
      }
      control.push("datos");
      return base.ejecutor.ejecutar<T>(texto, valores);
    },
  };
  return { ejecutor, control };
}
