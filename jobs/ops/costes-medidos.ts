/**
 * **Coste medido de un recorrido completo. Observabilidad, NO autorización.**
 *
 * ⚠️ Este mapa no autoriza ni una sola request. Sirve para planificar y para
 * documentar, y `presupuesto.ts` **no lo importa** — hay un test que lo
 * comprueba. Si algún día alguien lo usara para decidir una reserva, volvería
 * el mismo defecto que este fichero existe para impedir.
 *
 * ── Por qué está separado ───────────────────────────────────────────────────
 *
 * 📏 `docs/DATA-SOURCES.md` §1.8 contiene **dos tablas con unidades distintas**:
 * una de consumo **por recorrido completo** y otra de régimen **mensual**.
 * Mezclarlas produjo un defecto real: el tope por ejecución acabó valiendo el
 * agregado del mes, y el «límite duro de subrequests por job» del Plan §8.5
 * dejó de proteger de nada sin que nada fallara.
 *
 * Aquí solo entran cifras cuya unidad sea **requests por recorrido completo**.
 * Un promedio mensual **no se convierte** en coste por ejecución dividiéndolo
 * por los días del mes: eso sería inventar una medición que nadie hizo.
 */
import type { NombreDePipeline } from "./contratos.ts";

/**
 * `null` significa **«no medido por ejecución»**, nunca cero ni un promedio.
 *
 * 📏 Las dos cifras que sí existen salen de la tabla «Concepto · Requests ·
 * Origen» de `docs/DATA-SOURCES.md` §1.8, cuya unidad es el recorrido:
 *
 *   · seed        ~272 — «Seed de ~5.000 títulos únicos», 20 títulos/página
 *                 con 8 % de solapamiento medido
 *   · reconcile   ~272 — «Recorrido completo de reconciliación», igual que el seed
 *
 * El resto vive en la tabla de **régimen mensual**, que agrega muchas
 * ejecuciones: de ahí no sale ningún coste por ejecución.
 */
export const COSTE_ESPERADO_POR_EJECUCION: Readonly<
  Record<NombreDePipeline, number | null>
> = {
  seed: 272,
  reconcile: 272,
  deltas: null,
  expiring: null,
  upcoming: null,
  updated: null,
  popularity: null,
  enrich: null,
  scoring: null,
  // No es ingesta: no tiene «recorrido completo» que medir.
  changes_validation: null,
};
