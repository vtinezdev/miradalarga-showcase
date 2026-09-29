/**
 * `pnpm seed:validar <directorio del crudo>` y
 * `pnpm seed:validar:primer-deltas <directorio del crudo>` — validadores de
 * **solo lectura** de la rama del seed (ADR 0009 §7, §9).
 *
 * **Solo lectura por construcción:** todo corre dentro de una transacción
 * `REPEATABLE READ READ ONLY` que acaba en `ROLLBACK`. PostgreSQL rechaza
 * cualquier escritura, y todas las lecturas ven la misma instantánea.
 *
 * `seed:validar` comprueba, contra el crudo verificado:
 *
 *   · migraciones exactamente `0000`–`0004`, 0 pendientes;
 *   · **huella canónica leída de la base == la del crudo**, y recuentos por
 *     tabla == los del crudo; las tablas que el seed no escribe, vacías;
 *   · el **ancla**: existe, `S`, huella del crudo, huella canónica y
 *     `capturaId` correctos, en una fila `seed`/`carga` `succeeded`;
 *   · `ops_sync_runs` solo tiene filas `seed` y **`requests_made = 0` en
 *     todas**: ninguna fila falsa de `deltas` ni de ningún escritor;
 *   · el **bootstrap sigue incompleto**, `expiring`, `upcoming` y `updated` se
 *     niegan (`bootstrap_incompleto`) y `deltas` planificaría **`[S, ahora]`**.
 *
 * `seed:validar:primer-deltas` es la comprobación **posterior**, preparada
 * para cuando exista el primer `deltas` de la rama: su `ventana.from === S` y
 * cada ventana siguiente contigua (`continuidad.ts`). Hoy informa `sin_deltas`.
 *
 * Con el primer `deltas` ya ejecutado exige además el **bootstrap completo**
 * —un `deltas` `succeeded`, sin página pendiente y terminado antes de
 * `S + 72 h`— y que `expiring`, `upcoming` y `updated` **ya arranquen**.
 *
 * `pnpm production:validar [--primer-deltas] <crudo>` — lo mismo contra
 * `production` (ADR 0010), solo lectura: allí no hay filas de la captura (su
 * libro es el de la rama del seed real).
 *
 * **Recibo de aceptación** (`<capturaId>.aceptacion.json`): solo en la rama del
 * seed real y con un crudo real, `seed:validar` (exit 0) escribe la huella
 * canónica leída de PostgreSQL tras la carga, y `seed:validar:primer-deltas`
 * (exit 0) añade el primer `deltas` completo desde `S`, sin `added` sobre
 * ofertas del seed. La compuerta de `production` lo exige.
 *
 * Deja el resumen en `.seed-cargas/` (sin secretos ni hostname). Salida: `0`
 * todo cumple · `1` algo no · `3` (solo primer-deltas) todavía no hay `deltas`
 * · `4` (solo primer-deltas) continuidad correcta, bootstrap aún incompleto.
 */
import { resolve } from "node:path";

import type { Conexion } from "../jobs/ops/conexion.ts";
import { conectar } from "../jobs/ops/conexion.ts";
import type { EjecutorSql } from "../jobs/ops/contratos.ts";
import { ArranqueDenegado } from "../jobs/ops/contratos.ts";
import {
  exigirBootstrapCompleto,
  politicaDeDeltasSinCheckpoint,
  regimenDelDestino,
} from "../jobs/pipelines/arranque.ts";
import {
  evaluarBootstrap,
  leerCheckpoint,
  planificarDeltas,
} from "../jobs/pipelines/deltas/checkpoint.ts";
import {
  anclaCaducada,
  leerAnclaDelSeed,
  vencimientoDelAncla,
} from "../jobs/pipelines/seed/ancla.ts";
import { recuentosDeLaCarga } from "../jobs/pipelines/seed/carga.ts";
import type { EjecucionDeDeltas } from "../jobs/pipelines/seed/continuidad.ts";
import {
  anclaEnSegundos,
  comprobarContinuidad,
} from "../jobs/pipelines/seed/continuidad.ts";
import type { CrudoVerificado } from "../jobs/pipelines/seed/crudo/verificar.ts";
import { esCrudoDeEnsayo } from "../jobs/pipelines/seed/ensayo.ts";
import { huellaCanonicaDelDestino } from "../jobs/pipelines/seed/huella-base.ts";
import { DESTINO_PRODUCTION } from "../destino-production.ts";
import type { ReciboDeAceptacion } from "../jobs/pipelines/seed/compuerta-production.ts";
import {
  RAMA_DE_ACEPTACION,
  escribirReciboDeAceptacion,
  leerReciboDeAceptacion,
  separarBandera,
} from "./production-comun.ts";
import {
  TABLAS_AJENAS_AL_SEED,
  comprobarMigraciones,
  crudoCargable,
  destinoDelSeed,
  exigirCrudoParaRama,
  guardarInforme,
  instanteDelServidor,
  recuentoPorTabla,
} from "./seed-comun.ts";

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

async function motivoDeNegativa(trabajo: () => Promise<unknown>): Promise<string> {
  try {
    await trabajo();
    return "arranca";
  } catch (error) {
    return error instanceof ArranqueDenegado
      ? error.motivo
      : `excepcion: ${String(error)}`;
  }
}

/** Correspondencia entre recuentos del crudo y tablas de la base. */
const TABLA_DE_RECUENTO: Readonly<Record<string, string>> = {
  titulos: "external_titles",
  generos: "external_genres",
  titulos_generos: "external_title_genres",
  imagenes: "external_title_images",
  ofertas: "external_availability",
  opciones: "external_availability_options",
  capacidades: "external_platform_capabilities",
};

// ── seed:validar ─────────────────────────────────────────────────────────────

async function validarCarga(
  ejecutor: EjecutorSql,
  rama: string,
  crudo: CrudoVerificado,
): Promise<Record<string, unknown>> {
  const reloj = await instanteDelServidor(ejecutor);
  console.log(`  PostgreSQL        ${reloj.version}`);
  console.log(`  now() servidor    ${reloj.ahora.toISOString()}\n`);

  // Migraciones
  const migraciones = await comprobarMigraciones(ejecutor);
  comprobar(
    "migraciones exactamente 0000–0004, 0 pendientes",
    migraciones.exactas,
    migraciones.problemas.join("; ") || undefined,
  );

  // Huella y recuentos
  const recuento = await recuentoPorTabla(ejecutor);
  const huella = await huellaCanonicaDelDestino(ejecutor);
  comprobar(
    "huella canónica leída de PostgreSQL == huella canónica del crudo",
    huella.huella === crudo.huellaCanonica,
    `${huella.huella} vs ${crudo.huellaCanonica}`,
  );
  const esperados = recuentosDeLaCarga(crudo);
  for (const [clave, tabla] of Object.entries(TABLA_DE_RECUENTO)) {
    comprobar(
      `${tabla}: ${String(recuento[tabla])} filas == ${String(esperados[clave])} del crudo`,
      recuento[tabla] === esperados[clave],
    );
  }
  comprobar(
    "external_platforms: 6 plataformas curadas",
    recuento.external_platforms === 6,
  );
  const ajenas = TABLAS_AJENAS_AL_SEED.filter((t) => (recuento[t] ?? 0) !== 0);
  comprobar(
    "tablas que el seed no escribe (eventos, anuncios, capturas, rankings): vacías",
    ajenas.length === 0,
    ajenas.join(", ") || undefined,
  );

  // Ancla
  const ancla = await leerAnclaDelSeed(ejecutor);
  comprobar("existe el ancla (seed/carga en cargada)", ancla !== null);
  const cp = ancla?.checkpoint;
  comprobar(
    "S del ancla == S del crudo",
    ancla?.ancla.getTime() === crudo.ancla.getTime(),
    ancla?.ancla.toISOString(),
  );
  comprobar("huella del crudo en el ancla", cp?.huella === crudo.huella);
  comprobar("huella canónica en el ancla", cp?.huellaCanonica === crudo.huellaCanonica);
  comprobar("capturaId en el ancla", cp?.capturaId === crudo.plan.capturaId);
  comprobar(
    "la fila del ancla cerró succeeded",
    ancla?.status === "succeeded",
    ancla?.status,
  );
  const vigente = !anclaCaducada(crudo.ancla, reloj.ahora);
  console.log(
    `  ℹ️  el ancla vence el ${vencimientoDelAncla(crudo.ancla).toISOString()} ` +
      `(${vigente ? "vigente" : "CADUCADA"})`,
  );

  // ops_sync_runs
  const filas = await ejecutor.ejecutar<Record<string, unknown>>(`
    SELECT id::text AS id, pipeline, status::text AS status, requests_made,
           started_at, finished_at,
           extract(epoch FROM finished_at - started_at) * 1000 AS duracion_ms,
           rows_affected, checkpoint ->> 'fase' AS fase, checkpoint ->> 'estado' AS estado
      FROM ops_sync_runs ORDER BY id`);
  const noSeed = filas.filter((f) => f.pipeline !== "seed");
  comprobar(
    "ops_sync_runs solo tiene filas seed: ninguna fila falsa de deltas ni de otro escritor",
    noSeed.length === 0,
    noSeed.map((f) => `${String(f.id)}:${String(f.pipeline)}`).join(", ") || undefined,
  );
  // La carga nunca reserva. La captura real vive en esta misma rama (su libro),
  // así que sus filas sí gastaron: se cuentan aparte y se contrastan con el crudo.
  const cargas = filas.filter((f) => f.fase === "carga");
  const requests = cargas.reduce((s, f) => s + Number(f.requests_made), 0);
  comprobar(
    "requests_made = 0 en todas las filas de carga",
    requests === 0 && cargas.length > 0,
    String(requests),
  );
  const capturas = filas.filter((f) => f.fase === "captura");
  const deLaCaptura = capturas.reduce((s, f) => s + Number(f.requests_made), 0);
  if (rama === DESTINO_PRODUCTION) {
    // La captura vive en el libro de la rama del seed real, nunca aquí.
    comprobar(
      "production no tiene filas de la captura: su libro no ve las requests del crudo",
      capturas.length === 0,
      String(capturas.length),
    );
  } else if (!esCrudoDeEnsayo(crudo)) {
    comprobar(
      "las filas de la captura son las del cierre del crudo, con sus requests",
      JSON.stringify(capturas.map((f) => String(f.id))) ===
        JSON.stringify(crudo.cierre.filasDeOps) &&
        deLaCaptura === crudo.cierre.requestsReservadas,
      `${String(deLaCaptura)} requests en ${String(capturas.length)} filas`,
    );
  }
  const ajenasALaFase = filas.filter(
    (f) => f.fase !== "carga" && f.fase !== "captura" && f.fase !== "sonda",
  );
  comprobar(
    "ninguna fila seed sin fase conocida",
    ajenasALaFase.filter((f) => f.pipeline === "seed" && f.fase !== null).length === 0,
  );

  // Bootstrap
  const regimen = regimenDelDestino(rama);
  comprobar(
    "régimen del destino: bootstrap_del_seed",
    regimen === "bootstrap_del_seed",
  );
  const bootstrap = await evaluarBootstrap(ejecutor);
  comprobar(
    "bootstrap todavía incompleto (sin primer deltas completo)",
    !bootstrap.completo && bootstrap.causa === "sin_primer_deltas_completo",
    bootstrap.completo ? "completo" : bootstrap.causa,
  );
  const negativas: Record<string, string> = {};
  for (const p of ["expiring", "upcoming", "updated"] as const) {
    negativas[p] = await motivoDeNegativa(() => exigirBootstrapCompleto(ejecutor, p));
    comprobar(
      `${p} se niega a arrancar: bootstrap_incompleto`,
      negativas[p] === "bootstrap_incompleto",
      negativas[p],
    );
  }
  let plan: { from: number; to: number } | string;
  try {
    const cpDeltas = await planificarDeltas(ejecutor, {
      ahora: reloj.ahora,
      sinCheckpoint: politicaDeDeltasSinCheckpoint(regimen),
      tipos: ["removed", "new"],
    });
    plan = cpDeltas.ventana;
  } catch (error) {
    plan = error instanceof ArranqueDenegado ? error.motivo : String(error);
  }
  if (vigente) {
    comprobar(
      "deltas planificaría su primera ventana desde S: [S, ahora]",
      typeof plan === "object" && plan.from === anclaEnSegundos(crudo.ancla),
      typeof plan === "object"
        ? `[${new Date(plan.from * 1000).toISOString()}, ${new Date(plan.to * 1000).toISOString()}]`
        : plan,
    );
  } else {
    comprobar(
      "con el ancla caducada, deltas se niega: ancla_caducada",
      plan === "ancla_caducada",
      JSON.stringify(plan),
    );
  }

  return {
    destino: rama,
    postgres: reloj.version,
    ahoraDelServidor: reloj.ahora.toISOString(),
    migraciones,
    recuentoPorTabla: recuento,
    crudo: {
      capturaId: crudo.plan.capturaId,
      ensayo: esCrudoDeEnsayo(crudo),
      huella: crudo.huella,
      huellaCanonica: crudo.huellaCanonica,
      T0: crudo.T0.toISOString(),
      ancla: crudo.ancla.toISOString(),
      T1: crudo.T1.toISOString(),
      recuentos: esperados,
    },
    huellaCanonicaDelDestino: huella.huella,
    coinciden: huella.huella === crudo.huellaCanonica,
    ancla:
      ancla === null
        ? null
        : { runId: ancla.runId, status: ancla.status, S: ancla.ancla.toISOString() },
    anclaVence: vencimientoDelAncla(crudo.ancla).toISOString(),
    opsSyncRuns: filas,
    requestsDeLaCarga: requests,
    requestsDeLaCaptura: deLaCaptura,
    bootstrap: bootstrap.completo
      ? { completo: true }
      : { completo: false, causa: bootstrap.causa },
    negativas,
    planDeDeltas: plan,
  };
}

// ── seed:validar:primer-deltas ──────────────────────────────────────────────

async function validarPrimerDeltas(
  ejecutor: EjecutorSql,
  crudo: CrudoVerificado,
): Promise<{
  sinDeltas: boolean;
  bootstrapCompleto: boolean;
  aceptado: {
    bootstrapRunId: string;
    primerFrom: string;
    addedSobreOfertasDelSeed: number;
  } | null;
  informe: Record<string, unknown>;
}> {
  const ancla = await leerAnclaDelSeed(ejecutor);
  comprobar("existe el ancla", ancla !== null);
  comprobar(
    "S del ancla == S del crudo",
    ancla?.ancla.getTime() === crudo.ancla.getTime(),
  );

  const filas = await ejecutor.ejecutar<{
    id: string;
    status: string;
    checkpoint: unknown;
  }>(
    `SELECT id::text AS id, status::text AS status, checkpoint
       FROM ops_sync_runs
      WHERE pipeline = 'deltas' AND checkpoint IS NOT NULL
      ORDER BY id`,
  );
  const ejecuciones: EjecucionDeDeltas[] = filas.map((f) => {
    const runId = Number(f.id);
    const cp = leerCheckpoint(f.checkpoint, runId);
    return {
      runId,
      status: f.status,
      ventana: cp.ventana,
      pendiente: cp.pendiente !== null,
    };
  });
  const resultado = comprobarContinuidad(ancla?.ancla ?? null, ejecuciones);
  const bootstrap = await evaluarBootstrap(ejecutor);

  // ADR 0009 §9 C: el primer deltas no emite `added` sobre una oferta que ya
  // estaba en el seed —creada antes de que empezara el primer deltas posterior
  // al ancla, sin depender de que la fila de la carga cerrara—, salvo tras una baja.
  let addedSobreOfertasDelSeed = 0;
  if (ancla !== null && ejecuciones.length > 0) {
    const [f] = await ejecutor.ejecutar<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM external_availability_events e
         JOIN external_availability a ON a.id = e.availability_id
        WHERE e.event_type = 'added'
          AND a.created_at < (SELECT min(started_at) FROM ops_sync_runs
                               WHERE pipeline = 'deltas' AND id > $1)
          AND NOT EXISTS (
                SELECT 1 FROM external_availability_events r
                 WHERE r.availability_id = e.availability_id
                   AND r.event_type = 'removed' AND r.id < e.id)`,
      [ancla.runId],
    );
    addedSobreOfertasDelSeed = Number(f?.n ?? 0);
    comprobar(
      "ningún added sobre ofertas del seed (sin baja previa)",
      addedSobreOfertasDelSeed === 0,
      String(addedSobreOfertasDelSeed),
    );
  }

  if (resultado.estado === "sin_deltas") {
    console.log(
      "  ⏳ todavía no hay ningún deltas con checkpoint: comprobación preparada, no superada.",
    );
  } else if (resultado.estado !== "sin_ancla") {
    comprobar(
      "primer deltas: ventana.from === S",
      resultado.primerFrom === resultado.ancla,
      `fila ${String(resultado.primerRunId)}: ${new Date(resultado.primerFrom * 1000).toISOString()}`,
    );
    comprobar(
      "cada ventana siguiente contigua (o reanudación exacta)",
      resultado.estado === "continua",
      resultado.problemas.map((p) => `${p.tipo}@${String(p.runId)}`).join(", ") ||
        undefined,
    );
    if (bootstrap.completo) {
      comprobar(
        `bootstrap completado por el primer deltas completo (fila ${String(bootstrap.runId)}), antes de S + 72 h`,
        true,
      );
      // ADR 0009 §7: desde aquí, y solo desde aquí, pueden arrancar los demás escritores.
      for (const p of ["expiring", "upcoming", "updated"] as const) {
        const m = await motivoDeNegativa(() => exigirBootstrapCompleto(ejecutor, p));
        comprobar(
          `${p} ya puede arrancar (compuerta del bootstrap abierta)`,
          m === "arranca",
          m,
        );
      }
    } else {
      console.log(
        `  ⏳ bootstrap incompleto: ${bootstrap.causa}. Si el primer deltas cortó por tope, se reanuda ` +
          "con seed:primer-deltas --real dentro de S + 72 h.",
      );
    }
  }
  return {
    sinDeltas: resultado.estado === "sin_deltas",
    bootstrapCompleto: bootstrap.completo,
    aceptado:
      bootstrap.completo &&
      resultado.estado !== "sin_ancla" &&
      resultado.estado !== "sin_deltas"
        ? {
            bootstrapRunId: String(bootstrap.runId),
            primerFrom: new Date(resultado.primerFrom * 1000).toISOString(),
            addedSobreOfertasDelSeed,
          }
        : null,
    informe: {
      continuidad: resultado,
      bootstrap: bootstrap.completo
        ? { completo: true, runId: bootstrap.runId }
        : { completo: false, causa: bootstrap.causa },
    },
  };
}

// ── Principal ────────────────────────────────────────────────────────────────

/**
 * **El recibo de aceptación** (ADR 0010), solo en la rama del seed real y con
 * un crudo real: `seed:validar` escribe la etapa de la carga y
 * `seed:validar:primer-deltas` la del primer `deltas`. Es lo que la compuerta
 * de `production` exige. Devuelve `false` si la etapa 2 no encuentra la 1.
 */
function anotarAceptacion(
  directorio: string,
  crudo: CrudoVerificado,
  etapa:
    | {
        readonly tipo: "carga";
        readonly huellaLeida: string;
        readonly anclaRunId: string;
        readonly ahora: string;
      }
    | {
        readonly tipo: "primer_deltas";
        readonly ahora: string;
        readonly aceptado: Omit<
          NonNullable<ReciboDeAceptacion["primerDeltas"]>,
          "validadoEl"
        >;
      },
): boolean {
  if (etapa.tipo === "carga") {
    const ruta = escribirReciboDeAceptacion(directorio, {
      formato: "mirada-larga.seed.aceptacion",
      v: 1,
      capturaId: crudo.plan.capturaId,
      huella: crudo.huella,
      ancla: crudo.ancla.toISOString(),
      rama: RAMA_DE_ACEPTACION,
      carga: {
        huellaCanonicaLeida: etapa.huellaLeida,
        anclaRunId: etapa.anclaRunId,
        validadaEl: etapa.ahora,
      },
      primerDeltas: null,
    });
    console.log(`  recibo de aceptación (carga): ${ruta}`);
    return true;
  }
  const previo = leerReciboDeAceptacion(directorio);
  if (previo?.huella !== crudo.huella) {
    comprobar(
      "recibo de la carga validada presente (seed:validar tras la carga)",
      false,
      "sin él, production no aceptará este crudo",
    );
    return false;
  }
  const ruta = escribirReciboDeAceptacion(directorio, {
    ...previo,
    primerDeltas: { ...etapa.aceptado, validadoEl: etapa.ahora },
  });
  console.log(`  recibo de aceptación (primer deltas): ${ruta}`);
  return true;
}

async function principal(todos: readonly string[]): Promise<number> {
  const { production, resto: argumentos } = separarBandera(todos);
  const primerDeltas = argumentos[0] === "--primer-deltas";
  const directorio = primerDeltas ? argumentos[1] : argumentos[0];
  if (directorio === undefined || argumentos.length !== (primerDeltas ? 2 : 1)) {
    console.error(
      "Uso: pnpm seed:validar [--primer-deltas] <directorio del crudo>\n" +
        "     pnpm production:validar [--primer-deltas] <directorio del crudo>",
    );
    return 1;
  }
  const nombre = `${production ? "PRODUCTION" : "SEED"}:VALIDAR${primerDeltas ? ":PRIMER-DELTAS" : ""}`;
  console.log(`${nombre} — solo lectura, 0 API\n`);
  const destino = await destinoDelSeed(production);
  console.log("");
  const crudo = crudoCargable(resolve(directorio));
  exigirCrudoParaRama(esCrudoDeEnsayo(crudo), destino.rama);
  console.log("");
  // Solo la rama del seed real, con un crudo real, deja recibo de aceptación.
  const acepta = destino.rama === RAMA_DE_ACEPTACION && !esCrudoDeEnsayo(crudo);

  let conexion: Conexion | null = null;
  try {
    conexion = await conectar(destino.url);
    const ejecutor = conexion.ejecutor;
    await ejecutor.ejecutar(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    try {
      let codigo: number;
      let informe: Record<string, unknown>;
      if (primerDeltas) {
        const r = await validarPrimerDeltas(ejecutor, crudo);
        informe = r.informe;
        codigo = r.sinDeltas
          ? 3
          : !comprobaciones.every((c) => c.ok)
            ? 1
            : r.bootstrapCompleto
              ? 0
              : 4;
        if (codigo === 0 && acepta && r.aceptado !== null) {
          const { ahora } = await instanteDelServidor(ejecutor);
          if (
            !anotarAceptacion(resolve(directorio), crudo, {
              tipo: "primer_deltas",
              ahora: ahora.toISOString(),
              aceptado: r.aceptado,
            })
          ) {
            codigo = 1;
          }
        }
      } else {
        informe = await validarCarga(ejecutor, destino.rama, crudo);
        codigo = comprobaciones.every((c) => c.ok) ? 0 : 1;
        const ancla = informe.ancla as { runId: number } | null;
        if (codigo === 0 && acepta && ancla !== null) {
          anotarAceptacion(resolve(directorio), crudo, {
            tipo: "carga",
            huellaLeida: String(informe.huellaCanonicaDelDestino),
            anclaRunId: String(ancla.runId),
            ahora: String(informe.ahoraDelServidor),
          });
        }
      }
      const aprobadas = comprobaciones.filter((c) => c.ok).length;
      console.log(
        `\n  ${String(aprobadas)}/${String(comprobaciones.length)} comprobaciones`,
      );
      const ruta = guardarInforme(
        `${primerDeltas ? "validar-primer-deltas" : "validar"}${production ? "-production" : ""}`,
        { destino: destino.rama, ...informe, comprobaciones, codigo },
      );
      console.log(`  informe: ${ruta}`);
      return codigo;
    } finally {
      await ejecutor.ejecutar("ROLLBACK");
    }
  } finally {
    await conexion?.cerrar();
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
