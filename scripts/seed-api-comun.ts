/**
 * Lo común a los scripts del seed que **gastan cuota** (`seed:sondear`,
 * `seed:capturar`, `seed:primer-deltas`) y a los que verifican M1.
 *
 *   · **La credencial**, sin imprimirla nunca, y **sin overrides**: ni de
 *     presupuesto (`STREAMING_API_*`) ni del host (`STREAMING_API_BASE_URL`).
 *     La autorización del seed vive en código (`autorizacion-del-seed.ts`).
 *   · **El reloj del servidor**: `clock_timestamp()` de PostgreSQL, el dominio
 *     de `finished_at` (ADR 0009 §7), y un reloj local desplazado a él.
 *   · **Ninguna credencial en el crudo**: se recorre lo escrito buscándola.
 *   · **Las referencias del Spike** que M1 usa: la página 1 por defecto de los
 *     12 estratos (`spike-1/raw/003–014`) y la evidencia de Netflix
 *     (`spike-3/raw/016`, `027`). Solo existen en local.
 */
import type { EjecutorSql } from "../jobs/ops/contratos.ts";
import { VARIABLES_DE_PRESUPUESTO } from "../jobs/pipelines/programado.ts";

export {
  DIRECTORIO_DE_CRUDOS,
  RAIZ,
  commitActual,
  evidenciaDeNetflix,
  externosDeM1,
  referenciasDelSpike,
} from "./seed-referencias.ts";

/** La credencial de la API. Aborta si hay overrides de presupuesto o de host. */
export function credencialSinOverrides(): string {
  const definidas = [...VARIABLES_DE_PRESUPUESTO, "STREAMING_API_BASE_URL"].filter(
    (v) => (process.env[v] ?? "").trim() !== "",
  );
  if (definidas.length > 0) {
    throw new Error(
      `El seed no admite overrides de presupuesto ni de host, y vienen definidas: ${definidas.join(", ")}.`,
    );
  }
  const clave = (process.env.STREAMING_AVAILABILITY_API_KEY ?? "").trim();
  if (clave === "") throw new Error("Falta STREAMING_AVAILABILITY_API_KEY.");
  return clave;
}

/** `clock_timestamp()`: avanza dentro de una transacción, a diferencia de `now()`. */
export async function relojDelServidor(ejecutor: EjecutorSql): Promise<Date> {
  const [f] = await ejecutor.ejecutar<{ t: Date | string }>(
    "SELECT clock_timestamp() AS t",
  );
  if (f === undefined) throw new Error("El servidor no devolvió clock_timestamp().");
  return new Date(f.t);
}

/** Un reloj local desplazado al del servidor: reservas y respuestas en su dominio. */
export async function relojDesplazado(ejecutor: EjecutorSql): Promise<() => Date> {
  const antes = Date.now();
  const servidor = (await relojDelServidor(ejecutor)).getTime();
  const despues = Date.now();
  const desfase = servidor - Math.round((antes + despues) / 2);
  return () => new Date(Date.now() + desfase);
}

/** Lanza si algún fichero contiene la credencial. Nunca la imprime. */
export function exigirSinCredencial(
  ficheros: Iterable<readonly [string, Uint8Array]>,
  clave: string,
): void {
  const buscada = Buffer.from(clave, "utf8");
  for (const [ruta, bytes] of ficheros) {
    if (Buffer.from(bytes).includes(buscada)) {
      throw new Error(
        `La credencial aparece en ${ruta}: el crudo no puede conservarse así.`,
      );
    }
  }
}
