/**
 * Ciclo de facturación, techos y **reserva de cuota**.
 *
 * ── La idea que sostiene todo ───────────────────────────────────────────────
 *
 * `requests_made` **no se escribe al terminar**: se incrementa ANTES de cada
 * llamada, en una transacción propia que se confirma de inmediato. Si el
 * proceso muere, la request reservada **sigue contada**.
 *
 * El error va siempre en la dirección segura —sobrecontar, nunca liberar cuota
 * ya gastada— y el sobreconteo máximo por caída es de **una request**, porque
 * se reserva de una en una y no hay devolución de sobrante.
 *
 * No existe ningún contador en memoria: **la fuente de verdad es la fila**.
 *
 * ── Qué NO hace este fichero ────────────────────────────────────────────────
 *
 * No sabe llamar a nadie. `transporte.ts` es el único que toca `fetch`, y no
 * puede hacerlo sin una reserva concedida aquí.
 */
import { bloquearCiclo } from "./bloqueo.ts";
import type {
  CicloDePresupuesto,
  EjecutorSql,
  NombreDePipeline,
  Presupuesto,
  Reserva,
} from "./contratos.ts";
import { NOMBRES_DE_PIPELINE } from "./contratos.ts";

/**
 * **La zona de facturación: UTC.** 📏 El proveedor reinicia la cuota a las
 * 00:00 UTC (`x-quota-reset: 2026-10-01T00:00:00Z`, `spike-1/raw/018` y
 * `ops_sync_runs` fila 21). El ciclo se calcula aquí, en UTC, y nunca en la
 * zona del servidor.
 *
 * ⚠️ **No es la zona editorial.** El *bucket* diario del histórico sigue en
 * `Europe/Madrid` (`tiempo.ts`), y los dos conceptos no se mezclan.
 */
export const ZONA_DE_FACTURACION = "UTC";

/**
 * **Guardrails provisionales de MEDICIÓN MANUAL. No son presupuesto aprobado.**
 *
 * Un pipeline aparece aquí cuando **no tiene presupuesto ni cadencia
 * aprobados** —su tope por ejecución es 0— pero se mide a mano, con `--real
 * --tope <n>` y autorización explícita cada vez. Su valor entra en
 * `TECHO_MENSUAL_POR_DEFECTO`, porque es lo que `reservar()` consulta, y hace
 * de límite de seguridad para esas mediciones:
 *
 *   · acota el `--tope` de cada medición (`exigirTopeDeMedicion`);
 *   · acota lo que **todas las mediciones del ciclo juntas** pueden gastar
 *     (`mensual_del_pipeline` en `decidirReserva`).
 *
 * **No autoriza nada por sí solo**: con tope 0, ni `pnpm job` ni un workflow
 * pueden gastar una request. Un test exige que todo pipeline de este mapa
 * tenga tope 0; si alguno se aprueba, sale de aquí y su techo pasa a ser una
 * decisión propia, documentada como las de `deltas`, `expiring` y `upcoming`.
 *
 * ⚠️ **No se pone a 0 para «borrar» la cifra**: con techo 0, `decidirReserva`
 * deniega la primera reserva y `--ensayo`, `--reproducir` y `--real` dejarían
 * de funcionar.
 *
 * ── `updated: 48` ───────────────────────────────────────────────────────────
 *
 *   · Nació como la estimación **semanal** de antes de medir (`~48/mes`,
 *     Spike 1). Esa estimación está **retirada** (`docs/DATA-SOURCES.md` §1.8).
 *   · 📏 La medición real de 24 h (filas 58–60) gastó 11: cabe, y deja margen
 *     para otra medición en el mismo ciclo sin que el umbral global de 900 sea
 *     la única defensa.
 *   · 🔁 Se sustituye por un techo de verdad —o sale del mapa— cuando se
 *     decida la cadencia de `updated`, con un catálogo representativo.
 */
export const GUARDRAIL_DE_MEDICION_MANUAL = {
  updated: 48,
} as const satisfies Partial<Record<NombreDePipeline, number>>;

/**
 * **Techo MENSUAL por pipeline: requests por ciclo.**
 *
 * ⚠️ Aquí solo entran cifras cuya unidad sea de verdad mensual. Hoy solo hay
 * dos clases de cifra distinta de 0, y ninguna es una estimación de consumo:
 *
 *   · **Presupuesto aprobado** — `deltas`, `expiring` y `upcoming`: límites
 *     operativos derivados de su tope (ver abajo), no cifras de la tabla
 *     «Requests/mes» de `docs/DATA-SOURCES.md` §1.8.
 *   · **Guardrail de medición manual** — `updated`, sin presupuesto ni
 *     cadencia (`GUARDRAIL_DE_MEDICION_MANUAL`).
 *
 * Todo lo demás vale 0: **sin presupuesto aprobado**.
 *
 * ⚖️ **`seed` y `reconcile` valen 0 aunque tengan cifra documentada**, porque
 * su ~272 es el coste de **un recorrido completo**, no un régimen mensual.
 * Convertir esa cifra en un techo de ciclo fue el defecto que este reparto
 * corrige: el número decía otra cosa. Vive donde le corresponde, en
 * `costes-medidos.ts`, y de allí no autoriza nada.
 *
 * ⚖️ **Cero significa «no autorizado a consumir API», nunca «sin límite».**
 * Registrar un pipeline nuevo obliga así a decidir su cuota a propósito.
 *
 * La suma de los techos mensuales es **272** —224 de presupuesto aprobado
 * (124 + 60 + 40) más el guardrail de medición de `updated` (48), que no es
 * presupuesto—, por debajo del umbral global de 900: margen de **628** — pero
 * **el global manda siempre**, y lo seguiría haciendo aunque la suma lo
 * superase. Los techos por pipeline son máximos, no reservas.
 *
 * ── `popularity: 0` — sin presupuesto aprobado (2026-09-26) ─────────────────
 *
 * Valía **343**: la estimación histórica del Spike 1 para una captura de
 * popularidad de Netflix (~300 diaria de `1week` + ~43 semanal de `1month`).
 * Nunca fue presupuesto: `popularity` **no tiene pipeline construido, ni tope,
 * ni cadencia aprobados**, y con tope 0 no podía gastar ni una request. Un
 * techo de 343 solo inflaba la suma. Cuando exista el pipeline, su techo y su
 * tope se deciden por separado y con medición, como los de `deltas`,
 * `expiring` y `upcoming`.
 *
 * ── `deltas: 124` — decidido el 2026-09-23 (opción C) ────────────────────
 *
 *   · 📏 **Lo medido:** el régimen normal es **2 requests/día** (1 `removed` +
 *     1 `new`; fila 21 y `spike-1/daily.json`, dos ventanas de 24 h). A ese
 *     ritmo, un ciclo de 31 días son ~62.
 *   · ⚖️ **124 NO es una previsión de consumo.** Es `31 días × tope por
 *     ejecución 4`: un **límite operativo** para que el techo mensual no
 *     bloquee nunca una ejecución diaria que ya está limitada por su tope de 4.
 *     Para `deltas`, un corte mensual no ahorra cuota: los cambios siguen ahí,
 *     el checkpoint se congela y la ventana crece hasta el mes siguiente. Con
 *     124, este techo solo frena ejecuciones **de más** —reanudaciones manuales,
 *     un cron mal configurado—.
 *   · 🛡️ **Las defensas superiores siguen siendo otras:** el umbral global de
 *     900 (`umbralGlobal`) y la cuota del proveedor (`x-quota-*`, guardia
 *     externa en `cuota-proveedor.ts`).
 *   · 🔁 **Se revisará tras ~30 días de funcionamiento real**, con el consumo
 *     observado en `ops_sync_runs`.
 *
 * Sustituye al 60 anterior, que era un defecto conocido: 31 × 2 = 62 > 60, así
 * que un cron diario habría cortado por `mensual_del_pipeline` en un mes normal.
 *
 * ── `expiring: 60` — aprobado el 2026-09-24 ────────────────────────────────
 *
 *   · 📏 **Lo medido:** un recorrido completo del horizonte de 31 días cuesta
 *     **6 requests** (`ops_sync_runs` fila 44: 6 páginas, 142 avisos).
 *   · ⚖️ **60 = 5 ejecuciones × tope 12.** Cadencia objetivo semanal, y un
 *     ciclo de 31 días empieza como mucho **5** semanas. Es un **máximo**, no
 *     una previsión.
 *   · 📐 **Consumo esperado con lo medido: ~24–30 requests/mes** (4–5
 *     recorridos × 6). Es una cuenta, no una observación del régimen.
 *   · 🔁 **Se revisará tras unas semanas de ejecuciones reales**, con el
 *     consumo que registre `ops_sync_runs`.
 *
 * Sustituye al 150, la estimación de un `expiring` diario anterior a medirlo.
 *
 * ── `upcoming: 40` — aprobado el 2026-09-24 ────────────────────────────────
 *
 *   · 📏 **Lo medido:** un recorrido completo del horizonte de 31 días cuesta
 *     **3 requests** (`ops_sync_runs` fila 50: 3 páginas, 63 avisos). Una sola
 *     observación.
 *   · ⚖️ **40 = 5 ejecuciones × tope 8.** Cadencia objetivo semanal, y un
 *     ciclo de 31 días empieza como mucho **5** semanas. Es un **máximo**, no
 *     una previsión: una sexta ejecución al tope no cabe.
 *   · 📐 **Consumo esperado con lo medido: ~12–15 requests/mes** (4–5
 *     recorridos × 3). Es una cuenta, no una observación del régimen.
 *   · 🔁 **Se revisará tras unas semanas de ejecuciones reales**, con el
 *     consumo que registre `ops_sync_runs`.
 *
 * Sustituye al 90, la estimación de un `upcoming` diario anterior a medirlo.
 *
 * ── `updated: 48` — NO es presupuesto aprobado ─────────────────────────────
 *
 * Es `GUARDRAIL_DE_MEDICION_MANUAL.updated`, un límite de seguridad para las
 * mediciones manuales (ver arriba). Su tope sigue en 0.
 */
export const TECHO_MENSUAL_POR_DEFECTO: Readonly<Record<NombreDePipeline, number>> = {
  // 31 días × tope 4. Límite operativo, no previsión: ver el comentario.
  deltas: 124,
  // 5 ejecuciones × tope 12. Máximo, no previsión: ver el comentario.
  expiring: 60,
  // 5 ejecuciones × tope 8. Máximo, no previsión: ver el comentario.
  upcoming: 40,
  // Guardrail de medición manual, NO presupuesto aprobado: su tope es 0.
  updated: GUARDRAIL_DE_MEDICION_MANUAL.updated,
  // Cifra documentada por recorrido, no mensual: ver costes-medidos.ts.
  seed: 0,
  reconcile: 0,
  // Sin presupuesto aprobado. `popularity` valía 343, una estimación
  // histórica: ver el comentario.
  popularity: 0,
  enrich: 0,
  scoring: 0,
  // Técnico y manual: el harness de validación inyecta el suyo (5) dentro de
  // su propio proceso. Aquí, cerrado como todo lo demás.
  changes_validation: 0,
};

/**
 * **Tope duro de subrequests de UNA ejecución** (Plan §8.5).
 *
 * ⚠️ **Configuración explícita e independiente. Jamás se deriva del techo
 * mensual.** Ese fallback existió, y convirtió este cerrojo en un adorno: para
 * un pipeline diario, el tope pasaba a ser el agregado del mes entero y no
 * saltaba nunca. Hay un test que impide que vuelva.
 *
 * ⚖️ **Todos a 0 salvo `deltas`, `expiring` y `upcoming`, a propósito.** Ningún otro job
 * está aprobado para gastar API. Los tests y `pnpm db:validate:ops` inyectan su propia
 * configuración con topes > 0 para demostrar el mecanismo — **no se habilita
 * ningún pipeline real para que una prueba pase**.
 *
 * **`deltas: 4` — aprobado el 2026-09-23 (Paso 5).**
 *   · 📏 Medido: un día normal cuesta **2** (1 `removed` + 1 `new`; fila 21 y
 *     `spike-1/daily.json`, dos ventanas de 24 h).
 *   · ⚖️ Decisión, no medida: 4 = el doble. Es un **cerrojo**, no una
 *     predicción: la quinta página no se pierde, queda pendiente en
 *     `ops_sync_runs.checkpoint` y la reanuda la ejecución siguiente (ADR 0006).
 *     Quedarse corto cuesta un día de latencia; pasarse lo acota el techo
 *     mensual.
 *
 * **`expiring: 12` — aprobado el 2026-09-24.**
 *   · 📏 Medido: un recorrido completo de 31 días cuesta **6** (fila 44).
 *   · ⚖️ Decisión, no medida: 12 = el doble. Es **margen operativo**, no una
 *     previsión. Si aun así se corta, **no se reanuda**: el siguiente recorre
 *     su horizonte desde el principio, y el cortado no mide ausencias
 *     (`jobs/pipelines/expiring/horizonte.ts`).
 *
 * **`upcoming: 8` — aprobado el 2026-09-24.**
 *   · 📏 Medido: un recorrido completo de 31 días cuesta **3** (fila 50).
 *   · ⚖️ Decisión, no medida: 8 = más del doble. Es **margen operativo**, no
 *     una previsión. Si aun así se corta, **no se reanuda**: el siguiente
 *     recorre su horizonte desde el principio, y el cortado no mide
 *     desapariciones (`jobs/pipelines/upcoming/horizonte.ts`).
 */
export const TOPE_POR_EJECUCION_POR_DEFECTO: Readonly<
  Record<NombreDePipeline, number>
> = {
  seed: 0,
  deltas: 4,
  expiring: 12,
  upcoming: 8,
  updated: 0,
  popularity: 0,
  reconcile: 0,
  enrich: 0,
  scoring: 0,
  changes_validation: 0,
};

/**
 * Excepciones justificadas a `topePorEjecucion <= techoMensualPorPipeline`.
 *
 * El invariante se comprueba al leer la configuración. Saltárselo exige
 * **escribir aquí el motivo**, que queda en el repositorio y en el diff.
 * **Hoy no hay ninguna, y esa es la respuesta correcta.**
 */
export const EXCEPCIONES_AL_INVARIANTE: Readonly<
  Partial<Record<NombreDePipeline, string>>
> = {};

const PRESUPUESTO_POR_DEFECTO = 1000;
const FRACCION_POR_DEFECTO = 0.9;
const DIA_POR_DEFECTO = 1;

/**
 * 1–28 por construcción: elimina los meses sin día 29, 30 o 31.
 *
 * El día se interpreta en **UTC**. Sigue siendo configurable porque solo se ha
 * observado **un** reinicio del proveedor (el 1 de octubre): no sabemos si su
 * ciclo es el mes natural o una fecha de alta. La guardia externa lo
 * comprueba contra `x-quota-reset` en cada respuesta.
 */
export const DIA_DE_CICLO_MAXIMO = 28;

function fallar(motivo: string): never {
  throw new Error(
    `Configuración de presupuesto inválida.\n  ${motivo}\n` +
      `  Nada cae a un valor por defecto en silencio: un techo equivocado se gasta una sola vez.`,
  );
}

function enteroNoNegativo(bruto: string, nombre: string): number {
  if (!/^\d+$/.test(bruto.trim())) {
    fallar(`${nombre} tiene que ser un entero en base 10. Valor: "${bruto}".`);
  }
  const valor = Number.parseInt(bruto.trim(), 10);
  if (!Number.isSafeInteger(valor)) fallar(`${nombre} no es un entero representable.`);
  return valor;
}

// ── El ciclo ────────────────────────────────────────────────────────────────

/** Las 00:00 UTC de un día de calendario. Sin cambio de hora que corregir. */
function medianocheUtc(anio: number, mes: number, dia: number): Date {
  return new Date(Date.UTC(anio, mes - 1, dia));
}

/**
 * El ciclo `[inicio, fin)` que contiene a `ahora`, **en UTC**.
 *
 * ⚖️ **Sin desfases fijos.** No se suma ninguna hora a una frontera de Madrid:
 * se calcula directamente en la zona en la que factura el proveedor. Y no se
 * da por hecho que acierte: la guardia externa compara `fin` con la cabecera
 * `x-quota-reset` de cada respuesta y, si no coinciden, corta la ejecución
 * como `ciclo_desalineado` (`cuota-proveedor.ts`).
 *
 * `clave` es `YYYYMM` del **inicio**: la clave del advisory lock del ciclo.
 */
export function calcularCiclo(ahora: Date, diaDeCiclo: number): CicloDePresupuesto {
  let anio = ahora.getUTCFullYear();
  let mes = ahora.getUTCMonth() + 1;

  // Si todavía no hemos llegado al día de corte de este mes, el ciclo vigente
  // empezó el mes pasado. Se compara con instantes, no con números de día: el
  // borde exacto tiene que caer del lado correcto.
  if (ahora.getTime() < medianocheUtc(anio, mes, diaDeCiclo).getTime()) {
    mes -= 1;
    if (mes === 0) {
      mes = 12;
      anio -= 1;
    }
  }

  let anioFin = anio;
  let mesFin = mes + 1;
  if (mesFin === 13) {
    mesFin = 1;
    anioFin += 1;
  }

  return {
    inicio: medianocheUtc(anio, mes, diaDeCiclo),
    fin: medianocheUtc(anioFin, mesFin, diaDeCiclo),
    clave: anio * 100 + mes,
  };
}

// ── Los techos ──────────────────────────────────────────────────────────────

/**
 * `floor`, nunca `round`: redondear hacia arriba permitiría rebasar el 90 % por
 * un decimal, y el sentido entero de este número es no rebasarlo.
 */
export function calcularUmbralGlobal(presupuesto: number, fraccion: number): number {
  return Math.floor(presupuesto * fraccion);
}

function esNombreDePipeline(valor: string): valor is NombreDePipeline {
  return (NOMBRES_DE_PIPELINE as readonly string[]).includes(valor);
}

/**
 * Lee un mapa `nombre=entero` de una variable de entorno.
 *
 * `variable` viaja en el mensaje de error a propósito: los dos mapas tienen la
 * misma forma y unidades distintas, y un error que no diga cuál de los dos se
 * está leyendo es justo el que deja pasar una cifra en la unidad equivocada.
 */
function leerMapaDePipelines(
  bruto: string | undefined,
  base: Readonly<Record<NombreDePipeline, number>>,
  variable: string,
): Record<NombreDePipeline, number> {
  const mapa: Record<NombreDePipeline, number> = { ...base };
  if (bruto === undefined || bruto.trim() === "") return mapa;

  for (const trozo of bruto.split(",")) {
    const [nombre, valor] = trozo.split("=");
    if (nombre === undefined || valor === undefined) {
      fallar(`${variable}: "${trozo}" no tiene forma nombre=entero.`);
    }
    const limpio = nombre.trim();
    if (!esNombreDePipeline(limpio)) {
      fallar(
        `${variable} nombra un pipeline desconocido: "${limpio}".
` + `  Vocabulario cerrado: ${NOMBRES_DE_PIPELINE.join(", ")}.`,
      );
    }
    mapa[limpio] = enteroNoNegativo(valor, `${variable}["${limpio}"]`);
  }
  return mapa;
}

/**
 * Lee y **valida** la configuración. Cualquier valor inválido aborta aquí,
 * antes de que exista una conexión — el mismo criterio que las guardas de
 * `drizzle.migrate.config.ts`.
 */
export function leerPresupuesto(
  entorno: Readonly<Partial<Record<string, string>>> = process.env,
): Presupuesto {
  const brutoPresupuesto = entorno.STREAMING_API_MONTHLY_BUDGET;
  const presupuestoMensual =
    brutoPresupuesto === undefined || brutoPresupuesto.trim() === ""
      ? PRESUPUESTO_POR_DEFECTO
      : enteroNoNegativo(brutoPresupuesto, "STREAMING_API_MONTHLY_BUDGET");
  if (presupuestoMensual === 0) {
    fallar("STREAMING_API_MONTHLY_BUDGET no puede ser 0: no habría nada que gastar.");
  }

  const brutoFraccion = entorno.STREAMING_API_BUDGET_STOP_FRACTION;
  let fraccionDeCorte = FRACCION_POR_DEFECTO;
  if (brutoFraccion !== undefined && brutoFraccion.trim() !== "") {
    if (!/^\d*\.?\d+$/.test(brutoFraccion.trim())) {
      fallar(
        `STREAMING_API_BUDGET_STOP_FRACTION tiene que ser decimal. Valor: "${brutoFraccion}".`,
      );
    }
    fraccionDeCorte = Number.parseFloat(brutoFraccion.trim());
    if (!(fraccionDeCorte > 0 && fraccionDeCorte <= 1)) {
      fallar(
        `STREAMING_API_BUDGET_STOP_FRACTION tiene que estar en (0, 1]. Valor: ${String(fraccionDeCorte)}.`,
      );
    }
  }

  const brutoDia = entorno.STREAMING_API_BUDGET_CYCLE_DAY;
  const diaDeCiclo =
    brutoDia === undefined || brutoDia.trim() === ""
      ? DIA_POR_DEFECTO
      : enteroNoNegativo(brutoDia, "STREAMING_API_BUDGET_CYCLE_DAY");
  if (diaDeCiclo < 1 || diaDeCiclo > DIA_DE_CICLO_MAXIMO) {
    fallar(
      `STREAMING_API_BUDGET_CYCLE_DAY tiene que estar entre 1 y ${String(DIA_DE_CICLO_MAXIMO)}.\n` +
        `  El 28 es el tope para que la frontera exista en todos los meses. Valor: ${String(diaDeCiclo)}.`,
    );
  }

  // ── Los dos mapas, leídos por separado y con unidades distintas ─────────
  //
  // ⚠️ NO hay fallback de uno al otro, y no puede haberlo. Que el tope por
  //    ejecución heredara el techo mensual convirtió el cerrojo del Plan §8.5
  //    en un adorno: para un pipeline diario pasaba a valer el agregado del
  //    mes y no saltaba jamás. Son dos configuraciones independientes.
  const techoMensualPorPipeline = leerMapaDePipelines(
    entorno.STREAMING_API_MONTHLY_PIPELINE_BUDGETS,
    TECHO_MENSUAL_POR_DEFECTO,
    "STREAMING_API_MONTHLY_PIPELINE_BUDGETS",
  );
  const topePorEjecucion = leerMapaDePipelines(
    entorno.STREAMING_API_PER_RUN_CAPS,
    TOPE_POR_EJECUCION_POR_DEFECTO,
    "STREAMING_API_PER_RUN_CAPS",
  );

  // Invariante: una sola ejecución no puede tener permiso para gastar más de
  // lo que su pipeline tiene en todo el ciclo. Saltárselo exige escribir el
  // motivo en EXCEPCIONES_AL_INVARIANTE, que queda en el diff.
  for (const nombre of NOMBRES_DE_PIPELINE) {
    const mensual = techoMensualPorPipeline[nombre];
    const porEjecucion = topePorEjecucion[nombre];
    if (
      mensual > 0 &&
      porEjecucion > mensual &&
      EXCEPCIONES_AL_INVARIANTE[nombre] === undefined
    ) {
      fallar(
        `"${nombre}": el tope por ejecución (${String(porEjecucion)}) supera su techo
` +
          `  mensual (${String(mensual)}). O es un error de unidades, o es una excepción
` +
          `  deliberada — y entonces su motivo va en EXCEPCIONES_AL_INVARIANTE.`,
      );
    }
  }

  return {
    presupuestoMensual,
    fraccionDeCorte,
    umbralGlobal: calcularUmbralGlobal(presupuestoMensual, fraccionDeCorte),
    diaDeCiclo,
    techoMensualPorPipeline,
    topePorEjecucion,
  };
}

// ── La decisión ─────────────────────────────────────────────────────────────

/**
 * Función **pura**: dados los consumos y los techos, ¿cabe una request más?
 *
 * La comparación es `consumido + coste > techo → denegar`, de modo que con un
 * umbral de 900: 899 + 1 = 900 **se concede**, y 900 + 1 = 901 **se deniega**.
 * El gasto máximo del ciclo es exactamente el umbral.
 *
 * El orden importa para el motivo que se informa: **el global manda**, así que
 * se comprueba primero.
 */
export function decidirReserva(entrada: {
  readonly coste: number;
  readonly total: number;
  readonly delPipeline: number;
  readonly deEstaEjecucion: number;
  readonly umbralGlobal: number;
  readonly techoMensualDelPipeline: number;
  readonly topeDeLaEjecucion: number;
}): Reserva {
  const { coste } = entrada;

  if (entrada.total + coste > entrada.umbralGlobal) {
    return {
      concedida: false,
      motivo: "global",
      consumido: entrada.total,
      techo: entrada.umbralGlobal,
    };
  }
  if (entrada.delPipeline + coste > entrada.techoMensualDelPipeline) {
    return {
      concedida: false,
      motivo: "mensual_del_pipeline",
      consumido: entrada.delPipeline,
      techo: entrada.techoMensualDelPipeline,
    };
  }
  if (entrada.deEstaEjecucion + coste > entrada.topeDeLaEjecucion) {
    return {
      concedida: false,
      motivo: "tope_por_ejecucion",
      consumido: entrada.deEstaEjecucion,
      techo: entrada.topeDeLaEjecucion,
    };
  }
  return { concedida: true, consumidoTrasReservar: entrada.total + coste };
}

interface Consumos {
  readonly total: number;
  readonly del_pipeline: number;
  readonly de_esta: number;
}

const SQL_CONSUMO = `
  SELECT coalesce(sum(requests_made), 0)::int                              AS total,
         coalesce(sum(requests_made) FILTER (WHERE pipeline = $3), 0)::int AS del_pipeline,
         coalesce(sum(requests_made) FILTER (WHERE id = $4), 0)::int       AS de_esta
    FROM ops_sync_runs
   WHERE started_at >= $1 AND started_at < $2`;

/**
 * Pide cuota para **una** llamada y, si se concede, la deja escrita y
 * confirmada antes de volver.
 *
 * La suma incluye **toda fila del ciclo, sea cual sea su estado**: una
 * ejecución huérfana gastó cuota de verdad y sigue contando. Su
 * `requests_made` no se corrige ni se reinventa.
 */
export async function reservar(
  ejecutorOps: EjecutorSql,
  opciones: {
    readonly runId: number;
    readonly pipeline: NombreDePipeline;
    readonly presupuesto: Presupuesto;
    /** Clave del ciclo al que pertenece la fila de esta ejecución. */
    readonly cicloDeLaEjecucion: number;
    readonly ahora?: Date;
    readonly coste?: number;
  },
): Promise<Reserva> {
  const coste = opciones.coste ?? 1;
  if (!Number.isSafeInteger(coste) || coste < 1) {
    throw new Error(
      `El coste de una reserva es un entero mayor o igual que 1. Recibido: ${String(coste)}.`,
    );
  }

  const ahora = opciones.ahora ?? new Date();
  const ciclo = calcularCiclo(ahora, opciones.presupuesto.diaDeCiclo);

  // El ciclo cambió mientras esta ejecución corría. Su fila quedaría atribuida
  // al ciclo viejo por `started_at` mientras el guardián compara contra el
  // nuevo. Atribuir cuota al mes equivocado en silencio sería peor que parar.
  if (ciclo.clave !== opciones.cicloDeLaEjecucion) {
    return {
      concedida: false,
      motivo: "frontera_de_ciclo",
      consumido: 0,
      techo: opciones.presupuesto.umbralGlobal,
    };
  }

  await ejecutorOps.ejecutar("BEGIN");
  try {
    await bloquearCiclo(ejecutorOps, ciclo.clave);

    const filas = await ejecutorOps.ejecutar<Consumos>(SQL_CONSUMO, [
      ciclo.inicio,
      ciclo.fin,
      opciones.pipeline,
      opciones.runId,
    ]);
    const consumos = filas[0];
    if (consumos === undefined) {
      throw new Error("La consulta de consumo no devolvió ninguna fila.");
    }

    const decision = decidirReserva({
      coste,
      total: consumos.total,
      delPipeline: consumos.del_pipeline,
      deEstaEjecucion: consumos.de_esta,
      umbralGlobal: opciones.presupuesto.umbralGlobal,
      techoMensualDelPipeline:
        opciones.presupuesto.techoMensualPorPipeline[opciones.pipeline],
      topeDeLaEjecucion: opciones.presupuesto.topePorEjecucion[opciones.pipeline],
    });

    if (!decision.concedida) {
      // Nada que deshacer, pero la transacción tiene que cerrarse igualmente:
      // sostiene el lock del ciclo y lo bloquearía para todos los demás.
      await ejecutorOps.ejecutar("ROLLBACK");
      return decision;
    }

    await ejecutorOps.ejecutar(
      "UPDATE ops_sync_runs SET requests_made = requests_made + $1 WHERE id = $2",
      [coste, opciones.runId],
    );
    await ejecutorOps.ejecutar("COMMIT");
    return decision;
  } catch (error) {
    await ejecutorOps.ejecutar("ROLLBACK");
    throw error;
  }
}
