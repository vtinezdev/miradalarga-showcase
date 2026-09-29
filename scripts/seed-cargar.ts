/**
 * `pnpm seed:cargar --ensayo | --real | --fallo-controlado <directorio del crudo>`
 * — la carga del seed contra **la rama del seed** (ADR 0009 §5, §9, §10).
 *
 * `pnpm production:cargar --ensayo | --real <directorio del crudo>` — **la misma
 * carga contra `production`** (ADR 0010): guardas de `destino-production.ts`,
 * crudo real con sus dos copias, **compuerta** (aceptación de la rama del seed
 * real + M4 recalculado: un crudo refutado no pasa) y la autorización en código
 * `cargar` atada a su huella. Todo antes de abrir un socket. `--ensayo` también
 * la exige: toma los locks y escribe dentro de un `ROLLBACK`.
 *
 * **0 requests.** Ni este script ni la carga importan el transporte, y la
 * credencial de la API se borra del proceso antes de nada (`seed-comun.ts`).
 *
 * Los tres modos verifican **antes de abrir un socket** el crudo
 * (`seed:verificar`: íntegro y cargable) y el destino (solo
 * la rama del seed de la lista cerrada, hostname exacto, conexión directa, régimen
 * estricto), y **antes de escribir nada** que la rama tenga exactamente las
 * migraciones `0000`–`0004`. El instante de la carga es el `now()` del
 * servidor: el mismo reloj que `finished_at` y que decide `S + 72 h`.
 *
 *   · `--ensayo` — con los locks A (pipeline) y C (catálogo) tomados, en una
 *     transacción que **siempre** acaba en `ROLLBACK`: decide la carga con las
 *     precondiciones de verdad, ejecuta el upsert real, calcula la huella
 *     canónica **desde la base** dentro de la transacción y la compara con la
 *     del crudo. Mide duración y tamaño. **Sin fila de `ops_sync_runs`** y con
 *     el destino idéntico después (recuentos e ids).
 *   · `--real` — `ejecutarCargaDelSeed` tal cual: una fila `seed`/`carga`, una
 *     transacción, el ancla como última sentencia. Después comprueba la fila
 *     (`succeeded`, `requests_made = 0`, `cargada`, `S`), la huella desde la
 *     base y, si era una reejecución, **0 inserciones e ids estables**.
 *   · `--fallo-controlado` — lo mismo que `--real`, pero la sentencia que
 *     escribe el ancla —la **última** de la transacción, con todo el catálogo
 *     ya escrito— lanza. Demuestra el rollback completo: fila `failed`, 0
 *     requests, catálogo, ids y ancla exactamente como estaban.
 *
 * Informe JSON en `.seed-cargas/` (sin secretos). Salida: `0` como se
 * esperaba · `1` fallo o precondición incumplida · `2` lock ocupado.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  soltarLockDeCatalogo,
  soltarLockDePipeline,
  tomarLockDeCatalogo,
  tomarLockDePipeline,
} from "../jobs/ops/bloqueo.ts";
import type { Conexion } from "../jobs/ops/conexion.ts";
import { conectar } from "../jobs/ops/conexion.ts";
import type { EjecutorSql } from "../jobs/ops/contratos.ts";
import { leerPresupuesto } from "../jobs/ops/presupuesto.ts";
import { anclaCaducada, leerAnclaDelSeed } from "../jobs/pipelines/seed/ancla.ts";
import { CAPACIDADES_MVP } from "../jobs/pipelines/seed/capacidades.ts";
import type { EstadoDelDestino } from "../jobs/pipelines/seed/carga.ts";
import {
  SQL_ESTADO_DEL_DESTINO,
  codigoDeSalidaDeLaCarga,
  decidirCarga,
  ejecutarCargaDelSeed,
  transaccionUnica,
} from "../jobs/pipelines/seed/carga.ts";
import { comprobarCopias } from "../jobs/pipelines/seed/crudo/copias.ts";
import type { CrudoVerificado } from "../jobs/pipelines/seed/crudo/verificar.ts";
import { esCrudoDeEnsayo } from "../jobs/pipelines/seed/ensayo.ts";
import { huellaCanonicaDelDestino } from "../jobs/pipelines/seed/huella-base.ts";
import { ejecutarSeed } from "../jobs/pipelines/seed/index.ts";
import { exigirAutorizacionDeProduction } from "../jobs/ops/autorizacion-de-production.ts";
import { exigirCompuerta, separarBandera } from "./production-comun.ts";
import type { DestinoDelSeed, InstanteDelServidor } from "./seed-comun.ts";
import {
  comprobarMigraciones,
  crudoCargable,
  destinoDelSeed,
  exigirCrudoParaRama,
  guardarInforme,
  huellaDeIds,
  instanteDelServidor,
  recuentoPorTabla,
} from "./seed-comun.ts";

type Modo = "ensayo" | "real" | "fallo-controlado";

const MODOS: Readonly<Record<string, Modo>> = {
  "--ensayo": "ensayo",
  "--real": "real",
  "--fallo-controlado": "fallo-controlado",
};

/** El texto de la sentencia que escribe el ancla (`jobs/ops/checkpoint.ts`). */
const SENTENCIA_DEL_ANCLA = "SET checkpoint = $2::jsonb";

interface Comprobacion {
  readonly descripcion: string;
  readonly ok: boolean;
  readonly detalle?: string;
}

const comprobaciones: Comprobacion[] = [];

function comprobar(descripcion: string, ok: boolean, detalle?: string): void {
  comprobaciones.push(
    detalle === undefined ? { descripcion, ok } : { descripcion, ok, detalle },
  );
  console.log(
    `  ${ok ? "✅" : "❌"} ${descripcion}${detalle === undefined ? "" : ` — ${detalle}`}`,
  );
}

const iguales = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

function commitActual(): string | null {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"]).toString("utf8").trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

function numero(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}

async function estadoDelDestino(ejecutor: EjecutorSql): Promise<EstadoDelDestino> {
  const [f] = await ejecutor.ejecutar<Record<string, unknown>>(SQL_ESTADO_DEL_DESTINO);
  return {
    titulos: numero(f?.titulos),
    ofertas: numero(f?.ofertas),
    eventos: numero(f?.eventos),
    anuncios: numero(f?.anuncios),
    escritores: numero(f?.escritores),
  };
}

interface FotoDelDestino {
  readonly recuento: Record<string, number>;
  readonly huellaDeIds: string;
  readonly huellaCanonica: string;
  readonly anclaRunId: number | null;
}

async function foto(ejecutor: EjecutorSql): Promise<FotoDelDestino> {
  const ancla = await leerAnclaDelSeed(ejecutor);
  return {
    recuento: await recuentoPorTabla(ejecutor),
    huellaDeIds: await huellaDeIds(ejecutor),
    huellaCanonica: (await huellaCanonicaDelDestino(ejecutor)).huella,
    anclaRunId: ancla?.runId ?? null,
  };
}

// ── --ensayo ─────────────────────────────────────────────────────────────────

async function ensayo(
  ops: EjecutorSql,
  datos: EjecutorSql,
  crudo: CrudoVerificado,
  reloj: InstanteDelServidor,
): Promise<{ codigo: 0 | 1 | 2; informe: Record<string, unknown> }> {
  if (!(await tomarLockDePipeline(ops, "seed"))) {
    console.log("  ⚠️  Otra ejecución del seed sostiene el lock A: no se ensaya nada.");
    return { codigo: 2, informe: { lock: "pipeline_ocupado" } };
  }
  try {
    if (!(await tomarLockDeCatalogo(ops))) {
      console.log(
        "  ⚠️  Otro escritor sostiene el lock de catálogo: no se ensaya nada.",
      );
      return { codigo: 2, informe: { lock: "catalogo_ocupado" } };
    }
    try {
      const caducada = anclaCaducada(crudo.ancla, reloj.ahora);
      comprobar(
        "el ancla sigue vigente (ahora < S + 72 h, reloj del servidor)",
        !caducada,
      );
      const antes = await foto(datos);

      let decision: ReturnType<typeof decidirCarga> | null = null;
      let huellaDentro: string | null = null;
      let filasDentro: Record<string, number> | null = null;
      let duracionMs: number | null = null;
      let bytesAntes = 0;
      let bytesDentro = 0;
      let tablas: unknown = null;
      await datos.ejecutar("BEGIN");
      try {
        const [tamano] = await datos.ejecutar<{ b: string }>(
          "SELECT pg_database_size(current_database())::text AS b",
        );
        bytesAntes = Number(tamano?.b);
        decision = decidirCarga(
          await estadoDelDestino(datos),
          await leerAnclaDelSeed(datos),
          crudo.huella,
        );
        comprobar(
          "precondiciones: destino virgen o reejecución del mismo crudo",
          decision.tipo !== "negada",
          decision.tipo === "negada"
            ? `${decision.motivo}: ${decision.detalle}`
            : decision.tipo,
        );
        if (decision.tipo !== "negada" && !caducada) {
          const t = performance.now();
          const escrito = await ejecutarSeed(datos, crudo.filas, {
            ahora: reloj.ahora,
            capacidades: CAPACIDADES_MVP,
          });
          duracionMs = Math.round(performance.now() - t);
          tablas = escrito.tablas;
          const dentro = await huellaCanonicaDelDestino(datos);
          huellaDentro = dentro.huella;
          filasDentro = dentro.filas;
          const [t2] = await datos.ejecutar<{ b: string }>(
            "SELECT pg_database_size(current_database())::text AS b",
          );
          bytesDentro = Number(t2?.b);
          comprobar(
            "huella canónica leída de la base, dentro de la transacción == la del crudo",
            huellaDentro === crudo.huellaCanonica,
            huellaDentro,
          );
        }
      } finally {
        // Siempre: el ensayo nunca confirma.
        await datos.ejecutar("ROLLBACK");
      }
      const despues = await foto(datos);
      comprobar(
        "tras el ROLLBACK, mismos recuentos por tabla",
        iguales(antes.recuento, despues.recuento),
      );
      comprobar(
        "tras el ROLLBACK, mismos ids",
        antes.huellaDeIds === despues.huellaDeIds,
      );
      comprobar(
        "tras el ROLLBACK, misma huella canónica del destino",
        antes.huellaCanonica === despues.huellaCanonica,
      );
      comprobar(
        "el ensayo no abre fila en ops_sync_runs",
        antes.recuento.ops_sync_runs === despues.recuento.ops_sync_runs,
      );
      if (duracionMs !== null) {
        console.log(`  ⏱  transacción de carga: ${String(duracionMs)} ms`);
        console.log(
          `  💾 tamaño de la base: ${String(bytesAntes)} → ${String(bytesDentro)} bytes (dentro)`,
        );
      }
      return {
        codigo: comprobaciones.every((c) => c.ok) ? 0 : 1,
        informe: {
          decision,
          huellaDentro,
          filasDentro,
          tablas,
          duracionMs,
          bytes: { antes: bytesAntes, dentro: bytesDentro },
          antes,
          despues,
        },
      };
    } finally {
      await soltarLockDeCatalogo(ops);
    }
  } finally {
    await soltarLockDePipeline(ops, "seed");
  }
}

// ── --real y --fallo-controlado ─────────────────────────────────────────────

/** El ejecutor de datos que lanza justo en la sentencia del ancla. */
function conFalloEnElAncla(datos: EjecutorSql): EjecutorSql {
  return {
    ejecutar(texto, valores) {
      if (texto.includes(SENTENCIA_DEL_ANCLA)) {
        return Promise.reject(
          new Error("fallo controlado: la sentencia del ancla no llega a ejecutarse"),
        );
      }
      return datos.ejecutar(texto, valores);
    },
  };
}

async function cargar(
  modo: "real" | "fallo-controlado",
  ops: EjecutorSql,
  datos: EjecutorSql,
  crudo: CrudoVerificado,
  reloj: InstanteDelServidor,
): Promise<{ codigo: 0 | 1 | 2; informe: Record<string, unknown> }> {
  const antes = await foto(datos);
  const t = performance.now();
  const { resultado, decision, informe } = await ejecutarCargaDelSeed({
    ejecutorOps: ops,
    ejecutorDatos: modo === "real" ? datos : conFalloEnElAncla(datos),
    transaccion: transaccionUnica(datos),
    // El del código, sin overrides: la carga no reserva nada.
    presupuesto: leerPresupuesto({}),
    ahora: reloj.ahora,
    crudo,
    commitSha: commitActual(),
  });
  const duracionMs = Math.round(performance.now() - t);
  if (!resultado.ejecutado) {
    console.log(`  ⚠️  No se ejecutó: ${resultado.motivo}.`);
    return { codigo: 2, informe: { resultado } };
  }

  const [fila] = await ops.ejecutar<Record<string, unknown>>(
    `SELECT id::text AS id, status::text AS status, requests_made, started_at, finished_at,
            rows_affected, error_samples, checkpoint
       FROM ops_sync_runs WHERE id = $1`,
    [resultado.runId],
  );
  const checkpoint = (fila?.checkpoint ?? {}) as Record<string, unknown>;
  const despues = await foto(datos);
  const insertadas = (informe?.tablas ?? []).reduce((s, x) => s + x.insertadas, 0);

  comprobar(
    "requests_made = 0 en la fila de la carga",
    numero(fila?.requests_made) === 0,
  );

  if (modo === "fallo-controlado") {
    comprobar("la fila cierra failed", fila?.status === "failed", String(fila?.status));
    comprobar(
      "el checkpoint se queda en pendiente: no hay ancla nueva",
      checkpoint.estado === "pendiente",
    );
    comprobar(
      "mismos recuentos por tabla (salvo la fila de ops)",
      iguales(
        { ...antes.recuento, ops_sync_runs: 0 },
        { ...despues.recuento, ops_sync_runs: 0 },
      ),
    );
    comprobar(
      "una sola fila nueva en ops_sync_runs",
      (despues.recuento.ops_sync_runs ?? 0) === (antes.recuento.ops_sync_runs ?? 0) + 1,
    );
    comprobar("mismos ids", antes.huellaDeIds === despues.huellaDeIds);
    comprobar(
      "misma huella canónica del destino",
      antes.huellaCanonica === despues.huellaCanonica,
    );
    comprobar(
      "el ancla vigente no cambia",
      antes.anclaRunId === despues.anclaRunId,
      String(despues.anclaRunId),
    );
  } else {
    comprobar(
      "la fila cierra succeeded",
      fila?.status === "succeeded",
      String(fila?.status),
    );
    comprobar("checkpoint de la carga en cargada", checkpoint.estado === "cargada");
    comprobar(
      "el ancla escrita es S del crudo",
      checkpoint.ancla === crudo.ancla.toISOString(),
      String(checkpoint.ancla),
    );
    comprobar(
      "el ancla vigente es la de esta fila",
      despues.anclaRunId === Number(resultado.runId),
    );
    comprobar(
      "huella canónica leída de la base == la del crudo",
      despues.huellaCanonica === crudo.huellaCanonica,
      despues.huellaCanonica,
    );
    if (decision?.tipo === "reejecucion") {
      comprobar("reejecución: 0 inserciones", insertadas === 0, String(insertadas));
      comprobar("reejecución: ids estables", antes.huellaDeIds === despues.huellaDeIds);
      comprobar(
        "reejecución: huella canónica sin cambios",
        antes.huellaCanonica === despues.huellaCanonica,
      );
    }
  }
  console.log(`  ⏱  carga completa (fila incluida): ${String(duracionMs)} ms`);
  console.log(
    `  fila ops_sync_runs ${String(fila?.id)} · decisión ${decision?.tipo ?? "—"}`,
  );
  return {
    codigo: comprobaciones.every((c) => c.ok)
      ? 0
      : modo === "real"
        ? codigoDeSalidaDeLaCarga(resultado) || 1
        : 1,
    informe: {
      decision,
      fila,
      tablas: informe?.tablas ?? null,
      insertadas,
      duracionMs,
      antes,
      despues,
    },
  };
}

// ── Principal ────────────────────────────────────────────────────────────────

async function principal(todos: readonly string[]): Promise<number> {
  const { production, resto: argumentos } = separarBandera(todos);
  const modo = MODOS[argumentos[0] ?? ""];
  const directorio = argumentos[1];
  if (modo === undefined || directorio === undefined || argumentos.length !== 2) {
    console.error(
      "Uso: pnpm seed:cargar --ensayo | --real | --fallo-controlado <directorio del crudo>\n" +
        "     pnpm production:cargar --ensayo | --real <directorio del crudo>",
    );
    return 1;
  }
  if (production && modo === "fallo-controlado") {
    console.error("--fallo-controlado nunca en production.");
    return 1;
  }

  console.log(
    `${production ? "PRODUCTION:CARGAR" : "SEED:CARGAR"} --${modo} — 0 API\n`,
  );
  let destino: DestinoDelSeed;
  try {
    destino = await destinoDelSeed(production);
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  console.log("");
  const crudo = crudoCargable(resolve(directorio));
  const ensayado = esCrudoDeEnsayo(crudo);
  console.log(`  crudo de ensayo   ${ensayado ? "sí" : "no"}`);
  exigirCrudoParaRama(ensayado, destino.rama);
  if (!ensayado && modo === "fallo-controlado") {
    throw new Error(
      "--fallo-controlado solo en la rama del ensayo: la real no se usa de banco de pruebas.",
    );
  }
  if (!ensayado && (modo === "real" || production)) {
    // ADR 0009 §4: dos copias verificadas por huella, una fuera del equipo, ANTES de cargar.
    const copias = comprobarCopias(resolve(directorio));
    console.log(
      `  copias            ${String(copias.copiasValidas)} verificadas · ${String(copias.fueraDelEquipo)} fuera del equipo`,
    );
    if (!copias.ok) {
      throw new Error(
        `El crudo real no tiene sus copias: ${copias.problemas.join("; ")}.`,
      );
    }
  }
  if (production) {
    // ADR 0010: aceptación en validación + M4 recalculado, y la autorización en
    // código atada a ESTA huella. Todo antes de abrir un socket.
    exigirCompuerta(resolve(directorio), crudo);
    exigirAutorizacionDeProduction({
      operacion: "cargar",
      huellaDelCrudo: crudo.huella,
    });
    console.log(`  autorización      cargar ${crudo.huella} ✅`);
  }
  console.log("");

  let ops: Conexion | null = null;
  let datos: Conexion | null = null;
  try {
    ops = await conectar(destino.url);
    datos = await conectar(destino.url);
    const reloj = await instanteDelServidor(ops.ejecutor);
    console.log(`  PostgreSQL        ${reloj.version}`);
    console.log(`  now() servidor    ${reloj.ahora.toISOString()}`);
    console.log(`  S (ancla)         ${crudo.ancla.toISOString()}\n`);

    const migraciones = await comprobarMigraciones(ops.ejecutor);
    comprobar(
      "migraciones exactamente 0000–0004, 0 pendientes",
      migraciones.exactas,
      migraciones.problemas.join("; ") || undefined,
    );
    if (!migraciones.exactas) return 1;

    const salida =
      modo === "ensayo"
        ? await ensayo(ops.ejecutor, datos.ejecutor, crudo, reloj)
        : await cargar(modo, ops.ejecutor, datos.ejecutor, crudo, reloj);

    const aprobadas = comprobaciones.filter((c) => c.ok).length;
    console.log(
      `\n  ${String(aprobadas)}/${String(comprobaciones.length)} comprobaciones`,
    );
    const ruta = guardarInforme(`carga-${modo}${production ? "-production" : ""}`, {
      modo,
      destino: destino.rama,
      postgres: reloj.version,
      ahoraDelServidor: reloj.ahora.toISOString(),
      crudo: {
        capturaId: crudo.plan.capturaId,
        ensayo: esCrudoDeEnsayo(crudo),
        huella: crudo.huella,
        huellaCanonica: crudo.huellaCanonica,
        ancla: crudo.ancla.toISOString(),
      },
      migraciones,
      comprobaciones,
      codigo: salida.codigo,
      ...salida.informe,
    });
    console.log(`  informe: ${ruta}`);
    return salida.codigo;
  } finally {
    await datos?.cerrar();
    await ops?.cerrar();
  }
}

principal(process.argv.slice(2)).then(
  (codigo) => {
    process.exitCode = codigo;
  },
  (error: unknown) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
