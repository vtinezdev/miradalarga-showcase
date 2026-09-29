/**
 * El único contacto del adaptador con PostgreSQL: **ejecutar una consulta de
 * lectura y devolver sus filas**. Nada más sale de aquí.
 *
 * El repositorio de Neon recibe un `LectorSql` y no sabe qué driver hay
 * debajo:
 *
 * - **En la web**, `crearLectorHttp`: Neon por HTTP + Drizzle, el camino que el
 *   Spike 2 validó dentro del Worker (ADR 0002). Una petición HTTP por
 *   consulta, sin sesión, con el usuario de **solo lectura** del runtime
 *   (CLAUDE.md, regla 8; `docs/SECURITY.md`).
 * - **En la validación** (`scripts/validate-catalogo-neon.ts`), un lector sobre
 *   una sesión abierta con `default_transaction_read_only`.
 * - **En los tests**, un doble que devuelve filas fijas y guarda el SQL.
 *
 * Todas las consultas son `sql` de Drizzle **parametrizado**: ningún valor se
 * concatena en el texto (`docs/SECURITY.md`, «Consultas»).
 *
 * ⚠️ Solo servidor: este módulo lo importa `proveedor.ts`, que solo importan
 * las consultas de aplicación de los Server Components. Ningún Client
 * Component lo alcanza, y la cadena de conexión nunca se lee fuera de
 * `crearLectorHttp`.
 */
import { neon } from "@neondatabase/serverless";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";
import { ErrorDeCatalogo, comoErrorDeCatalogo } from "./errores.ts";

export interface LectorSql {
  /** Ejecuta una consulta de lectura. `operacion` da contexto a los errores. */
  leer<T>(operacion: string, consulta: SQL): Promise<T[]>;
}

/**
 * Comprueba la URL **sin imprimirla**: que parsea y que es PostgreSQL. No
 * decide si el usuario es de solo lectura —eso lo garantiza el rol en Neon—,
 * pero sí que no se ha colado otra cosa en la variable.
 */
export function validarUrlDeLectura(url: string | undefined): string {
  if (url === undefined || url.trim() === "") {
    throw new ErrorDeCatalogo(
      "configuracion",
      "conexion",
      "CATALOGO_FUENTE=neon exige DATABASE_URL (usuario de solo lectura del runtime).",
    );
  }
  let protocolo: string;
  try {
    protocolo = new URL(url).protocol;
  } catch {
    throw new ErrorDeCatalogo(
      "configuracion",
      "conexion",
      "DATABASE_URL no es una URL.",
    );
  }
  if (protocolo !== "postgres:" && protocolo !== "postgresql:") {
    throw new ErrorDeCatalogo(
      "configuracion",
      "conexion",
      "DATABASE_URL no es una URL de PostgreSQL.",
    );
  }
  return url;
}

export function crearLectorHttp(url: string): LectorSql {
  const db = drizzle(neon(validarUrlDeLectura(url)));
  return {
    async leer<T>(operacion: string, consulta: SQL): Promise<T[]> {
      try {
        const r = await db.execute(consulta);
        return r.rows as T[];
      } catch (error) {
        throw comoErrorDeCatalogo(operacion, error);
      }
    },
  };
}
