/**
 * **La autorización de `production`, en código** (ADR 0010).
 *
 * Las guardas de entorno (`destino-production.ts`) dicen **a qué** base se
 * conecta un proceso; esta lista dice **qué puede hacerle**. Ninguna operación
 * que escriba en `production` —ni siquiera una que acabe en `ROLLBACK`— corre
 * sin una entrada aquí, añadida en un commit tras la aprobación explícita.
 * Las lecturas (`preflight`, `db:validate:schema`, `seed:validar`, la huella)
 * no la necesitan: solo las guardas de entorno.
 *
 * ⚖️ **Cada autorización está atada a lo que autoriza**, para que no pueda
 * reutilizarse para otra cosa:
 *
 *   · `migrar` — a la **última migración** del conjunto (`hastaMigracion`). Una
 *     `0005` futura no queda cubierta por la aprobación de `0000`–`0004`.
 *     Incluye `db:validate:behavior`, que escribe dentro de una transacción
 *     que nunca confirma.
 *   · `cargar` — a la **huella del crudo**. Otro crudo, otra aprobación.
 *   · `primer_deltas` — a la **huella del crudo** cuya ancla tiene que estar
 *     en `production`. Gasta del presupuesto aprobado de `deltas`.
 *
 * `cargar` y `primer_deltas` caducan solas: pasado `S + 72 h` la carga y el
 * primer `deltas` se niegan en código (`ancla_caducada`, ADR 0009 §7).
 *
 * **Hoy solo autoriza `migrar` hasta `0004_imdb_id_no_vacio`** (2026-09-27).
 * Ni `cargar` ni `primer_deltas`: el catálogo de `production` no se escribe.
 */

export type OperacionDeProduction = "migrar" | "cargar" | "primer_deltas";

export interface AutorizacionDeProduction {
  readonly operacion: OperacionDeProduction;
  /** Solo `migrar`: el tag de la última migración autorizada. */
  readonly hastaMigracion?: string;
  /** `cargar` y `primer_deltas`: sha256 del crudo (su identidad). */
  readonly huellaDelCrudo?: string;
  /** Fecha ISO de la aprobación. */
  readonly aprobadaEl: string;
  /** Dónde consta: el commit o la conversación que la aprobó. */
  readonly referencia: string;
}

/**
 * ⚖️ **Operaciones autorizadas sobre `production`.** Una entrada por paso
 * aprobado; nada más escribe allí.
 */
export const AUTORIZACIONES_DE_PRODUCTION: readonly AutorizacionDeProduction[] = [
  {
    operacion: "migrar",
    hastaMigracion: "0004_imdb_id_no_vacio",
    aprobadaEl: "2026-09-27",
    referencia:
      "aprobación explícita en la conversación del 2026-09-27: migrar production hasta 0004_imdb_id_no_vacio, y nada más",
  },
];

const HUELLA = /^[0-9a-f]{64}$/;

/** Lanza si alguna entrada no es coherente. */
export function validarAutorizacionesDeProduction(
  lista: readonly AutorizacionDeProduction[],
): void {
  for (const a of lista) {
    const donde = `autorización de production «${a.operacion}»`;
    if (!["migrar", "cargar", "primer_deltas"].includes(a.operacion)) {
      throw new Error(`${donde}: operación desconocida.`);
    }
    if (a.operacion === "migrar") {
      if (a.hastaMigracion === undefined || !/^\d{4}_\w+$/.test(a.hastaMigracion)) {
        throw new Error(`${donde}: sin hastaMigracion (tag de la última migración).`);
      }
      if (a.huellaDelCrudo !== undefined) {
        throw new Error(`${donde}: migrar no se ata a un crudo.`);
      }
    } else {
      if (a.huellaDelCrudo === undefined || !HUELLA.test(a.huellaDelCrudo)) {
        throw new Error(`${donde}: sin huella del crudo (sha256 en hexadecimal).`);
      }
      if (a.hastaMigracion !== undefined) {
        throw new Error(`${donde}: solo migrar lleva hastaMigracion.`);
      }
    }
    if (a.aprobadaEl.trim() === "" || a.referencia.trim() === "") {
      throw new Error(`${donde}: sin fecha o referencia de aprobación.`);
    }
  }
}

/** Lo que cada operación ata. */
export type ObjetoAutorizado =
  | { readonly operacion: "migrar"; readonly hastaMigracion: string }
  | {
      readonly operacion: "cargar" | "primer_deltas";
      readonly huellaDelCrudo: string;
    };

/**
 * La autorización exacta, o lanza. **Fail closed**: una lista incoherente,
 * una operación sin entrada o una entrada para otro objeto, niegan.
 */
export function exigirAutorizacionDeProduction(
  objeto: ObjetoAutorizado,
  lista: readonly AutorizacionDeProduction[] = AUTORIZACIONES_DE_PRODUCTION,
): AutorizacionDeProduction {
  validarAutorizacionesDeProduction(lista);
  const encontrada = lista.find((a) =>
    objeto.operacion === "migrar"
      ? a.operacion === "migrar" && a.hastaMigracion === objeto.hastaMigracion
      : a.operacion === objeto.operacion && a.huellaDelCrudo === objeto.huellaDelCrudo,
  );
  if (encontrada === undefined) {
    const que =
      objeto.operacion === "migrar"
        ? `migrar hasta ${objeto.hastaMigracion}`
        : `${objeto.operacion} del crudo ${objeto.huellaDelCrudo}`;
    throw new Error(
      `production: «${que}» no está autorizado en AUTORIZACIONES_DE_PRODUCTION ` +
        "(jobs/ops/autorizacion-de-production.ts). Autorizarlo es un commit tras la aprobación explícita.",
    );
  }
  return encontrada;
}
