/**
 * Qué hacer con las opciones de **una** oferta lógica. **Función pura:** aquí
 * se decide, el SQL lo ejecuta `index.ts`.
 *
 * ── El problema que este fichero resuelve ───────────────────────────────────
 *
 * La clave natural es `(availability_id, link, quality)` con
 * `NULLS NOT DISTINCT`, así que **`(X, NULL)` y `(X, 'hd')` son dos filas
 * distintas**. Una opción provisional escrita por `upcoming` —sin `quality`,
 * porque el anuncio no la trae— **no colisiona** con la opción real que llega
 * después. El `ON CONFLICT` insertaría la buena y la provisional sobreviviría
 * como fantasma, contaminando todos los agregados: recuento de opciones,
 * precio MIN, `expires_at` MIN, y disparando un `changed: ["options"]` falso.
 *
 * **`ON CONFLICT` no puede resolver esto: no es un conflicto.** Hace falta una
 * reconciliación explícita.
 *
 * ── Y por qué la reconciliación es tan estrecha ─────────────────────────────
 *
 * 1. 📏 **`quality IS NULL` NO significa «provisional»**: entre el 12 % y el
 *    37 % de las opciones reales llegan sin calidad. Por eso la regla no habla
 *    de procedencia —que no se puede saber sin una columna nueva, y el esquema
 *    está congelado— sino **del dato**: colapsa calidad desconocida en calidad
 *    conocida **para el mismo `link`**.
 * 2. **Nunca se borra por simple ausencia.** La ausencia la gestiona
 *    `missing_streak`; borrar por ausencia destruiría `first_seen_at` y con él
 *    el «en Netflix desde…» que es diferencial de producto.
 * 3. **Un solo sentido.** Si el snapshot trae `(X, NULL)` y en la base hay
 *    `(X, 'hd')`, no se borra nada: sería perder dato por un hueco temporal de
 *    cobertura del proveedor.
 */
import type { OpcionExistente, OpcionObservada, PlanDeOpciones } from "./contratos.ts";
import { UMBRAL_DE_INACTIVIDAD } from "./contratos.ts";
import { esFutura } from "./estado.ts";

/**
 * `link` + `quality` como una sola clave.
 *
 * `JSON.stringify` de la pareja y no una concatenación con separador: es el
 * mismo recurso que ya usa `firmaDeOpcion` en el seed, y así no hay que elegir
 * un carácter «imposible» del que luego haya que fiarse. Un NUL literal, que
 * fue el primer intento, convierte el fichero en binario para git.
 */
function clave(link: string, calidad: string | null): string {
  return JSON.stringify([link, calidad]);
}

function comoObservada(opcion: OpcionExistente): OpcionObservada {
  return {
    link: opcion.link,
    calidad: opcion.calidad,
    precio: opcion.precio,
    idiomasAudio: opcion.idiomasAudio,
    idiomasSubtitulos: opcion.idiomasSubtitulos,
    disponibleDesde: opcion.disponibleDesde,
    expiraEl: opcion.expiraEl,
  };
}

/**
 * **¿Esta observación es nueva para la oferta, o ya se aplicó?**
 *
 * Una observación se identifica por su **instante**: el `ahora` de la
 * ejecución que pidió el snapshot. Queda escrito en
 * `external_availability.last_checked_at`, que **solo avanza**
 * (`GREATEST` en el upsert), y viaja en el manifiesto de cada ejecución, así
 * que una reproducción reutiliza el mismo instante.
 *
 *   · `ahora > última`  → observación nueva: cuenta.
 *   · `ahora == última` → **la misma** observación otra vez: reproducción,
 *     reintento sobre el crudo guardado, o la misma oferta en otra página de
 *     la misma ejecución. No cuenta.
 *   · `ahora < última`  → una observación **anterior** a otra ya aplicada:
 *     tampoco cuenta; aplicarla desharía la posterior.
 *
 * Sin comprobación previa, la oferta no tiene nada que repetir: es nueva.
 */
export function esObservacionNueva(
  ultimaComprobacion: Date | null,
  ahora: Date,
): boolean {
  return ultimaComprobacion === null || ahora.getTime() > ultimaComprobacion.getTime();
}

export function planificarOpciones(entrada: {
  readonly existentes: readonly OpcionExistente[];
  /** Las opciones que el proveedor lista **ahora** para esta oferta. */
  readonly snapshot: readonly OpcionObservada[];
  readonly ahora: Date;
  /**
   * Un aviso `removed` nombró esta oferta.
   *
   * ⚖️ Una retirada explícita **no espera** las dos comprobaciones de
   * `missing_streak`: el proveedor no está callado, está afirmando. La espera
   * existe para no matar una oferta por una ausencia *inferida*, que es otra
   * cosa.
   */
  readonly retiradaExplicita: boolean;
  /**
   * Si la ausencia de una opción en el snapshot significa algo.
   *
   * ⚖️ **Solo cuenta cuando el snapshot habla de esta oferta**: o la lista con
   * opciones —y entonces que falte una es una observación—, o un aviso
   * `removed` la nombra. Si el snapshot sencillamente no la menciona, no se
   * toca nada: 📏 que `streamingOptions.es` sea el catálogo **completo** del
   * título está fuertemente indicado por los fixtures pero **no medido**, y
   * detectar ausencias a ciegas es trabajo del pipeline `reconcile`, no de
   * este.
   */
  readonly aplicarAusencias: boolean;
  /**
   * Si esta observación **todavía no se había aplicado** a la oferta
   * (`esObservacionNueva`).
   *
   * ⚖️ **Una misma observación no mueve `missing_streak` dos veces.** Si ya se
   * aplicó, no suma ausencias, no pone a cero las presentes y no repite una
   * retirada: todo eso lo hizo la primera vez. Sin esta regla, reprocesar la
   * misma página retiraría una opción con **una sola** observación real, y las
   * dos comprobaciones de `missing_streak` no protegerían de nada.
   */
  readonly observacionNueva: boolean;
  /**
   * Si una opción `(link, NULL)` se **colapsa** en la `(link, calidad)` que el
   * snapshot ahora precisa: se borra y su `first_seen_at` se hereda. Por
   * defecto, sí: es lo que hacen `deltas`, `expiring` y `upcoming`.
   *
   * ⚖️ `updated` lo desactiva (2026-09-25): es **no destructivo** respecto a
   * las opciones. La identidad nueva se persiste y la `(link, NULL)` se queda
   * como está —sin borrar, sin heredar, sin tocar su racha— hasta que `deltas`
   * o `reconcile` la resuelvan.
   */
  readonly reconciliarCalidadDesconocida?: boolean;
}): PlanDeOpciones {
  const { existentes, snapshot, ahora, aplicarAusencias, observacionNueva } = entrada;
  const reconciliarCalidadDesconocida = entrada.reconciliarCalidadDesconocida ?? true;
  // Una retirada ya aplicada tampoco se repite: es un hecho de aquella
  // observación, no de esta.
  const retiradaExplicita = entrada.retiradaExplicita && observacionNueva;

  const clavesSnapshot = new Set(snapshot.map((o) => clave(o.link, o.calidad)));
  const linksSnapshot = new Set(snapshot.map((o) => o.link));

  const aBorrar: string[] = [];
  const herencias = new Map<string, Date>();
  const ausencias: { id: string; ausenciasSeguidas: number }[] = [];
  const presentes: string[] = [];
  const supervivientes: OpcionObservada[] = [];

  for (const opcion of existentes) {
    if (clavesSnapshot.has(clave(opcion.link, opcion.calidad))) {
      // Se sigue viendo: su racha de ausencias vuelve a cero. Solo en una
      // observación nueva: una anterior no puede deshacer una ausencia
      // observada después.
      if (observacionNueva) presentes.push(opcion.id);
      continue;
    }

    // Condición 1 + 2: calidad desconocida que el snapshot ahora precisa.
    if (
      reconciliarCalidadDesconocida &&
      opcion.calidad === null &&
      linksSnapshot.has(opcion.link)
    ) {
      aBorrar.push(opcion.id);
      const previa = herencias.get(opcion.link);
      if (previa === undefined || opcion.vistaPrimeroEn < previa) {
        herencias.set(opcion.link, opcion.vistaPrimeroEn);
      }
      continue;
    }

    // Ausencia. Una opción futura NO acumula ausencia por no estar todavía en
    // el catálogo (`docs/DATA-MODEL.md`): sin esta excepción todo anuncio
    // moriría antes de estrenarse.
    const protegida = !retiradaExplicita && esFutura(comoObservada(opcion), ahora);
    const ausenciasSeguidas = retiradaExplicita
      ? UMBRAL_DE_INACTIVIDAD
      : !observacionNueva || !aplicarAusencias || protegida
        ? opcion.ausenciasSeguidas
        : opcion.ausenciasSeguidas + 1;

    if (ausenciasSeguidas !== opcion.ausenciasSeguidas) {
      ausencias.push({ id: opcion.id, ausenciasSeguidas });
    }
    if (ausenciasSeguidas < UMBRAL_DE_INACTIVIDAD) {
      supervivientes.push(comoObservada(opcion));
    }
  }

  return {
    aBorrar,
    herencias,
    ausencias,
    presentes,
    // El estado «después» es el que tendremos **tras escribir**, no el
    // snapshot crudo: una ausencia de una sola pasada todavía no retira nada,
    // y el evento tiene que describir nuestro estado, que es el que se publica.
    activasDespues: [...snapshot, ...supervivientes],
  };
}
