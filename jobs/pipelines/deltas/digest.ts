/**
 * `event_digest` y el *bucket* de deduplicación. **Funciones puras.**
 *
 * El único de `external_availability_events` es
 * `(availability_id, event_type, event_digest, dedupe_bucket_at)`, así que la
 * idempotencia del histórico **depende por completo de que este hash sea
 * determinista**. Un digest que cambiara entre dos ejecuciones con el mismo
 * contenido duplicaría el evento sin que nada fallara.
 *
 * ⚠️ Por eso `canonicalizar` ordena las claves en vez de confiar en el orden
 * de inserción de `Object.entries`. Es la forma más fácil de romper esto sin
 * que ningún test lo note.
 */
import { createHash } from "node:crypto";

import { horaEnMadrid, medianocheEnMadrid } from "../../ops/tiempo.ts";

/**
 * Forma canónica: claves ordenadas, `undefined` fuera, `Date` en ISO.
 *
 * `undefined` se elimina en vez de convertirse en `null` porque son cosas
 * distintas: `null` es «no lo sabemos» y se conserva (invariante 4);
 * `undefined` es una clave que no debería existir.
 */
export function canonicalizar(valor: unknown): unknown {
  if (valor instanceof Date) return valor.toISOString();
  if (Array.isArray(valor)) return valor.map(canonicalizar);
  if (valor === null || typeof valor !== "object") return valor;

  const entradas = Object.entries(valor as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const salida: Record<string, unknown> = {};
  for (const [clave, v] of entradas) salida[clave] = canonicalizar(v);
  return salida;
}

/** Hash determinista sobre `(changed_fields, before, after)`. */
export function calcularEventDigest(
  camposCambiados: readonly string[] | null,
  antes: unknown,
  despues: unknown,
): string {
  const payload = JSON.stringify({
    changed_fields: camposCambiados === null ? null : [...camposCambiados].sort(),
    before: canonicalizar(antes),
    after: canonicalizar(despues),
  });
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * El *bucket* de deduplicación: el inicio del día en `Europe/Madrid`.
 *
 * La cadencia **no está en el esquema** (`docs/DATA-MODEL.md`): si algún día
 * se pasa a horaria, cambia esta función y nada más. La frontera se calcula en
 * Madrid y nunca en la zona del servidor.
 *
 * ⚠️ **No sigue al ciclo de presupuesto**, que corta en UTC. El bucket es un
 * concepto editorial y forma parte de la clave única del histórico: moverlo a
 * UTC rompería la deduplicación de los eventos ya escritos.
 */
export function bucketDelDia(instante: Date): Date {
  const local = horaEnMadrid(instante);
  return medianocheEnMadrid(local.anio, local.mes, local.dia);
}
