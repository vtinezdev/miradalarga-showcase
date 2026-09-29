/**
 * **El lock de escritor de catálogo, medido contra Neon con sesiones reales.**
 *
 *   pnpm db:validate:catalog-lock            todas las comprobaciones y limpieza
 *   pnpm db:validate:catalog-lock --limpiar  solo la limpieza, para recuperar un fallo
 *
 * Los tests offline (`tests/unit/ops-lock-catalogo.test.ts`) prueban QUIÉN
 * toma el lock y EN QUÉ ORDEN, con un registro de locks simulado. Lo que solo
 * puede probar el servidor:
 *
 *   · que `(NS_CATALOGO, 1)` excluye de verdad entre sesiones, y **al
 *     instante**: `pg_try_advisory_lock` no espera;
 *   · que no colisiona con los locks de pipeline ni de ciclo, aunque compartan
 *     el segundo entero (`PIPELINE_ID.seed` también es 1);
 *   · que `ejecutarJob` con el catálogo ocupado no deja fila, no cierra
 *     huérfanas y no reserva;
 *   · que el orden pipeline → catálogo → ciclo no interbloquea, y que la
 *     variante que espera SÍ lo haría (control negativo).
 *
 * ⚠️ **CERO llamadas a Streaming Availability.** Este script no importa
 * `transporte.ts` en tiempo de ejecución ni toca la red. Ningún cuerpo de job
 * pide cuota: **0 reservas**.
 *
 * ⚠️ **El lock de ciclo se prueba con una clave que no es de ningún ciclo
 * real** (`CICLO_DE_PRUEBA`, «enero de 1900»): sostenerlo no puede hacer
 * esperar a una reserva de verdad del cron de `deltas`.
 *
 * ⚠️ Escribe en `ops_sync_runs` y **confirma** —`ejecutarJob` abre y cierra
 * filas, y la huérfana de prueba tiene que ser visible para otra sesión—.
 * Todas llevan `commit_sha = MARCA`, y solo esas se borran. Si el proceso
 * muere a mitad quedan filas: el script lo dice y `--limpiar` las recupera.
 */
import type { EjecutorSql } from "../jobs/ops/contratos.ts";
import {
  CLAVE_CATALOGO,
  ESCRIBE_CATALOGO,
  NS_CATALOGO,
  NS_CICLO,
  NS_PIPELINE,
  PIPELINE_ID,
  bloquearCiclo,
  ejecutarJob,
  idDeEjecucion,
  leerPresupuesto,
  soltarLockDeCatalogo,
  soltarLockDePipeline,
  tomarLockDeCatalogo,
  tomarLockDePipeline,
} from "../jobs/ops/index.ts";
import { sanearTexto } from "../jobs/ops/diagnostico.ts";
import {
  cerrarComprobaciones,
  comprobar,
  conectar,
  destinoVerificado,
  fallar,
  seccion,
} from "./manual-comun.ts";
import type { Conexion } from "./manual-comun.ts";

/** Marca de las filas de este script. Nada fuera de ella se toca jamás. */
const MARCA = "validate-catalog-lock-v1";

/** Una clave de ciclo que no es de ningún ciclo real: `YYYYMM` de 1900-01. */
const CICLO_DE_PRUEBA = 190001;

/** Lo que tarda como mucho una respuesta que NO espera. Holgado a propósito. */
const SIN_ESPERA_MS = 1000;
/** Lo que se aguarda para afirmar que una sesión SÍ está esperando. */
const ESPERA_MS = 1500;

const PRESUPUESTO = leerPresupuesto({});

interface Sentencia {
  readonly texto: string;
  readonly valores: readonly unknown[];
}

/** Un ejecutor que apunta todo lo que manda al servidor, en orden. */
function grabando(base: EjecutorSql): { ejecutor: EjecutorSql; log: Sentencia[] } {
  const log: Sentencia[] = [];
  return {
    log,
    ejecutor: {
      ejecutar<T>(texto: string, valores: readonly unknown[] = []) {
        log.push({ texto: texto.trim(), valores });
        return base.ejecutar<T>(texto, valores);
      },
    },
  };
}

/** Resumen legible de un log: la primera línea de cada sentencia y sus claves. */
function describir(log: readonly Sentencia[]): string[] {
  return log.map((s) => {
    const linea = s.texto.split("\n")[0]?.trim() ?? "";
    const claves = s.texto.includes("advisory") ? ` (${s.valores.join(", ")})` : "";
    return `${linea}${claves}`;
  });
}

/** El resultado de una promesa, sin que un rechazo la convierta en excepción. */
type Asentada = { readonly ok: true } | { readonly ok: false; readonly error: unknown };
const asentar = (p: Promise<unknown>): Promise<Asentada> =>
  p.then(
    () => ({ ok: true }) as const,
    (error: unknown) => ({ ok: false, error }) as const,
  );

/** Espera a que una promesa gane o a que venza el plazo. Sin bucles de sondeo. */
async function conPlazo<T>(
  promesa: Promise<T>,
  ms: number,
): Promise<{ readonly vencio: true } | { readonly vencio: false; readonly valor: T }> {
  let temporizador: ReturnType<typeof setTimeout> | undefined;
  const plazo = new Promise<{ readonly vencio: true }>((resolver) => {
    temporizador = setTimeout(() => {
      resolver({ vencio: true });
    }, ms);
  });
  try {
    return await Promise.race([
      promesa.then((valor) => ({ vencio: false, valor }) as const),
      plazo,
    ]);
  } finally {
    if (temporizador !== undefined) clearTimeout(temporizador);
  }
}

async function cronometrar<T>(f: () => Promise<T>): Promise<{ valor: T; ms: number }> {
  const t0 = performance.now();
  const valor = await f();
  return { valor, ms: Math.round(performance.now() - t0) };
}

const codigoDe = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;

async function pidDe(e: EjecutorSql): Promise<number> {
  const r = await e.ejecutar<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return Number(r[0]?.pid);
}

interface LockVisto {
  readonly pid: number;
  readonly ns: number;
  readonly clave: number;
  readonly granted: boolean;
}

/** Los advisory locks de dos enteros (`objsubid = 2`) en nuestros espacios. */
async function locksEnNuestrosEspacios(observador: EjecutorSql): Promise<LockVisto[]> {
  const filas = await observador.ejecutar<{
    pid: number;
    ns: string;
    clave: string;
    granted: boolean;
  }>(
    `SELECT pid, classid::bigint AS ns, objid::bigint AS clave, granted
       FROM pg_locks
      WHERE locktype = 'advisory' AND objsubid = 2
        AND classid::bigint = ANY($1::bigint[])
      ORDER BY pid, classid, objid`,
    [[NS_PIPELINE, NS_CICLO, NS_CATALOGO]],
  );
  return filas.map((f) => ({
    pid: Number(f.pid),
    ns: Number(f.ns),
    clave: Number(f.clave),
    granted: f.granted,
  }));
}

const tiene = (locks: readonly LockVisto[], pid: number, ns: number, clave: number) =>
  locks.some((l) => l.pid === pid && l.ns === ns && l.clave === clave && l.granted);

async function principal(): Promise<void> {
  const soloLimpieza = process.argv.includes("--limpiar");

  console.log("VALIDACIÓN DEL LOCK DE ESCRITOR DE CATÁLOGO CONTRA NEON\n");
  const url = await destinoVerificado();
  console.log("  red externa       ninguna · cero requests a la API · 0 reservas");

  // Tres sesiones: A y B compiten; C observa (`pg_locks`, recuentos) sin
  // sostener nada, para que mirar no cambie lo que se mira.
  const sesiones: Conexion[] = [];
  for (let i = 0; i < 3; i++) sesiones.push(await conectar(url));
  const [sa, sb, sc] = sesiones as [Conexion, Conexion, Conexion];
  const a = sa.ejecutor;
  const b = sb.ejecutor;
  const c = sc.ejecutor;

  const limpiar = async (): Promise<number> =>
    (
      await c.ejecutar<{ id: unknown }>(
        "DELETE FROM ops_sync_runs WHERE commit_sha = $1 RETURNING id",
        [MARCA],
      )
    ).length;
  const contarMarcadas = async (): Promise<number> =>
    (
      await c.ejecutar<{ n: number }>(
        "SELECT count(*)::int AS n FROM ops_sync_runs WHERE commit_sha = $1",
        [MARCA],
      )
    )[0]?.n ?? -1;

  if (soloLimpieza) {
    seccion("Limpieza explícita");
    console.log(`  ${String(await limpiar())} filas borradas`);
    comprobar("no queda ninguna fila de este script", (await contarMarcadas()) === 0);
    for (const s of sesiones) await s.cliente.end();
    cerrarComprobaciones();
    return;
  }

  const pidA = await pidDe(a);
  const pidB = await pidDe(b);
  const soltarTodo = async (): Promise<void> => {
    for (const e of [a, b]) {
      await e.ejecutar("ROLLBACK").catch(() => undefined);
      await e.ejecutar("SELECT pg_advisory_unlock_all()");
    }
  };

  /** Lo que había antes, ajeno a este script: al final tiene que seguir igual. */
  const fotoAjena = async () =>
    c.ejecutar<{
      id: string;
      status: string;
      requests_made: number;
      fin: string | null;
    }>(
      `SELECT id::text AS id, status, requests_made, finished_at::text AS fin
         FROM ops_sync_runs WHERE commit_sha IS DISTINCT FROM $1 ORDER BY id`,
      [MARCA],
    );

  let hayEstadoConfirmado = false;
  let antes: Awaited<ReturnType<typeof fotoAjena>> = [];

  try {
    // ── 0 ─────────────────────────────────────────────────────────────────
    seccion("0 · Punto de partida");
    comprobar(
      "no hay filas de ejecuciones anteriores de este script",
      (await contarMarcadas()) === 0,
      "si no, lanza --limpiar",
    );
    const ajenos = (await locksEnNuestrosEspacios(c)).filter(
      (l) => l.pid !== pidA && l.pid !== pidB,
    );
    const usados = new Set([
      PIPELINE_ID.seed,
      PIPELINE_ID.deltas,
      PIPELINE_ID.expiring,
      PIPELINE_ID.popularity,
      PIPELINE_ID.scoring,
    ]);
    const estorban = ajenos.filter(
      (l) =>
        l.ns === NS_CATALOGO ||
        (l.ns === NS_PIPELINE && usados.has(l.clave)) ||
        (l.ns === NS_CICLO && l.clave === CICLO_DE_PRUEBA),
    );
    comprobar(
      "nadie más sostiene el catálogo ni los locks que usa este script",
      estorban.length === 0,
      estorban.length === 0
        ? `${String(ajenos.length)} locks ajenos en nuestros espacios, ninguno que estorbe`
        : `ocupados: ${JSON.stringify(estorban)} — ¿hay un job corriendo?`,
    );
    if (estorban.length > 0) {
      throw new Error("Hay un job vivo usando estos locks: no se valida encima de él.");
    }
    antes = await fotoAjena();
    const deadlockTimeout =
      (await c.ejecutar<{ deadlock_timeout: string }>("SHOW deadlock_timeout"))[0]
        ?.deadlock_timeout ?? "?";
    console.log(`  pids              A ${String(pidA)} · B ${String(pidB)}`);
    console.log(`  deadlock_timeout  ${deadlockTimeout}`);
    console.log(
      `  filas ajenas      ${String(antes.length)} (se comprueba que no cambian)`,
    );

    // ── 1 ─────────────────────────────────────────────────────────────────
    seccion("1 · La clave del catálogo no colisiona con pipeline ni ciclo");
    comprobar(
      "tres espacios de nombres distintos",
      new Set([NS_PIPELINE, NS_CICLO, NS_CATALOGO]).size === 3,
      `pipeline ${String(NS_PIPELINE)} · ciclo ${String(NS_CICLO)} · catálogo ${String(NS_CATALOGO)}`,
    );
    comprobar(
      "el segundo entero coincide con el de seed a propósito: solo el espacio los separa",
      CLAVE_CATALOGO === PIPELINE_ID.seed,
      `(${String(NS_CATALOGO)}, ${String(CLAVE_CATALOGO)}) frente a (${String(NS_PIPELINE)}, ${String(PIPELINE_ID.seed)})`,
    );

    await tomarLockDePipeline(a, "seed");
    const catalogoConSeed = await tomarLockDeCatalogo(b);
    comprobar("con (pipeline, 1) tomado por A, B toma (catálogo, 1)", catalogoConSeed);
    let vistos = await locksEnNuestrosEspacios(c);
    comprobar(
      "pg_locks los ve como dos locks distintos, uno por sesión",
      tiene(vistos, pidA, NS_PIPELINE, PIPELINE_ID.seed) &&
        tiene(vistos, pidB, NS_CATALOGO, CLAVE_CATALOGO),
      vistos
        .filter((l) => l.pid === pidA || l.pid === pidB)
        .map((l) => `${l.pid === pidA ? "A" : "B"}(${String(l.ns)},${String(l.clave)})`)
        .join(" "),
    );
    await soltarLockDeCatalogo(b);
    await soltarLockDePipeline(a, "seed");

    await a.ejecutar("BEGIN");
    await bloquearCiclo(a, CLAVE_CATALOGO); // (ciclo, 1): mismo segundo entero
    await bloquearCiclo(a, CICLO_DE_PRUEBA);
    const catalogoConCiclo = await cronometrar(() => tomarLockDeCatalogo(b));
    comprobar(
      "con (ciclo, 1) y un ciclo sostenidos por A, B toma el catálogo sin esperar",
      catalogoConCiclo.valor && catalogoConCiclo.ms < SIN_ESPERA_MS,
      `${String(catalogoConCiclo.ms)} ms`,
    );
    await a.ejecutar("ROLLBACK");
    await soltarLockDeCatalogo(b);

    // ── 2 ─────────────────────────────────────────────────────────────────
    seccion("2 · deltas lo toma; expiring es rechazado al instante; al soltar, entra");
    comprobar(
      "A toma el lock de pipeline de deltas",
      await tomarLockDePipeline(a, "deltas"),
    );
    comprobar("(1) deltas adquiere el lock de catálogo", await tomarLockDeCatalogo(a));
    vistos = await locksEnNuestrosEspacios(c);
    comprobar(
      "pg_locks: A sostiene (catálogo, 1) desde otra sesión observadora",
      tiene(vistos, pidA, NS_CATALOGO, CLAVE_CATALOGO),
    );

    comprobar(
      "B toma el lock de pipeline de expiring: es otro pipeline",
      await tomarLockDePipeline(b, "expiring"),
    );
    const idaYVuelta = await cronometrar(() => b.ejecutar("SELECT 1"));
    const rechazo = await cronometrar(() => tomarLockDeCatalogo(b));
    comprobar(
      "(2) mientras deltas lo sostiene, expiring NO lo adquiere",
      !rechazo.valor,
    );
    comprobar(
      "(3) y la negativa llega sin esperar",
      rechazo.ms < SIN_ESPERA_MS,
      `${String(rechazo.ms)} ms; un SELECT 1 en la misma sesión, ${String(idaYVuelta.ms)} ms`,
    );

    // Control: la variante que SÍ espera se queda esperando. Así el «no espera»
    // de arriba es una propiedad de `try`, no de un lock que estuviera libre.
    const espera = asentar(
      b.ejecutar("SELECT pg_advisory_lock($1, $2)", [NS_CATALOGO, CLAVE_CATALOGO]),
    );
    const bloqueada = await conPlazo(espera, ESPERA_MS);
    comprobar(
      "control: pg_advisory_lock (la que espera) sigue bloqueada",
      bloqueada.vencio,
      `más de ${String(ESPERA_MS)} ms`,
    );
    await soltarLockDeCatalogo(a);
    const desbloqueada = await conPlazo(espera, 5000);
    comprobar(
      "control: al soltarlo deltas, la espera termina",
      !desbloqueada.vencio && desbloqueada.valor.ok,
    );
    await soltarLockDeCatalogo(b); // el de la espera de control

    const entra = await tomarLockDeCatalogo(b);
    comprobar("(4) liberado por deltas, expiring lo adquiere", entra);
    vistos = await locksEnNuestrosEspacios(c);
    comprobar(
      "pg_locks: ahora lo sostiene B y no A",
      tiene(vistos, pidB, NS_CATALOGO, CLAVE_CATALOGO) &&
        !tiene(vistos, pidA, NS_CATALOGO, CLAVE_CATALOGO),
    );
    await soltarLockDeCatalogo(b);
    await soltarLockDePipeline(b, "expiring");
    await soltarLockDePipeline(a, "deltas");

    // ── 3 ─────────────────────────────────────────────────────────────────
    seccion("3 · Un pipeline que no escribe catálogo no queda bloqueado");
    await tomarLockDePipeline(a, "deltas");
    await tomarLockDeCatalogo(a);
    for (const pipeline of ["popularity", "scoring"] as const) {
      const g = grabando(b);
      const r = await ejecutarJob(
        g.ejecutor,
        { pipeline, presupuesto: PRESUPUESTO, commitSha: MARCA },
        () => {
          hayEstadoConfirmado = true;
          return Promise.resolve();
        },
      );
      hayEstadoConfirmado = true;
      const tocoCatalogo = g.log.some((s) => s.valores[0] === NS_CATALOGO);
      comprobar(
        `(5) ${pipeline} corre con el catálogo ocupado por deltas`,
        ESCRIBE_CATALOGO[pipeline] === false &&
          r.ejecutado &&
          r.estado === "succeeded" &&
          !tocoCatalogo,
        `ni siquiera pide (${String(NS_CATALOGO)}, ${String(CLAVE_CATALOGO)})`,
      );
    }

    // ── 4 ─────────────────────────────────────────────────────────────────
    seccion("4 · El lock de pipeline sigue funcionando además del de catálogo");
    comprobar(
      "(6) con deltas vivo, otra sesión no toma el lock de pipeline de deltas",
      !(await tomarLockDePipeline(b, "deltas")),
    );
    const maxAntes = await maxId(c);
    let g = grabando(b);
    let r = await ejecutarJob(
      g.ejecutor,
      { pipeline: "deltas", presupuesto: PRESUPUESTO, commitSha: MARCA },
      () => Promise.resolve(),
    );
    comprobar(
      "(6) ejecutarJob(deltas) se va con ya_hay_una_viva, antes de mirar el catálogo",
      !r.ejecutado &&
        r.motivo === "ya_hay_una_viva" &&
        g.log.length === 1 &&
        g.log[0]?.valores[0] === NS_PIPELINE,
      describir(g.log).join(" · "),
    );

    await soltarLockDeCatalogo(a); // deltas conserva SOLO su lock de pipeline
    g = grabando(b);
    r = await ejecutarJob(
      g.ejecutor,
      { pipeline: "deltas", presupuesto: PRESUPUESTO, commitSha: MARCA },
      () => Promise.resolve(),
    );
    comprobar(
      "(6) sin el catálogo, el lock de pipeline solo sigue excluyendo a deltas",
      !r.ejecutado && r.motivo === "ya_hay_una_viva",
    );
    comprobar(
      "(6) y no impide a otro escritor tomar el catálogo: son independientes",
      await tomarLockDeCatalogo(b),
    );
    await soltarLockDeCatalogo(b);
    comprobar("ninguna de esas negativas creó fila", (await maxId(c)) === maxAntes);
    await soltarLockDePipeline(a, "deltas");

    // ── 5 ─────────────────────────────────────────────────────────────────
    seccion("5 · Catálogo ocupado: sin fila, sin huérfanas, sin reservas");
    const alta = await c.ejecutar<{ id: unknown }>(
      `INSERT INTO ops_sync_runs
         (pipeline, status, started_at, requests_made, budget_limit, commit_sha)
       VALUES ('expiring', 'running', now(), 0, 900, $1) RETURNING id`,
      [MARCA],
    );
    hayEstadoConfirmado = true;
    const idHuerfana = idDeEjecucion(alta[0]?.id);
    console.log(`     huérfana de prueba de expiring: fila ${String(idHuerfana)}`);

    const maxPrevio = await maxId(c);
    const gastoPrevio = await gastoDeExpiring(c);

    await tomarLockDePipeline(a, "deltas");
    await tomarLockDeCatalogo(a);

    g = grabando(b);
    let corrioElCuerpo = false;
    r = await ejecutarJob(
      g.ejecutor,
      { pipeline: "expiring", presupuesto: PRESUPUESTO, commitSha: MARCA },
      () => {
        corrioElCuerpo = true;
        return Promise.resolve();
      },
    );
    comprobar(
      "expiring devuelve catalogo_ocupado y su cuerpo no corre",
      !r.ejecutado && r.motivo === "catalogo_ocupado" && !corrioElCuerpo,
    );
    const esperado = [
      `SELECT pg_try_advisory_lock($1, $2) AS tomado (${String(NS_PIPELINE)}, ${String(PIPELINE_ID.expiring)})`,
      `SELECT pg_try_advisory_lock($1, $2) AS tomado (${String(NS_CATALOGO)}, ${String(CLAVE_CATALOGO)})`,
      `SELECT pg_advisory_unlock($1, $2) (${String(NS_PIPELINE)}, ${String(PIPELINE_ID.expiring)})`,
    ];
    comprobar(
      "lo único que mandó al servidor: tomar pipeline, intentar catálogo, soltar pipeline",
      JSON.stringify(describir(g.log)) === JSON.stringify(esperado),
      describir(g.log).join(" · "),
    );
    comprobar(
      "(8) no se crea ninguna fila de ops_sync_runs",
      (await maxId(c)) === maxPrevio,
    );
    const huerfana = await filaDe(c, idHuerfana);
    comprobar(
      "(8) no se reconcilian huérfanas: la de prueba sigue en running",
      huerfana?.status === "running" &&
        huerfana.finished_at === null &&
        huerfana.error_count === 0,
      JSON.stringify(huerfana),
    );
    comprobar(
      "(8) no se reserva ninguna request: ni sentencia de reserva, ni lock de ciclo, ni gasto",
      !g.log.some(
        (s) => s.texto.includes("requests_made") || s.texto.includes("xact_lock"),
      ) && (await gastoDeExpiring(c)) === gastoPrevio,
      `gasto de expiring en el ciclo: ${String(gastoPrevio)} antes y después`,
    );
    vistos = await locksEnNuestrosEspacios(c);
    comprobar(
      "B no se queda con ningún lock tras irse",
      !vistos.some((l) => l.pid === pidB),
    );

    // Control positivo: con el catálogo libre, la MISMA llamada sí cierra la
    // huérfana. Lo de arriba lo impidió el lock, no la huérfana.
    await soltarLockDeCatalogo(a);
    await soltarLockDePipeline(a, "deltas");
    g = grabando(b);
    r = await ejecutarJob(
      g.ejecutor,
      { pipeline: "expiring", presupuesto: PRESUPUESTO, commitSha: MARCA },
      () => Promise.resolve(),
    );
    comprobar(
      "control: con el catálogo libre, expiring corre y cierra esa huérfana",
      r.ejecutado &&
        r.estado === "succeeded" &&
        r.huerfanasCerradas.some((h) => String(h.id) === String(idHuerfana)),
    );
    const orden = describir(g.log);
    const pos = (f: string) => orden.findIndex((s) => s.includes(f));
    const tomarA = pos(`AS tomado (${String(NS_PIPELINE)},`);
    const tomarC = pos(`AS tomado (${String(NS_CATALOGO)},`);
    const soltarC = pos(`unlock($1, $2) (${String(NS_CATALOGO)},`);
    const soltarA = pos(`unlock($1, $2) (${String(NS_PIPELINE)},`);
    comprobar(
      "(7) orden real en el servidor: pipeline → catálogo → huérfanas → alta → cierre → soltar catálogo → soltar pipeline",
      tomarA === 0 &&
        tomarC === 1 &&
        pos("UPDATE ops_sync_runs") > tomarC &&
        pos("INSERT INTO ops_sync_runs") > pos("UPDATE ops_sync_runs") &&
        soltarC > pos("INSERT INTO ops_sync_runs") &&
        soltarA === soltarC + 1 &&
        soltarA === orden.length - 1,
      orden.join(" · "),
    );

    // ── 6 ─────────────────────────────────────────────────────────────────
    seccion("6 · pipeline → catálogo → ciclo: sin interbloqueo");

    // 6a · Dos escritores en paralelo, varias rondas, con el orden real.
    let dentro = 0;
    let maximoDentro = 0;
    let ocupados = 0;
    const escritor = async (e: EjecutorSql, pipeline: "deltas" | "expiring") => {
      for (let ronda = 0; ronda < 5; ronda++) {
        if (!(await tomarLockDePipeline(e, pipeline)))
          throw new Error("pipeline ocupado");
        try {
          if (!(await tomarLockDeCatalogo(e))) {
            ocupados++;
            continue;
          }
          dentro++;
          maximoDentro = Math.max(maximoDentro, dentro);
          try {
            await e.ejecutar("BEGIN");
            await bloquearCiclo(e, CICLO_DE_PRUEBA);
            await e.ejecutar("SELECT pg_sleep(0.15)");
            await e.ejecutar("COMMIT");
          } finally {
            dentro--;
            await soltarLockDeCatalogo(e);
          }
        } finally {
          await soltarLockDePipeline(e, pipeline);
        }
      }
    };
    const paralelo = await conPlazo(
      Promise.all([asentar(escritor(a, "deltas")), asentar(escritor(b, "expiring"))]),
      30_000,
    );
    const errores = paralelo.vencio
      ? ["plazo vencido"]
      : paralelo.valor
          .filter((x): x is { ok: false; error: unknown } => !x.ok)
          .map((x) => codigoDe(x.error) ?? String(x.error));
    comprobar(
      "(7) 2 escritores × 5 rondas en paralelo terminan, sin error ni 40P01",
      !paralelo.vencio && errores.length === 0,
      errores.length === 0 ? "" : errores.join(", "),
    );
    comprobar(
      "y nunca hubo dos escritores dentro a la vez",
      maximoDentro === 1,
      `máximo simultáneo ${String(maximoDentro)} · ${String(ocupados)} intentos se fueron por catálogo ocupado`,
    );

    // 6b · Un no escritor espera por el ciclo mientras un escritor lo tiene:
    //      la espera termina con el COMMIT, nada más.
    await tomarLockDePipeline(a, "deltas");
    await tomarLockDeCatalogo(a);
    await a.ejecutar("BEGIN");
    await bloquearCiclo(a, CICLO_DE_PRUEBA);
    await tomarLockDePipeline(b, "popularity");
    await b.ejecutar("BEGIN");
    const cicloB = asentar(bloquearCiclo(b, CICLO_DE_PRUEBA));
    const bEspera = await conPlazo(cicloB, ESPERA_MS);
    await a.ejecutar("COMMIT");
    const bSigue = await conPlazo(cicloB, 5000);
    comprobar(
      "(7) quien espera por el ciclo (popularity) continúa en cuanto el escritor confirma",
      bEspera.vencio && !bSigue.vencio && bSigue.valor.ok,
    );
    await b.ejecutar("COMMIT");
    await soltarLockDePipeline(b, "popularity");
    await soltarLockDeCatalogo(a);
    await soltarLockDePipeline(a, "deltas");

    // 6c · La arista peligrosa: A tiene el ciclo y B el catálogo, y B espera
    //      por el ciclo. Con `try`, A no espera por el catálogo: no hay ciclo
    //      en el grafo de espera.
    await tomarLockDeCatalogo(b);
    await a.ejecutar("BEGIN");
    await bloquearCiclo(a, CICLO_DE_PRUEBA);
    await b.ejecutar("BEGIN");
    const cicloB2 = asentar(bloquearCiclo(b, CICLO_DE_PRUEBA));
    await conPlazo(cicloB2, 300); // B ya está esperando
    const tryA = await cronometrar(() => tomarLockDeCatalogo(a));
    comprobar(
      "(7) con el orden invertido a propósito, el try de A vuelve al instante con false",
      !tryA.valor && tryA.ms < SIN_ESPERA_MS,
      `${String(tryA.ms)} ms`,
    );
    await a.ejecutar("COMMIT");
    const b2 = await conPlazo(cicloB2, 5000);
    comprobar(
      "y B, que esperaba, continúa: sin interbloqueo",
      !b2.vencio && b2.valor.ok,
    );
    await b.ejecutar("COMMIT");
    await soltarLockDeCatalogo(b);

    // 6d · Control negativo: la MISMA situación con la variante que espera
    //      sí interbloquea. Es la razón de que A y C sean `try`.
    await tomarLockDeCatalogo(b);
    await a.ejecutar("BEGIN");
    await bloquearCiclo(a, CICLO_DE_PRUEBA);
    await b.ejecutar("BEGIN");
    const esperaB = asentar(bloquearCiclo(b, CICLO_DE_PRUEBA));
    await conPlazo(esperaB, 300);
    const esperaA = asentar(
      a.ejecutar("SELECT pg_advisory_lock($1, $2)", [NS_CATALOGO, CLAVE_CATALOGO]),
    );
    const primera = await conPlazo(
      Promise.race([
        esperaA.then((x) => ({ quien: "A" as const, x })),
        esperaB.then((x) => ({ quien: "B" as const, x })),
      ]),
      10_000,
    );
    const victima = primera.vencio ? null : primera.valor;
    comprobar(
      "control: con pg_advisory_lock (que espera) PostgreSQL detecta el interbloqueo (40P01)",
      victima !== null && !victima.x.ok && codigoDe(victima.x.error) === "40P01",
      victima === null
        ? "ninguna terminó en 10 s"
        : `víctima ${victima.quien}: ${victima.x.ok ? "sin error" : (codigoDe(victima.x.error) ?? "?")}`,
    );
    // Deshacer en el orden que libera a la otra: primero la víctima.
    if (victima === null) {
      // Nadie detectó nada: las dos siguen colgadas. Se cancelan desde fuera
      // para que la limpieza no espere para siempre.
      await c.ejecutar("SELECT pg_cancel_backend($1), pg_cancel_backend($2)", [
        pidA,
        pidB,
      ]);
      await Promise.all([esperaA, esperaB]);
      await a.ejecutar("ROLLBACK");
      await b.ejecutar("ROLLBACK");
    } else if (victima.quien === "B") {
      await b.ejecutar("ROLLBACK");
      await b.ejecutar("SELECT pg_advisory_unlock_all()");
      await conPlazo(esperaA, 5000);
      await a.ejecutar("ROLLBACK");
    } else {
      await a.ejecutar("ROLLBACK").catch(() => undefined);
      await conPlazo(esperaB, 5000);
      await b.ejecutar("ROLLBACK");
    }
    await soltarTodo();
  } finally {
    // ── 7 ─────────────────────────────────────────────────────────────────
    seccion("7 · Limpieza y rastro");
    try {
      await soltarTodo();
      const vistos = await locksEnNuestrosEspacios(c);
      comprobar(
        "A y B no sostienen ningún advisory lock de nuestros espacios",
        !vistos.some((l) => l.pid === pidA || l.pid === pidB),
      );
      console.log(`     ${String(await limpiar())} filas de este script borradas`);
      comprobar(
        "(9) rastro cero: no queda ninguna fila de este script",
        (await contarMarcadas()) === 0,
      );
      hayEstadoConfirmado = false;

      const despues = new Map((await fotoAjena()).map((f) => [f.id, f]));
      const cambiadas = antes.filter(
        (f) => JSON.stringify(despues.get(f.id)) !== JSON.stringify(f),
      );
      comprobar(
        "(9) ninguna fila ajena a este script ha cambiado",
        cambiadas.length === 0,
        cambiadas.length === 0
          ? `${String(antes.length)} filas intactas`
          : `cambiadas: ${cambiadas.map((f) => f.id).join(", ")}`,
      );
      const nuevas = [...despues.keys()].filter(
        (id) => !antes.some((f) => f.id === id),
      );
      if (nuevas.length > 0) {
        console.log(
          `     ℹ️  filas ajenas creadas mientras tanto (otro proceso, no este): ${nuevas.join(", ")}`,
        );
      }
    } catch (error) {
      comprobar(
        "limpieza",
        false,
        sanearTexto(error instanceof Error ? error.message : String(error)),
      );
    }
    if (hayEstadoConfirmado) {
      console.error(
        "\n⚠️  PUEDE HABER QUEDADO ESTADO DE PRUEBA en drizzle-schema-v1-test.\n" +
          "    Límpialo con:  pnpm db:validate:catalog-lock --limpiar\n",
      );
    }
    for (const s of sesiones) await s.cliente.end().catch(() => undefined);
  }

  cerrarComprobaciones();
}

async function maxId(e: EjecutorSql): Promise<string> {
  const r = await e.ejecutar<{ m: string | null }>(
    "SELECT max(id)::text AS m FROM ops_sync_runs",
  );
  return r[0]?.m ?? "0";
}

/** `requests_made` de expiring en todo el libro: si algo reservó, sube. */
async function gastoDeExpiring(e: EjecutorSql): Promise<number> {
  const r = await e.ejecutar<{ n: number }>(
    "SELECT coalesce(sum(requests_made), 0)::int AS n FROM ops_sync_runs WHERE pipeline = 'expiring'",
  );
  return r[0]?.n ?? -1;
}

async function filaDe(e: EjecutorSql, id: number) {
  const r = await e.ejecutar<{
    status: string;
    finished_at: Date | null;
    error_count: number;
  }>("SELECT status, finished_at, error_count FROM ops_sync_runs WHERE id = $1", [id]);
  return r[0];
}

principal().catch(fallar);
