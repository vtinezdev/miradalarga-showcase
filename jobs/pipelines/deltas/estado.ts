/**
 * El agregado de una oferta lógica. **Función pura, sin SQL y sin red.**
 *
 * Implementa —no inventa— la tabla de agregados de `docs/DATA-MODEL.md`:
 * `available_since` = MIN · `expires_at` = MIN de los no nulos · precio = MIN
 * con su moneda · idiomas = UNIÓN · recuento = COUNT.
 *
 * Es la única pieza que decide qué significa «el estado de una oferta», y por
 * eso la usan **los dos lados** de la comparación: el anterior, construido
 * desde nuestras filas, y el nuevo, construido desde el snapshot del
 * proveedor. Si cada lado agregara a su manera, el diff mediría la diferencia
 * entre dos formas de contar y no un cambio real.
 */
import type { PrecioCanonico } from "../../adapters/contracts.ts";
import type {
  EstadoDerivado,
  EstadoDeOferta,
  OpcionExistente,
  OpcionObservada,
} from "./contratos.ts";
import { UMBRAL_DE_INACTIVIDAD } from "./contratos.ts";

/**
 * Una opción es futura si su `disponibleDesde` **consta** y aún no ha llegado.
 *
 * `null` no es futuro: significa «no consta», y una opción listada en el
 * catálogo sin fecha de alta está disponible ahora (invariante 4).
 */
export function esFutura(opcion: OpcionObservada, ahora: Date): boolean {
  return opcion.disponibleDesde !== null && opcion.disponibleDesde > ahora;
}

function menorFecha(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

/**
 * El más barato. Compara numéricamente pero **devuelve el importe original**:
 * reformatear un precio es perder precisión por el camino.
 */
function menorPrecio(
  a: PrecioCanonico | null,
  b: PrecioCanonico | null,
): PrecioCanonico | null {
  if (a === null) return b;
  if (b === null) return a;
  const na = Number(a.importe);
  const nb = Number(b.importe);
  if (Number.isNaN(na)) return b;
  if (Number.isNaN(nb)) return a;
  return na <= nb ? a : b;
}

function ordenadoUnico(valores: readonly string[]): readonly string[] {
  return [...new Set(valores)].sort();
}

/** Agrega las opciones **ya filtradas a las activas**. */
export function agregar(
  opciones: readonly OpcionObservada[],
  ahora: Date,
): EstadoDeOferta {
  if (opciones.length === 0) {
    return {
      opcionesActivas: 0,
      estado: "gone",
      disponibleDesde: null,
      expiraEl: null,
      precio: null,
      calidades: [],
      idiomasAudio: [],
      idiomasSubtitulos: [],
    };
  }

  let disponibleDesde: Date | null = null;
  let expiraEl: Date | null = null;
  let precio: PrecioCanonico | null = null;
  const calidades: string[] = [];
  const audio: string[] = [];
  const subtitulos: string[] = [];
  let todasFuturas = true;

  for (const opcion of opciones) {
    disponibleDesde = menorFecha(disponibleDesde, opcion.disponibleDesde);
    expiraEl = menorFecha(expiraEl, opcion.expiraEl);
    precio = menorPrecio(precio, opcion.precio);
    if (opcion.calidad !== null) calidades.push(opcion.calidad);
    audio.push(...opcion.idiomasAudio);
    subtitulos.push(...opcion.idiomasSubtitulos);
    if (!esFutura(opcion, ahora)) todasFuturas = false;
  }

  const estado: EstadoDerivado = todasFuturas ? "upcoming" : "available";

  return {
    opcionesActivas: opciones.length,
    estado,
    disponibleDesde: disponibleDesde?.toISOString() ?? null,
    expiraEl: expiraEl?.toISOString() ?? null,
    precio,
    calidades: ordenadoUnico(calidades),
    idiomasAudio: ordenadoUnico(audio),
    idiomasSubtitulos: ordenadoUnico(subtitulos),
  };
}

/**
 * 📏 **30 días.** La regla «expira en 30 días o menos» reproduce el
 * `expiresSoon` del proveedor en **336 de 336** ofertas, con un hueco vacío
 * entre ≤ 24,4 y ≥ 50,5 días (`docs/DATA-SOURCES.md` §1.1).
 */
export const DIAS_DE_SALIDA_PROXIMA = 30;

/**
 * **`leaving_soon`**, derivado y nunca almacenado: la fecha de salida que
 * justifica mostrar una oferta en «Últimos días», o `null`.
 *
 * Recibe las opciones **ya filtradas a las activas**. Exige que la oferta esté
 * `available` —un anuncio que aún no se ha estrenado no «se va»— y toma la
 * menor `expires_at` **futura** de sus opciones, si cae en los próximos 30
 * días.
 *
 * ⚖️ **Una `expires_at` ya pasada no cuenta** (decidido el 2026-09-24). Si la
 * oferta sigue activa después de su fecha, o el proveedor la aplazó o no la
 * hemos vuelto a observar: en ningún caso sabemos que «se va pronto», y
 * mostrarla sería inventar (regla 7). Tampoco se usa el `MIN` a secas de
 * `agregar`: una fecha pasada en una opción taparía la futura de otra.
 *
 * `expires_at == ahora` ya es pasado: el límite inferior es estricto.
 */
export function salidaProxima(
  opciones: readonly OpcionObservada[],
  ahora: Date,
): Date | null {
  if (opciones.length === 0) return null;
  if (opciones.every((o) => esFutura(o, ahora))) return null;

  let proxima: Date | null = null;
  for (const opcion of opciones) {
    const fecha = opcion.expiraEl;
    if (fecha === null || fecha.getTime() <= ahora.getTime()) continue;
    if (proxima === null || fecha < proxima) proxima = fecha;
  }
  if (proxima === null) return null;

  const limite = ahora.getTime() + DIAS_DE_SALIDA_PROXIMA * 86_400_000;
  return proxima.getTime() <= limite ? proxima : null;
}

/** Las opciones que hoy cuentan: `missing_streak < 2`. */
export function activas(
  opciones: readonly OpcionExistente[],
): readonly OpcionExistente[] {
  return opciones.filter((o) => o.ausenciasSeguidas < UMBRAL_DE_INACTIVIDAD);
}
