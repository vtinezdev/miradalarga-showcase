/**
 * Configuración de drizzle-kit **para aplicar migraciones**. Solo la usa
 * `db:migrate:validation`.
 *
 * `drizzle.config.ts` sigue siendo **completamente offline** y es el único que
 * usan `db:generate` y `db:check`: no lee ninguna variable de entorno y no
 * puede conectarse a nada. Este fichero es la única puerta con credenciales, y
 * está cerrada con cuatro cerrojos.
 *
 * **Las guardas corren al importar el módulo**, antes de que drizzle-kit haya
 * podido abrir un socket. Si alguna falla, el proceso muere sin conectarse.
 *
 * Nada de esto se configura en el repositorio: ni un hostname, ni una
 * contraseña, ni una cadena de conexión. Las tres variables viven solo en la
 * sesión de quien ejecuta la migración, y **`DATABASE_URL_DIRECT` no está ni
 * puede estar en `.env`** — el build copia `.env` a `dist/server/.dev.vars`
 * (`docs/SECURITY.md`).
 */
import { defineConfig } from "drizzle-kit";

import { VARIABLES_DE_PRODUCTION, variablesDefinidas } from "./destino-production.ts";

/**
 * **La rama histórica de validación.** No es virgen y es evidencia: los
 * documentos citan sus filas de `ops_sync_runs` por número (19–60). Es el
 * destino de `pnpm job`, de los crons y de los scripts manuales, y el **único**
 * que admite `verificarDestino` si quien lo llama no pide otra cosa.
 */
export const RAMA_HISTORICA = "drizzle-schema-v1-test";

/**
 * **La rama limpia del seed** (ADR 0009 §9): derivada de `production`, migrada
 * `0000`–`0004` y reservada a la carga del seed y a sus validadores. Régimen
 * estricto (`arranque.ts`): no es un destino histórico.
 */
export const RAMA_DEL_SEED = "seed-bootstrap-v1-test";

/**
 * **La rama limpia del seed REAL** (ADR 0009 §9): derivada de `production`,
 * virgen, migrada `0000`–`0004`. Aquí viven la fila de la captura real —su
 * libro de cuota—, la carga del crudo real y el primer `deltas` desde `S`.
 * **No** es `seed-bootstrap-v1-test`: esa contiene el ensayo con un crudo de
 * ensayo y no es virgen. Régimen estricto (`arranque.ts`).
 */
export const RAMA_DEL_SEED_REAL = "seed-real-v1-test";

/**
 * **La lista cerrada de destinos de validación.** Ninguno más. `production` no
 * está ni puede estar: añadir un destino es un diff revisable y un test lo
 * vigila (`tests/unit/destinos-de-validacion.test.ts`).
 */
export const RAMAS_DE_VALIDACION = [
  RAMA_HISTORICA,
  RAMA_DEL_SEED,
  RAMA_DEL_SEED_REAL,
] as const;

export type RamaDeValidacion = (typeof RAMAS_DE_VALIDACION)[number];

/** Marca de los endpoints con *pooling* de Neon. Migrar por el pooler es un error. */
const MARCA_POOLER = "-pooler";

export interface DestinoDeMigracion {
  /** La cadena completa. **Nunca se imprime.** */
  readonly url: string;
  /** El hostname, que sí es seguro mostrar. */
  readonly hostname: string;
  readonly esConexionDirecta: true;
  readonly rama: RamaDeValidacion;
}

function fallar(motivo: string): never {
  throw new Error(
    `Migración abortada antes de conectar.\n  ${motivo}\n` +
      `  Ninguna comprobación puede saltarse: este fichero es la única vía con credenciales.`,
  );
}

/**
 * Los cuatro cerrojos. Se exporta aparte para poder probarlos con un entorno
 * falso, sin tocar el real y sin conectarse a nada.
 *
 * ⚖️ **`admitidas` es una lista por llamador, y por defecto solo la histórica.**
 * Todo el que no pide otra cosa —`pnpm job`, los scripts manuales, los
 * validadores anteriores al seed— sigue alcanzando **solo**
 * `drizzle-schema-v1-test`, con su régimen histórico. La rama del seed la
 * alcanza únicamente quien la nombra: migrar, `seed:cargar` y sus validadores.
 * Fail closed: una rama admitida que no esté en la lista cerrada aborta.
 */
export function verificarDestino(
  entorno: Readonly<Partial<Record<string, string>>> = process.env,
  admitidas: readonly RamaDeValidacion[] = [RAMA_HISTORICA],
): DestinoDeMigracion {
  // 0 ─ Quien llama solo puede admitir ramas de la lista cerrada, y alguna.
  if (admitidas.length === 0) {
    fallar("Ningún destino admitido: el llamador no ha declarado ninguna rama.");
  }
  for (const rama of admitidas) {
    if (!(RAMAS_DE_VALIDACION as readonly string[]).includes(rama)) {
      fallar(`"${String(rama)}" no es un destino de validación de la lista cerrada.`);
    }
  }

  // 0b ─ Una sesión de validación no lleva variables de production: las dos
  //      familias no conviven (`destino-production.ts`, ADR 0010).
  const deProduction = variablesDefinidas(entorno, VARIABLES_DE_PRODUCTION);
  if (deProduction.length > 0) {
    fallar(
      `La sesión lleva variables de production (${deProduction.join(", ")}). ` +
        "Las herramientas de validación no corren en una sesión de production.",
    );
  }

  // 1 ─ La cadena de conexión tiene que existir y ser una URL.
  const bruta = entorno.DATABASE_URL_DIRECT;
  if (bruta === undefined || bruta.trim() === "") {
    fallar(
      "Falta DATABASE_URL_DIRECT. Debe existir solo en la sesión que migra, nunca en .env.",
    );
  }

  let url: URL;
  try {
    url = new URL(bruta);
  } catch {
    fallar("DATABASE_URL_DIRECT no es una URL válida. (No se muestra su valor.)");
  }

  const { hostname } = url;

  // 2 ─ Conexión DIRECTA. El pooler de Neon no sirve para migrar: reutiliza
  //     sesiones, y eso rompe los bloqueos y las sentencias de DDL largas.
  if (hostname.includes(MARCA_POOLER) || bruta.includes(MARCA_POOLER)) {
    fallar(
      `El destino usa el pooler ("${MARCA_POOLER}"). Las migraciones exigen conexión directa.`,
    );
  }

  // 3 ─ El hostname tiene que ser EXACTAMENTE el declarado.
  //
  //     Este es el cerrojo que protege `production`. Los hostnames de Neon
  //     identifican el endpoint, y cada rama tiene el suyo: si la URL apuntara
  //     a otra rama —production incluida— el hostname no coincidiría y el
  //     proceso muere aquí, sin abrir conexión.
  const esperado = entorno.NEON_VALIDATION_HOST;
  if (esperado === undefined || esperado.trim() === "") {
    fallar(
      "Falta NEON_VALIDATION_HOST: sin él no hay contra qué contrastar el destino.",
    );
  }
  if (hostname !== esperado.trim()) {
    fallar(
      `El hostname del destino no coincide con NEON_VALIDATION_HOST.\n` +
        `  destino:  ${hostname}\n` +
        `  esperado: ${esperado.trim()}`,
    );
  }

  // 4 ─ Y quien ejecuta tiene que haber nombrado la rama a propósito, y tiene
  //     que ser una de las que este llamador admite. Es la confirmación
  //     deliberada: no basta con tener las credenciales de una sesión anterior.
  const destino = entorno.MIGRATION_TARGET;
  const rama = admitidas.find((r) => r === destino);
  if (rama === undefined) {
    fallar(
      `MIGRATION_TARGET debe valer exactamente ${admitidas.map((r) => `"${r}"`).join(" o ")}.\n` +
        `  valor actual: ${destino ?? "(ausente)"}`,
    );
  }

  return { url: bruta, hostname, esConexionDirecta: true, rama };
}

// Migrar es lo único que admite **cualquier** rama de la lista cerrada: la del
// seed nace vacía y hay que aplicarle `0000`–`0004`. Cada script que importa
// este módulo vuelve a llamar a `verificarDestino` con su propia lista.
const destino = verificarDestino(process.env, RAMAS_DE_VALIDACION);

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: { url: destino.url },
  strict: true,
  verbose: true,
});
