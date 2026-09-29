/**
 * De dos estados a un evento. **Función pura.**
 *
 * ── La regla que este fichero existe para proteger ──────────────────────────
 *
 * **El `changeType` del proveedor nunca se escribe como `event_type`.** Un
 * aviso solo dice qué oferta hay que volver a mirar. El tipo de evento sale
 * siempre de comparar el estado anterior con el nuevo, tal y como fija
 * `docs/DATA-MODEL.md`:
 *
 *   announced — 0 → ≥1 opciones activas, **todas futuras**
 *   added     — 0 → ≥1 opciones activas, alguna **ya disponible**
 *   removed   — ≥1 → **0**
 *   changed   — todo lo demás, nombrando qué cambió
 *
 * Por eso un `changeType: "new"` sobre una oferta que ya tenía opciones
 * activas —la rotación de slugs de SkyShowtime— produce `changed`, nunca un
 * `added` falso.
 */
import type { EstadoDeOferta } from "./contratos.ts";

/** Los cuatro valores del enum `event_type`. */
export type TipoDeEvento = "announced" | "added" | "changed" | "removed";

export interface EventoCandidato {
  readonly tipo: TipoDeEvento;
  /**
   * `null` en las altas y las bajas: el cambio es la propia transición, y no
   * hay campo concreto que nombrar.
   */
  readonly camposCambiados: readonly string[] | null;
  readonly antes: EstadoDeOferta;
  readonly despues: EstadoDeOferta;
}

/**
 * Nombres de campo en el vocabulario del esquema, no en el del modelo
 * canónico: son los que viajan a `changed_fields` y los lee quien consulta la
 * base de datos.
 */
const CAMPOS = [
  ["disponibleDesde", "available_since"],
  ["expiraEl", "expires_at"],
  ["calidades", "quality"],
  ["idiomasAudio", "audio_languages"],
  ["idiomasSubtitulos", "subtitle_languages"],
] as const;

function mismaLista(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Qué cambió entre dos agregados, con los nombres del esquema. */
export function diferencias(
  antes: EstadoDeOferta,
  despues: EstadoDeOferta,
): readonly string[] {
  const campos: string[] = [];

  for (const [propiedad, nombre] of CAMPOS) {
    const a = antes[propiedad];
    const d = despues[propiedad];
    const iguales = Array.isArray(a) && Array.isArray(d) ? mismaLista(a, d) : a === d;
    if (!iguales) campos.push(nombre);
  }

  const precioAntes = antes.precio;
  const precioDespues = despues.precio;
  if (
    precioAntes?.importe !== precioDespues?.importe ||
    precioAntes?.moneda !== precioDespues?.moneda
  ) {
    campos.push("price");
  }

  // La entrada o la salida de una variante, que `docs/DATA-MODEL.md` nombra
  // explícitamente `options`. Una rotación de deeplink con los mismos valores
  // NO cambia el recuento, y por eso no aparece aquí.
  if (antes.opcionesActivas !== despues.opcionesActivas) campos.push("options");

  // El estado derivado es el hecho de producto: «se anunció», «ya está».
  // No es redundante con los anteriores: una oferta puede pasar de futura a
  // disponible sin que cambie una sola fecha.
  if (antes.estado !== despues.estado) campos.push("state");

  return campos.sort();
}

export function compararEstados(
  antes: EstadoDeOferta,
  despues: EstadoDeOferta,
): EventoCandidato | null {
  if (antes.opcionesActivas === 0 && despues.opcionesActivas === 0) return null;

  if (antes.opcionesActivas === 0) {
    return {
      tipo: despues.estado === "upcoming" ? "announced" : "added",
      camposCambiados: null,
      antes,
      despues,
    };
  }

  if (despues.opcionesActivas === 0) {
    return { tipo: "removed", camposCambiados: null, antes, despues };
  }

  const campos = diferencias(antes, despues);
  if (campos.length === 0) return null;
  return { tipo: "changed", camposCambiados: campos, antes, despues };
}
