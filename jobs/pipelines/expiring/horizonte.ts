/**
 * Qué dice un recorrido del horizonte de `expiring` **por lo que no lista**.
 * Solo mide: **no escribe nada**.
 *
 * ── La regla que este fichero protege ────────────────────────────────────────
 *
 * ⚖️ **Una ausencia no se interpreta como eliminación salvo que el recorrido
 * del horizonte haya terminado** (decidido el 2026-09-24). Y aun terminado, de
 * momento **solo se cuenta**: una oferta con `expires_at` dentro del horizonte
 * que el proveedor ya no nombra puede haberse aplazado, prorrogado o retirado
 * antes de tiempo, y no sabemos cuál. Primero se mide cuánto pasa; qué hacer
 * con ella se decide después, con esa cifra en la mano.
 *
 * Con el recorrido a medias no se calcula nada: `null`, no cero. Cero sería
 * afirmar que no desapareció ninguna. Las piezas comunes con `upcoming` viven
 * en `horizonte/medicion.ts`.
 */
import type { EjecutorSql } from "../../ops/contratos.ts";
import type { ResultadoDelHorizonte } from "../deltas/manifiesto.ts";
import type { EntradaDeMedicion } from "../horizonte/medicion.ts";
import {
  MUESTRA_DE_DESAPARECIDAS,
  noNombradas,
  ofertasConocidasEnElHorizonte,
  recorridoCompleto,
} from "../horizonte/medicion.ts";
import type { CheckpointDeExpiring } from "./checkpoint.ts";

export { MUESTRA_DE_DESAPARECIDAS };

/**
 * Ofertas **activas** con alguna opción activa cuya `expires_at` cae dentro
 * de la ventana del recorrido.
 *
 * ⚠️ El alias es `oferta`, no `a`: la base en memoria de los tests reconoce la
 * lectura del estado anterior por `FROM external_availability a`.
 */
export const SQL_OFERTAS_EN_EL_HORIZONTE = `
  SELECT DISTINCT t.imdb_id, oferta.platform_id, oferta.offer_type, oferta.addon
    FROM external_availability oferta
    JOIN external_titles t ON t.id = oferta.title_id
    JOIN external_availability_options o ON o.availability_id = oferta.id
   WHERE oferta.country = $1
     AND o.missing_streak < $2
     AND o.expires_at >= $3::timestamptz
     AND o.expires_at <= $4::timestamptz`;

/** El resultado del recorrido, con la forma que guarda el manifiesto. */
export type MedicionDelHorizonte = ResultadoDelHorizonte;

export async function medirHorizonte(
  ejecutor: EjecutorSql,
  entrada: EntradaDeMedicion<CheckpointDeExpiring>,
): Promise<MedicionDelHorizonte> {
  if (!recorridoCompleto(entrada)) {
    return { completo: false, desaparecidas: null, muestra: [] };
  }
  const conocidas = await ofertasConocidasEnElHorizonte(
    ejecutor,
    SQL_OFERTAS_EN_EL_HORIZONTE,
    entrada.checkpoint.ventana,
  );
  const desaparecidas = noNombradas(conocidas, entrada.informe);
  return {
    completo: true,
    desaparecidas: desaparecidas.length,
    muestra: desaparecidas.slice(0, MUESTRA_DE_DESAPARECIDAS),
  };
}
