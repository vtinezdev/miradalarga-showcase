/**
 * Una conexión **directa** a PostgreSQL para un job: una sesión de verdad,
 * no el pooler.
 *
 * Los advisory locks de sesión (`bloqueo.ts`) exigen que la sesión que tomó el
 * lock sea la misma que sigue viva después; un pooler en modo transacción no
 * lo garantiza. Por eso aquí se usa `Client` —una sesión por WebSocket— y no
 * el driver HTTP. Que la URL no sea la del pooler lo garantizan las guardas
 * de destino, **antes** de llamar aquí.
 *
 * Nunca se imprime la cadena de conexión: un error de conexión sale saneado.
 */
import { Client, neonConfig } from "@neondatabase/serverless";

import type { EjecutorSql } from "./contratos.ts";
import { sanearTexto } from "./diagnostico.ts";

export interface Conexion {
  readonly ejecutor: EjecutorSql;
  cerrar(): Promise<void>;
}

export async function conectar(url: string): Promise<Conexion> {
  if (typeof WebSocket === "undefined") {
    throw new Error("Este Node no expone WebSocket global, y Neon lo necesita.");
  }
  neonConfig.webSocketConstructor = WebSocket;

  const cliente = new Client(url);
  // Un error asíncrono de la sesión no puede tumbar el proceso a destiempo:
  // lo recoge la próxima consulta, que falla y cierra la ejecución.
  cliente.on("error", () => undefined);
  try {
    await cliente.connect();
  } catch (error) {
    const m = error instanceof Error ? error.message : String(error);
    throw new Error(`No se pudo conectar: ${sanearTexto(m)}`);
  }
  return {
    ejecutor: {
      async ejecutar<T>(texto: string, valores: readonly unknown[] = []) {
        const r: { rows: unknown[] } = await cliente.query(texto, [...valores]);
        return r.rows as readonly T[];
      },
    },
    async cerrar() {
      await cliente.end().catch(() => undefined);
    },
  };
}
