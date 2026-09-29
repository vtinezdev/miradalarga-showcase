/**
 * Lo que comparten las ejecuciones **manuales** de los pipelines de
 * `/changes` (`run-deltas-manual.ts`, `run-expiring-manual.ts`): conexión,
 * guardas de destino, presupuesto inyectado, respuestas servidas desde disco
 * y el recuento de comprobaciones.
 *
 * No contiene ninguna decisión de pipeline: cada script decide su tope, sus
 * fixtures y sus comprobaciones.
 */
import { isAbsolute, join, relative, sep } from "node:path";

import { Client, neonConfig } from "@neondatabase/serverless";

import type {
  EjecutorSql,
  NombreDePipeline,
  Presupuesto,
} from "../jobs/ops/contratos.ts";
import { describirFallo, sanearTexto } from "../jobs/ops/diagnostico.ts";
import {
  GUARDRAIL_DE_MEDICION_MANUAL,
  TECHO_MENSUAL_POR_DEFECTO,
  TOPE_POR_EJECUCION_POR_DEFECTO,
  leerPresupuesto,
} from "../jobs/ops/presupuesto.ts";
import type { FuenteDeCuota, Transporte } from "../jobs/ops/transporte.ts";
import type { RegimenDeArranque } from "../jobs/pipelines/arranque.ts";
import {
  congelacionDelDestino,
  explicarCongelacion,
  regimenDelDestino,
} from "../jobs/pipelines/arranque.ts";
import type { Comprobacion } from "../jobs/pipelines/deltas/auditoria.ts";
import type { CheckpointDeCambios } from "../jobs/pipelines/deltas/checkpoint.ts";
import type { ResultadoDelJobDeCambios } from "../jobs/pipelines/deltas/job.ts";

// ── Utilidades de salida ────────────────────────────────────────────────────

export const comprobaciones: Comprobacion[] = [];

export function comprobar(nombre: string, ok: boolean, detalle = ""): void {
  comprobaciones.push({ nombre, ok, detalle });
  console.log(
    `  ${ok ? "✅" : "❌"} ${nombre}${detalle === "" ? "" : ` — ${detalle}`}`,
  );
}

export function seccion(titulo: string): void {
  console.log(`\n── ${titulo} ${"─".repeat(Math.max(3, 70 - titulo.length))}`);
}

export function sello(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function tabla(recuentos: Readonly<Record<string, number>>): void {
  for (const [nombre, n] of Object.entries(recuentos)) {
    console.log(`    ${nombre.padEnd(32)} ${String(n).padStart(7)}`);
  }
}

const RAIZ_DEL_REPOSITORIO = join(import.meta.dirname, "..");

/**
 * Una ruta que se puede **copiar y pegar en cualquier shell**: relativa a la
 * raíz del repositorio y con `/`.
 *
 * 📏 Impresa con `\`, la ruta absoluta de Windows se rompe en un shell POSIX
 * (Git Bash, o el botón Run de un bloque `bash`) si se pega sin comillas: las
 * `\` desaparecen, `…\webseriesypelis\.expiring-runs\…` llega como
 * `…webseriesypelis.expiring-runs…`, y `sanearTexto` redacta además ese
 * bloque pegado como si fuera un token. Node acepta `/` también en Windows, y
 * los scripts resuelven la ruta contra la raíz del repositorio.
 */
export function rutaCopiable(ruta: string): string {
  const relativa = relative(RAIZ_DEL_REPOSITORIO, ruta);
  const dentro = relativa !== "" && !relativa.startsWith("..") && !isAbsolute(relativa);
  return (dentro ? relativa : ruta).split(sep).join("/");
}

/**
 * **¿Mismo valor JSON?** Sin depender del orden de las claves. Vive con la
 * reproducción de los recorridos del horizonte, que también la usa para
 * comparar manifiestos; aquí se reexporta para los scripts.
 */
export { mismoValorJson } from "../jobs/pipelines/horizonte/reproduccion.ts";

/** El balance final: sale con 1 si alguna comprobación falló. */
export function cerrarComprobaciones(): void {
  const fallidas = comprobaciones.filter((c) => !c.ok);
  console.log(
    `\n${fallidas.length === 0 ? "✅" : "❌"} ${String(comprobaciones.length - fallidas.length)}/` +
      `${String(comprobaciones.length)} comprobaciones`,
  );
  if (fallidas.length > 0) process.exitCode = 1;
}

/** Para `principal().catch(...)`: el mensaje saneado y código 1. */
export function fallar(error: unknown): void {
  const m = error instanceof Error ? error.message : String(error);
  console.error(`\n${sanearTexto(m)}`);
  process.exitCode = 1;
}

// ── Conexión ────────────────────────────────────────────────────────────────

export interface Conexion {
  readonly cliente: Client;
  readonly ejecutor: EjecutorSql;
}

export async function conectar(url: string): Promise<Conexion> {
  const cliente = new Client(url);
  cliente.on("error", () => undefined);
  try {
    await cliente.connect();
  } catch (error) {
    const m = error instanceof Error ? error.message : String(error);
    throw new Error(`No se pudo conectar: ${sanearTexto(m)}`);
  }
  return {
    cliente,
    ejecutor: {
      async ejecutar<T>(texto: string, valores: readonly unknown[] = []) {
        const r: { rows: unknown[] } = await cliente.query(texto, [...valores]);
        return r.rows as readonly T[];
      },
    },
  };
}

/**
 * **El régimen de arranque de los scripts manuales, declarado.** Solo alcanzan
 * `drizzle-schema-v1-test` —las guardas de `drizzle.migrate.config.ts` corren
 * antes de abrir un socket—, que es el destino histórico: su excepción se pide
 * por su nombre exacto, no se hereda de un valor por defecto (`arranque.ts`).
 */
export const REGIMEN_DE_LOS_SCRIPTS: RegimenDeArranque = regimenDelDestino(
  "drizzle-schema-v1-test",
);

/** Las guardas de `drizzle.migrate.config.ts`, antes de abrir un socket. */
export async function destinoVerificado(): Promise<string> {
  const { verificarDestino } = await import("../drizzle.migrate.config.ts");
  const destino = verificarDestino();
  // Ciclo de la captura del seed: ni siquiera un ensayo toca la rama histórica.
  const congelada = congelacionDelDestino(
    destino.rama,
    new Date(),
    leerPresupuesto(process.env).diaDeCiclo,
  );
  if (congelada !== null) throw new Error(explicarCongelacion(destino.rama, congelada));
  if (typeof WebSocket === "undefined") {
    throw new Error("Este Node no expone WebSocket global y Neon lo necesita.");
  }
  neonConfig.webSocketConstructor = WebSocket;
  console.log(`  hostname          ${destino.hostname}`);
  console.log(`  MIGRATION_TARGET  ${destino.rama}`);
  return destino.url;
}

/**
 * El presupuesto con un tope **inyectado solo para este proceso**. Los topes
 * del repositorio siguen como están: ningún `pnpm job` ni workflow lo hereda.
 */
export function presupuestoInyectado(
  pipeline: NombreDePipeline,
  tope: number,
): Presupuesto {
  const presupuesto = leerPresupuesto({
    ...process.env,
    STREAMING_API_PER_RUN_CAPS: `${pipeline}=${String(tope)}`,
  });
  console.log(
    `  umbral global     ${String(presupuesto.umbralGlobal)} (libro interno)`,
  );
  console.log(
    `  techo mensual     ${String(presupuesto.techoMensualPorPipeline[pipeline])} (${pipeline}` +
      `${TOPE_POR_EJECUCION_POR_DEFECTO[pipeline] === 0 && pipeline in GUARDRAIL_DE_MEDICION_MANUAL ? " · guardrail de medición manual, NO presupuesto aprobado" : ""})`,
  );
  console.log(`  tope inyectado    ${String(presupuesto.topePorEjecucion[pipeline])}`);
  return presupuesto;
}

/**
 * **El tope de una medición real de un pipeline sin tope aprobado.**
 *
 * ⚖️ Medir el coste es previo a fijar un tope (`updated`, 2026-09-25), así
 * que el script no lleva ninguno: lo escribe quien la lanza, cada vez, con
 * `--tope <n>`. Nunca por encima del techo mensual del pipeline —para un
 * pipeline sin presupuesto aprobado, su guardrail de medición manual
 * (`GUARDRAIL_DE_MEDICION_MANUAL`)—, y si el
 * pipeline ya tiene tope oficial, nunca por encima de ese: una vez aprobado,
 * el script manual no es una puerta trasera para gastar más que `pnpm job`.
 *
 * Lanza **antes** de leer la credencial o abrir una conexión.
 */
export function exigirTopeDeMedicion(
  pipeline: NombreDePipeline,
  argumento: string | undefined,
): number {
  const oficial = TOPE_POR_EJECUCION_POR_DEFECTO[pipeline];
  const techo = TECHO_MENSUAL_POR_DEFECTO[pipeline];
  // Sin tope aprobado, solo se mide lo que tiene guardrail declarado: un techo
  // que sea otra cosa (la estrategia de `popularity`, por ejemplo) no lo es.
  const guardrail =
    (GUARDRAIL_DE_MEDICION_MANUAL as Partial<Record<NombreDePipeline, number>>)[
      pipeline
    ] ?? 0;
  const maximo = oficial > 0 ? Math.min(oficial, techo) : Math.min(guardrail, techo);
  if (maximo < 1) {
    throw new Error(
      `${pipeline} no tiene tope aprobado ni guardrail de medición manual: no se mide ` +
        "a mano. No se ha pedido nada.",
    );
  }
  if (argumento === undefined) {
    throw new Error(
      `${pipeline} no tiene tope aprobado: la ejecución real exige --tope <n>, ` +
        `un entero entre 1 y ${String(maximo)}. No se ha pedido nada.`,
    );
  }
  const tope = Number(argumento);
  if (!Number.isSafeInteger(tope) || tope < 1 || tope > maximo) {
    throw new Error(
      `El tope de la medición de ${pipeline} (${argumento}) tiene que ser un entero ` +
        `entre 1 y ${String(maximo)} (${oficial > 0 ? "su tope oficial" : "su guardrail de medición manual: no hay presupuesto aprobado"}, ` +
        "jobs/ops/presupuesto.ts). No se ha pedido nada.",
    );
  }
  return tope;
}

/**
 * **Qué mide una ejecución real de una ventana contigua**, en palabras que no
 * mientan.
 *
 * 📏 La fila 60 de `updated` reanudó la ventana de las filas 58 y 59 y
 * terminó con 3 requests; el texto anterior decía que «la ventana cabe en 3
 * requests», cuando la ventana entera necesitó 11. Una ejecución solo sabe lo
 * que gastó **ella**:
 *
 *   · nueva y completa — la ventana entera necesitó N requests;
 *   · reanudada y completa — el **tramo pendiente** se completó en N; las
 *     requests de las ejecuciones anteriores no se suman aquí, porque no hay
 *     una forma explícita y fiable de hacerlo;
 *   · sin agotar — N es un suelo, y la siguiente reanuda.
 */
export function describirMedicionDeVentana(entrada: {
  readonly desde: Date;
  readonly hasta: Date;
  /** La ejecución cuyo tramo pendiente retomó esta, o `null` si es nueva. */
  readonly reanudaDe: number | null;
  /** `succeeded` y sin nada pendiente. */
  readonly completa: boolean;
  /** Las requests de ESTA ejecución. */
  readonly requests: number;
}): readonly string[] {
  const ventana = `${entrada.desde.toISOString()} → ${entrada.hasta.toISOString()}`;
  const n = String(entrada.requests);
  if (entrada.reanudaDe === null) {
    return entrada.completa
      ? [`📏 La ventana completa ${ventana} necesitó ${n} requests.`]
      : [
          `⚠️  La lista no se agotó en ${n} requests: la cifra es un SUELO.`,
          "   La próxima --real reanuda desde ops_sync_runs.checkpoint (GASTA).",
        ];
  }
  const tramo = `el tramo pendiente de la ventana ${ventana} (reanudado de la ejecución ${String(entrada.reanudaDe)})`;
  return entrada.completa
    ? [
        `📏 Se completó ${tramo} en ${n} requests.`,
        "   La ventana entera necesitó además las requests de las ejecuciones anteriores,",
        "   que esta ejecución no suma: consúltalas en ops_sync_runs.",
      ]
    : [
        `⚠️  Tampoco se agotó ${tramo} en ${n} requests: la cifra es un SUELO.`,
        "   La próxima --real reanuda desde ops_sync_runs.checkpoint (GASTA).",
      ];
}

// ── Llamadas servidas desde disco (ensayo y reproducción) ───────────────────

export interface Grabada {
  readonly cuerpo: string;
  readonly cabeceras: Readonly<Record<string, string>>;
}

export function claveGrabada(tipo: string | null, cursor: string | null): string {
  return `${tipo ?? "?"}|${cursor ?? ""}`;
}

/**
 * Sirve respuestas grabadas **pasando por la fuente de cuota**, como el
 * transporte real: la reserva y la guardia externa se ejercitan igual.
 * `validarUrl` permite exigir que la query sea exactamente la medida.
 */
export function llamadaDesdeDisco(
  grabadas: ReadonlyMap<string, Grabada>,
  validarUrl?: (url: URL) => void,
): (fuente: FuenteDeCuota) => Transporte {
  return (fuente) => async (url) => {
    await fuente.pedirCuota();
    const u = new URL(url);
    validarUrl?.(u);
    const g = grabadas.get(
      claveGrabada(u.searchParams.get("change_type"), u.searchParams.get("cursor")),
    );
    if (g === undefined) {
      throw new Error(
        `Sin respuesta grabada para ${u.searchParams.get("change_type") ?? "?"} ` +
          `cursor=${u.searchParams.get("cursor") ?? "∅"}: se pidió algo que no se grabó.`,
      );
    }
    return new Response(g.cuerpo, {
      status: 200,
      headers: { "content-type": "application/json", ...g.cabeceras },
    });
  };
}

// ── Informe común de una ejecución ──────────────────────────────────────────

export function informarEjecucion(
  pipeline: NombreDePipeline,
  salida: ResultadoDelJobDeCambios<CheckpointDeCambios>,
): void {
  const { resultado, informe, contadores, reanudacion } = salida;
  if (!resultado.ejecutado) {
    console.log(`  Ya había una ejecución viva de ${pipeline}: no se ha pedido nada.`);
    return;
  }
  console.log(`  estado            ${resultado.estado}`);
  console.log(
    `  requests          reservadas ${String(contadores.reservasConcedidas)} · ` +
      `respuestas ${String(contadores.respuestas)} · ok ${String(contadores.respuestasOk)}`,
  );
  if (informe !== null) {
    console.log(
      `  páginas / avisos  ${String(informe.paginas)} / ${String(informe.avisos)} · ` +
        `títulos tocados ${String(informe.titulosTocados)}`,
    );
    console.log(
      `  eventos           ${JSON.stringify(informe.eventos)} · escritos ${String(informe.eventosEscritos)}`,
    );
    console.log(
      `  línea base        ${String(informe.ofertasDeLineaBase)} ofertas sin evento · ` +
        `${String(informe.retiradasSinEstadoPrevio)} retiradas sin estado previo`,
    );
  }
  for (const c of salida.cuotaDelProveedor) {
    console.log(
      `  x-quota           used ${String(c.usada)} / granted ${String(c.concedida)} · ` +
        `umbral ${String(c.umbral)} · reset ${c.reinicio}`,
    );
  }
  if (reanudacion !== null) {
    console.log(`  ⚠️  PENDIENTE      ${JSON.stringify(reanudacion)}`);
  }
  if (resultado.estado === "failed") {
    for (const linea of describirFallo({
      estado: resultado.estado,
      runId: resultado.runId,
      requestsReservadas: contadores.reservasConcedidas,
      metricas: resultado.metricas,
    })) {
      console.log(`  ${linea}`);
    }
  }
}
