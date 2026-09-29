/**
 * **Las guardas de `production`** (ADR 0010). Hermanas de las de
 * `drizzle.migrate.config.ts`, pero **con otras variables**: una sesión de
 * validación no puede alcanzar `production` ni por error, y una de
 * `production` no puede ejecutar por error una herramienta de validación.
 *
 *   | Validación                | `production`                      |
 *   |---------------------------|-----------------------------------|
 *   | `DATABASE_URL_DIRECT`     | `PRODUCTION_DATABASE_URL_DIRECT`  |
 *   | `NEON_VALIDATION_HOST`    | `NEON_PRODUCTION_HOST`            |
 *   | `MIGRATION_TARGET`        | `PRODUCTION_TARGET=production`    |
 *
 * ⚖️ **Las dos familias no conviven**: `verificarDestinoDeProduction` se niega
 * si hay alguna variable de validación en el entorno, y `verificarDestino` se
 * niega si hay alguna de `production`. Ninguna vive en `.env` ni en el
 * repositorio: solo en la sesión de quien opera.
 *
 * Estas guardas dicen **a qué** base se conecta el proceso. **Qué** puede
 * hacerle lo dice la autorización en código
 * (`jobs/ops/autorizacion-de-production.ts`), que hoy está vacía.
 *
 * Módulo **puro**: no corre nada al importarse (a diferencia de
 * `drizzle.migrate.config.ts`, que no se importa desde una sesión de
 * `production` porque sus guardas de validación abortarían).
 */

/** El nombre de la rama de Neon. No es, ni puede ser, un destino de validación. */
export const DESTINO_PRODUCTION = "production";

/** Las variables de una sesión de `production`. */
export const VARIABLES_DE_PRODUCTION = [
  "PRODUCTION_DATABASE_URL_DIRECT",
  "NEON_PRODUCTION_HOST",
  "PRODUCTION_TARGET",
] as const;

/** Las variables de una sesión de validación. */
export const VARIABLES_DE_VALIDACION = [
  "DATABASE_URL_DIRECT",
  "NEON_VALIDATION_HOST",
  "MIGRATION_TARGET",
] as const;

const MARCA_POOLER = "-pooler";

export interface DestinoDeProduction {
  /** La cadena completa. **Nunca se imprime.** */
  readonly url: string;
  readonly hostname: string;
  readonly esConexionDirecta: true;
  readonly rama: typeof DESTINO_PRODUCTION;
}

type Entorno = Readonly<Partial<Record<string, string>>>;

const definida = (entorno: Entorno, v: string): boolean =>
  (entorno[v] ?? "").trim() !== "";

/** Las variables de esa familia que vienen definidas en el entorno. */
export function variablesDefinidas(
  entorno: Entorno,
  familia: readonly string[],
): readonly string[] {
  return familia.filter((v) => definida(entorno, v));
}

function fallar(motivo: string): never {
  throw new Error(
    `production: abortado antes de conectar.\n  ${motivo}\n` +
      "  Ninguna comprobación puede saltarse.",
  );
}

/**
 * Los cinco cerrojos de `production`. Se prueban con un entorno falso.
 *
 *   0. ninguna variable de validación en la sesión;
 *   1. `PRODUCTION_DATABASE_URL_DIRECT` existe y es una URL;
 *   2. conexión **directa** (sin `-pooler`);
 *   3. hostname **exactamente** `NEON_PRODUCTION_HOST`;
 *   4. `PRODUCTION_TARGET` **exactamente** `production`.
 */
export function verificarDestinoDeProduction(
  entorno: Entorno = process.env,
): DestinoDeProduction {
  const mezcladas = variablesDefinidas(entorno, VARIABLES_DE_VALIDACION);
  if (mezcladas.length > 0) {
    fallar(
      `La sesión lleva variables de validación (${mezcladas.join(", ")}). ` +
        "Una sesión de production solo lleva las suyas.",
    );
  }

  const bruta = entorno.PRODUCTION_DATABASE_URL_DIRECT;
  if (bruta === undefined || bruta.trim() === "") {
    fallar("Falta PRODUCTION_DATABASE_URL_DIRECT. Solo en la sesión, nunca en .env.");
  }
  let url: URL;
  try {
    url = new URL(bruta);
  } catch {
    fallar("PRODUCTION_DATABASE_URL_DIRECT no es una URL válida. (No se muestra.)");
  }
  const { hostname } = url;

  if (hostname.includes(MARCA_POOLER) || bruta.includes(MARCA_POOLER)) {
    fallar(`El destino usa el pooler ("${MARCA_POOLER}"): se exige conexión directa.`);
  }

  const esperado = (entorno.NEON_PRODUCTION_HOST ?? "").trim();
  if (esperado === "") {
    fallar(
      "Falta NEON_PRODUCTION_HOST: sin él no hay contra qué contrastar el destino.",
    );
  }
  if (hostname !== esperado) {
    fallar(
      `El hostname del destino no coincide con NEON_PRODUCTION_HOST.\n` +
        `  destino:  ${hostname}\n  esperado: ${esperado}`,
    );
  }

  if (entorno.PRODUCTION_TARGET !== DESTINO_PRODUCTION) {
    fallar(
      `PRODUCTION_TARGET debe valer exactamente "${DESTINO_PRODUCTION}".\n` +
        `  valor actual: ${entorno.PRODUCTION_TARGET ?? "(ausente)"}`,
    );
  }

  return { url: bruta, hostname, esConexionDirecta: true, rama: DESTINO_PRODUCTION };
}
