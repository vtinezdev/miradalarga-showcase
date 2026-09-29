/**
 * **`external_platform_capabilities`**: las 30 filas de referencia curada del
 * MVP (6 plataformas × 5 capacidades, `country = 'es'`), ADR 0009 §8.
 *
 * Es la matriz vigente de `docs/DATA-SOURCES.md` §1.4 y del ADR 0003, **fechada
 * el 2026-09-21**, sin reclasificar nada:
 *
 *   ✅ `supported_with_data` · ⚪ `supported_no_data_in_sample` ·
 *   ❌ `not_supported` · ❓ `unknown`
 *
 * ⚖️ **Nunca desde `spike-1/capabilities-es.json`**, que colapsa ⚪, ❓ y ❌ en
 * un booleano. Y **no se añade ninguna capacidad sin medir**: SkyShowtime
 * `popularity_order` sigue ❓, y M1 no la cambia. Reclasificar —la fila 50 vio
 * 6 anuncios de Disney+, la 44 ninguno de Prime en `expiring`— exige antes una
 * decisión en §1.4.
 *
 * Referencia curada, como `PLATAFORMAS_MVP`: no sale del crudo ni de la API.
 * La carga la escribe en su misma transacción, después de las plataformas —la
 * FK lo exige— y antes de los títulos.
 */
import type { capability, capabilityStatus } from "../../../src/db/schema/enums.ts";
import { PLATAFORMAS_MVP } from "./plataformas.ts";

export type Capacidad = (typeof capability.enumValues)[number];
export type EstadoDeCapacidad = (typeof capabilityStatus.enumValues)[number];

/** El orden de las columnas de la matriz, el del enum `capability`. */
export const CAPACIDADES: readonly Capacidad[] = [
  "expiring",
  "upcoming",
  "official_top",
  "prices",
  "popularity_order",
];

/** Cuándo se midió la matriz (📏 Spike 1, ventana de 31 días desde esta fecha). */
export const FECHA_DE_LA_MATRIZ = "2026-09-21";

export const PAIS_DE_LAS_CAPACIDADES = "es";

/**
 * **La matriz**, por nuestro `id` de plataforma. Cada ⚪ y cada ❌ tiene su
 * porqué en `docs/DATA-SOURCES.md` §1.4:
 *
 *   · Disney+ `upcoming` es ⚪, **no** ❌: la documentación la declara cubierta
 *     y el dato real en España fue cero.
 *   · SkyShowtime `upcoming` es ❌: único caso en que documentación y medición
 *     coinciden en la ausencia. Tiene que coincidir con
 *     `PLATAFORMAS_SIN_UPCOMING` (`upcoming/horizonte.ts`); un test lo exige.
 *   · `prices` ❌ en las de suscripción recoge el «no aplica» de la matriz.
 *   · `popularity_order` ✅ solo en Netflix (2 de 4 ventanas verificadas); las
 *     demás, ❓: sin una sola llamada.
 */
export const MATRIZ_DE_CAPACIDADES: Readonly<
  Record<string, Readonly<Record<Capacidad, EstadoDeCapacidad>>>
> = {
  netflix: {
    expiring: "supported_with_data",
    upcoming: "supported_with_data",
    official_top: "supported_with_data",
    prices: "not_supported",
    popularity_order: "supported_with_data",
  },
  prime: {
    expiring: "supported_with_data",
    upcoming: "supported_with_data",
    official_top: "supported_with_data",
    prices: "supported_with_data",
    popularity_order: "unknown",
  },
  disney: {
    expiring: "supported_no_data_in_sample",
    upcoming: "supported_no_data_in_sample",
    official_top: "supported_with_data",
    prices: "not_supported",
    popularity_order: "unknown",
  },
  max: {
    expiring: "supported_with_data",
    upcoming: "supported_with_data",
    official_top: "supported_with_data",
    prices: "not_supported",
    popularity_order: "unknown",
  },
  apple: {
    expiring: "supported_no_data_in_sample",
    upcoming: "supported_with_data",
    official_top: "supported_with_data",
    prices: "supported_with_data",
    popularity_order: "unknown",
  },
  skyshowtime: {
    expiring: "supported_with_data",
    upcoming: "not_supported",
    official_top: "supported_no_data_in_sample",
    prices: "not_supported",
    popularity_order: "unknown",
  },
};

/** Una fila de `external_platform_capabilities`. */
export interface FilaDeCapacidad {
  readonly platformId: string;
  readonly country: string;
  readonly capability: Capacidad;
  readonly status: EstadoDeCapacidad;
}

/**
 * Las 30 filas, en el orden de `PLATAFORMAS_MVP` y de `CAPACIDADES`. Una
 * plataforma del MVP sin fila en la matriz es un error de programación: se
 * lanza al cargar el módulo, no se rellena con `unknown`.
 */
export const CAPACIDADES_MVP: readonly FilaDeCapacidad[] = PLATAFORMAS_MVP.flatMap(
  (p) => {
    const fila = MATRIZ_DE_CAPACIDADES[p.id];
    if (fila === undefined) {
      throw new Error(
        `La plataforma ${p.id} no tiene fila en la matriz de capacidades.`,
      );
    }
    return CAPACIDADES.map((capability) => ({
      platformId: p.id,
      country: PAIS_DE_LAS_CAPACIDADES,
      capability,
      status: fila[capability],
    }));
  },
);

/** Plataformas con una capacidad en un estado dado. */
export function plataformasCon(
  capacidad: Capacidad,
  estado: EstadoDeCapacidad,
): ReadonlySet<string> {
  return new Set(
    CAPACIDADES_MVP.filter(
      (f) => f.capability === capacidad && f.status === estado,
    ).map((f) => f.platformId),
  );
}
