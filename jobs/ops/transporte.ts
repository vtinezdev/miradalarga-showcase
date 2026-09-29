/**
 * **El único punto de todo `jobs/**` autorizado a llamar a `fetch`.**
 *
 * No es una convención que haya que recordar: `eslint.config.mjs` prohíbe
 * `fetch`, `globalThis.fetch` y los módulos HTTP de Node en el resto de
 * `jobs/**`. Así *«no llames sin reservar»* deja de ser disciplina y pasa a ser
 * imposible de incumplir sin que el lint lo diga.
 *
 * ⚠️ **La reserva ocurre ANTES de la llamada, y no se devuelve si la llamada
 * falla.** Una petición que se va por un timeout o un 500 puede haber contado
 * igualmente en el contador del proveedor. Descontarla sería suponer que no
 * llegó, y eso no lo hemos observado.
 */
import type { NombreDePipeline } from "./contratos.ts";

/** Lo mínimo que el transporte necesita de la ejecución que lo usa. */
export interface FuenteDeCuota {
  readonly pipeline: NombreDePipeline;
  /** Lanza `PresupuestoAgotado` si no queda cuota. */
  pedirCuota(): Promise<void>;
}

/** Una llamada externa ya contabilizada. */
export type Transporte = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * **Tiempo máximo de UNA request**, respuesta y cuerpo incluidos.
 *
 * ⚖️ **No es una medida de latencia: es un cerrojo.** Sin él, una conexión
 * colgada se comería el `timeout-minutes` entero del job, y GitHub mataría el
 * proceso sin cerrar la fila. Con él, la request falla, la ejecución cierra
 * `failed` con su muestra y el checkpoint de la última página confirmada queda
 * intacto.
 *
 * ⚠️ **Una request que agota el tiempo SIGUE CONTADA.** Se reservó antes de
 * salir y pudo llegar al proveedor: descontarla sería suponer que no llegó.
 */
export const TIEMPO_MAXIMO_POR_REQUEST_MS = 30_000;

/**
 * Envuelve `fetch` con la reserva previa y el tiempo máximo.
 *
 * Solo acepta URLs absolutas `https:`. Una URL relativa no identifica a nadie,
 * y `http:` mandaría la credencial en claro.
 *
 * El `signal` del tiempo máximo **sigue atado al cuerpo**: un `.text()` que se
 * queda esperando datos también se corta, no solo la cabecera. Si el llamador
 * trae su propio `signal`, se respetan los dos.
 */
export function crearTransporte(
  fuente: FuenteDeCuota,
  opciones: { readonly tiempoMaximoMs?: number } = {},
): Transporte {
  const tiempoMaximoMs = opciones.tiempoMaximoMs ?? TIEMPO_MAXIMO_POR_REQUEST_MS;
  if (!Number.isSafeInteger(tiempoMaximoMs) || tiempoMaximoMs < 1) {
    throw new Error(
      `El tiempo máximo por request es un entero positivo de ms. Recibido: ${String(tiempoMaximoMs)}.`,
    );
  }

  return async function llamar(url: string, init?: RequestInit): Promise<Response> {
    let destino: URL;
    try {
      destino = new URL(url);
    } catch {
      throw new Error(`El transporte exige una URL absoluta. Recibida: "${url}".`);
    }
    if (destino.protocol !== "https:") {
      throw new Error(
        `El transporte solo habla https. Recibido "${destino.protocol}" para ${destino.hostname}.`,
      );
    }

    // Primero la cuota. Si se deniega, esta línea lanza y NO hay llamada.
    await fuente.pedirCuota();

    // El reloj arranca DESPUÉS de reservar: la espera por el lock del ciclo no
    // es tiempo de red y no puede consumir el margen de la request.
    const limite = AbortSignal.timeout(tiempoMaximoMs);
    const signal =
      init?.signal == null ? limite : AbortSignal.any([init.signal, limite]);
    return fetch(destino, { ...init, signal });
  };
}
