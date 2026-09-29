/**
 * **La cuota según el proveedor.** Comprobación externa, no libro interno.
 *
 * 📏 Cada respuesta de la API trae tres cabeceras (`spike-1/raw/018`):
 *
 *   x-quota-used     16
 *   x-quota-granted  1000
 *   x-quota-reset    2026-10-01T00:00:00Z
 *
 * ── Dos fuentes, dos papeles ─────────────────────────────────────────────────
 *
 * `ops_sync_runs` es **nuestro libro**: se escribe antes de cada llamada y es
 * lo que `reservar()` consulta. Estas cabeceras son **la cuenta del
 * proveedor**, y es la que factura. No son intercambiables: 📏 el libro interno
 * **no incluye** las requests de los spikes (hueco medido de 93 tras la fila
 * 21), que se hicieron antes de que existiera.
 *
 * Por eso aquí **no se corrige el libro** ni se le suma ningún desfase fijo:
 * inventar un «+93» sería afirmar una cifra que solo el proveedor conoce. Se
 * lee su contador tal cual y, si ha llegado al 90 % de lo concedido, **no se
 * permite otra request en esa ejecución**.
 *
 * ── Tres cierres, tres motivos ──────────────────────────────────────────────
 *
 *   · `cuota_del_proveedor` · `umbral_alcanzado` → `budget_stopped`.
 *   · `cuota_del_proveedor` · `cabeceras_ausentes_o_invalidas` → `budget_stopped`.
 *   · `ciclo_desalineado` → **`failed`**. `x-quota-reset` no coincide con el
 *     `fin` del ciclo del libro: la configuración está mal, y seguir
 *     atribuiría cuota al mes equivocado. Es la comprobación que sustituye a
 *     cualquier desfase fijo entre nuestra frontera y la suya.
 *
 * ── La guardia sobrevive a la ejecución ─────────────────────────────────────
 *
 * Una guardia vive en memoria y cada ejecución arranca con la suya abierta.
 * Con un cron, eso significaría gastar **una request al día** para volver a
 * descubrir que el proveedor sigue por encima del 90 %. `buscarCorteVigente`
 * lee el último corte **ya registrado** en `error_samples` y, si su
 * `x-quota-reset` todavía no ha llegado, la guardia nace cerrada: 0 requests.
 */
import type { CicloDePresupuesto, EjecutorSql, NombreDePipeline } from "./contratos.ts";
import { PresupuestoAgotado, idDeEjecucion } from "./contratos.ts";

/**
 * El mismo 90 % del Plan §8.5, aplicado a lo que el proveedor dice haber
 * concedido. Constante propia y no `fraccionDeCorte`: esa es configurable, y
 * relajarla no puede aflojar también la comprobación externa.
 */
export const FRACCION_DE_CORTE_DEL_PROVEEDOR = 0.9;

export const CABECERA_USADA = "x-quota-used";
export const CABECERA_CONCEDIDA = "x-quota-granted";
export const CABECERA_REINICIO = "x-quota-reset";

/** Lo que dijo el proveedor en una respuesta, ya validado. */
export interface CuotaDelProveedor {
  readonly usada: number;
  readonly concedida: number;
  /** Tal y como llega: ISO 8601 en UTC. */
  readonly reinicio: string;
  /** `floor(concedida × 0,90)`. `floor`, nunca `round`: no se rebasa por un decimal. */
  readonly umbral: number;
}

function entero(valor: string | null): number | null {
  if (valor === null || !/^\d+$/.test(valor.trim())) return null;
  const n = Number.parseInt(valor.trim(), 10);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Lee las tres cabeceras. **`null` si falta alguna o no se entiende**: no se
 * rellena con un valor por defecto, porque un contador inventado es peor que
 * ninguno (CLAUDE.md, regla 7).
 */
export function leerCuotaDelProveedor(cabeceras: Headers): CuotaDelProveedor | null {
  const usada = entero(cabeceras.get(CABECERA_USADA));
  const concedida = entero(cabeceras.get(CABECERA_CONCEDIDA));
  const reinicio = cabeceras.get(CABECERA_REINICIO)?.trim() ?? "";

  if (usada === null || concedida === null || concedida === 0) return null;
  if (reinicio === "" || Number.isNaN(Date.parse(reinicio))) return null;

  return {
    usada,
    concedida,
    reinicio,
    umbral: Math.floor(concedida * FRACCION_DE_CORTE_DEL_PROVEEDOR),
  };
}

/** Las cabeceras crudas, para auditar un caso que no se pudo leer. */
function crudas(cabeceras: Headers): Record<string, string | null> {
  return {
    [CABECERA_USADA]: cabeceras.get(CABECERA_USADA),
    [CABECERA_CONCEDIDA]: cabeceras.get(CABECERA_CONCEDIDA),
    [CABECERA_REINICIO]: cabeceras.get(CABECERA_REINICIO),
  };
}

/**
 * Un corte del proveedor que **ya se registró** en `ops_sync_runs` y cuyo
 * reinicio todavía no ha llegado.
 */
export interface CorteVigente {
  readonly runId: number;
  readonly pipeline: string;
  readonly usada: number;
  readonly umbral: number;
  readonly concedida: number;
  /** Tal y como lo anunció el proveedor. */
  readonly reinicio: string;
}

interface FilaDeCorte {
  readonly id: unknown;
  readonly pipeline: string;
  readonly muestra: Readonly<Record<string, unknown>>;
}

/**
 * Las dos claves que identifican, dentro de `error_samples`, un corte por
 * umbral. La guardia las escribe y `buscarCorteVigente` las busca **desde la
 * misma constante**: si una cambia, cambian las dos.
 */
export const MUESTRA_DE_CORTE_POR_UMBRAL = {
  motivo: "cuota_del_proveedor",
  estado: "umbral_alcanzado",
} as const;

const SQL_CORTES = `
  SELECT r.id, r.pipeline, m.muestra
    FROM ops_sync_runs r
   CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(r.error_samples) = 'array'
                THEN r.error_samples ELSE '[]'::jsonb END
         ) AS m(muestra)
   WHERE r.started_at >= $1
     AND m.muestra @> $2::jsonb
   ORDER BY r.id DESC`;

function numero(valor: unknown): number {
  return typeof valor === "number" && Number.isSafeInteger(valor) ? valor : Number.NaN;
}

/**
 * El corte del proveedor vigente, **de cualquier pipeline**: la cuota del
 * proveedor es una sola.
 *
 * Vigente = su `x-quota-reset` es **posterior a `ahora`**. Se decide con el
 * reinicio del proveedor y no con nuestro ciclo, porque es su contador el que
 * dijo «90 %» y solo su reinicio lo devuelve a cero.
 *
 * Se buscan cortes desde `ciclo.inicio`. ⚖️ Si el ciclo estuviera desalineado
 * y el corte cayera antes de nuestro inicio, no se vería: la ejecución gastaría
 * **una** request, el proveedor volvería a decir «90 %» y `ciclo_desalineado`
 * lo haría visible. El coste está acotado y el fallo no es silencioso.
 *
 * Una muestra con un `x-quota-reset` ilegible **no prearma nada**: no se
 * inventa un reinicio que nadie leyó (CLAUDE.md, regla 7).
 */
export async function buscarCorteVigente(
  ejecutorOps: EjecutorSql,
  opciones: { readonly ciclo: CicloDePresupuesto; readonly ahora: Date },
): Promise<CorteVigente | null> {
  const filas = await ejecutorOps.ejecutar<FilaDeCorte>(SQL_CORTES, [
    opciones.ciclo.inicio,
    JSON.stringify(MUESTRA_DE_CORTE_POR_UMBRAL),
  ]);

  for (const fila of filas) {
    const m = fila.muestra;
    const reinicio = typeof m.x_quota_reset === "string" ? m.x_quota_reset : null;
    if (reinicio === null) continue;
    const instante = Date.parse(reinicio);
    if (Number.isNaN(instante) || instante <= opciones.ahora.getTime()) continue;

    return {
      runId: idDeEjecucion(fila.id),
      pipeline: fila.pipeline,
      usada: numero(m.x_quota_used),
      umbral: numero(m.techo),
      concedida: numero(m.x_quota_granted),
      reinicio,
    };
  }
  return null;
}

export interface GuardiaDeCuotaExterna {
  /**
   * Se llama **antes de reservar** en el libro interno. Si la guardia está
   * cerrada lanza `PresupuestoAgotado` y no se reserva ni se llama: reservar
   * primero y negarse después sobrecontaría una request que no salió.
   */
  comprobar(): void;
  /** Se llama tras cada respuesta HTTP válida, con sus cabeceras. */
  observar(cabeceras: Headers): void;
  /**
   * Cierra la guardia **antes de la primera request** con un corte ya
   * registrado (`buscarCorteVigente`).
   */
  prearmar(corte: CorteVigente): void;
  /** Todo lo observado, en orden. Para el informe. */
  observaciones(): readonly CuotaDelProveedor[];
}

/**
 * Guardia por ejecución. **Se cierra y no se vuelve a abrir**: si el
 * proveedor dijo que estamos en el 90 %, ninguna request posterior de esa
 * ejecución puede demostrar lo contrario sin gastar otra.
 *
 * ⚖️ **Si faltan las cabeceras también se cierra.** Sin ellas no hay
 * comprobación externa, y seguir sin ella es justo lo que esta guardia existe
 * para impedir. El cierre dice por qué, con las cabeceras recibidas.
 *
 * ⚖️ **Gana el primer cierre.** Si una misma respuesta está desalineada y en
 * el umbral, se informa el desalineamiento: es un error de configuración y
 * tiene que acabar en `failed`, no esconderse detrás de un corte de cuota.
 *
 * `finDelCiclo` es **obligatorio**: sin él no hay contra qué comparar
 * `x-quota-reset`, y el ciclo del libro volvería a ser una suposición.
 */
export function crearGuardiaDeCuotaExterna(
  pipeline: NombreDePipeline,
  opciones: { readonly finDelCiclo: Date },
): GuardiaDeCuotaExterna {
  const vistas: CuotaDelProveedor[] = [];
  let cierre: PresupuestoAgotado | null = null;

  return {
    comprobar() {
      if (cierre !== null) throw cierre;
    },
    observar(cabeceras) {
      const cuota = leerCuotaDelProveedor(cabeceras);
      if (cuota === null) {
        cierre ??= new PresupuestoAgotado({
          motivo: "cuota_del_proveedor",
          pipeline,
          consumido: 0,
          techo: 0,
          contexto: {
            fuente: "cabeceras_del_proveedor",
            estado: "cabeceras_ausentes_o_invalidas",
            recibidas: crudas(cabeceras),
          },
        });
        return;
      }
      vistas.push(cuota);
      if (Date.parse(cuota.reinicio) !== opciones.finDelCiclo.getTime()) {
        cierre ??= new PresupuestoAgotado({
          motivo: "ciclo_desalineado",
          pipeline,
          consumido: cuota.usada,
          techo: cuota.umbral,
          contexto: {
            fuente: "cabeceras_del_proveedor",
            estado: "reinicio_distinto_del_fin_del_ciclo",
            x_quota_reset: cuota.reinicio,
            fin_del_ciclo: opciones.finDelCiclo.toISOString(),
          },
        });
      }
      if (cuota.usada >= cuota.umbral) {
        cierre ??= new PresupuestoAgotado({
          motivo: "cuota_del_proveedor",
          pipeline,
          consumido: cuota.usada,
          techo: cuota.umbral,
          contexto: {
            fuente: "cabeceras_del_proveedor",
            ...MUESTRA_DE_CORTE_POR_UMBRAL,
            x_quota_used: cuota.usada,
            x_quota_granted: cuota.concedida,
            x_quota_reset: cuota.reinicio,
          },
        });
      }
    },
    prearmar(corte) {
      // La muestra que deja tiene la MISMA forma que un corte observado, más
      // su origen: así la ejecución siguiente también la encuentra, y la
      // cadena no se rompe hasta que llega el reinicio del proveedor.
      cierre ??= new PresupuestoAgotado({
        motivo: "cuota_del_proveedor",
        pipeline,
        consumido: corte.usada,
        techo: corte.umbral,
        contexto: {
          fuente: "corte_registrado",
          ...MUESTRA_DE_CORTE_POR_UMBRAL,
          x_quota_used: corte.usada,
          x_quota_granted: corte.concedida,
          x_quota_reset: corte.reinicio,
          prearmada_por_run_id: corte.runId,
          prearmada_por_pipeline: corte.pipeline,
        },
      });
    },
    observaciones: () => [...vistas],
  };
}
