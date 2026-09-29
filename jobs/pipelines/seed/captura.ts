/**
 * **El motor de la captura** (ADR 0009 §1, §4, §5, §10): API → crudo inmutable,
 * por rondas, con una fila `pipeline = 'seed'`, `fase = 'captura'` por
 * ejecución.
 *
 * ```
 * A pipeline `seed` (try) ──▶ por cada página: guardia externa ──▶ B ciclo
 *     (espera, en la reserva) ──▶ fuente ──▶ cuerpo en el crudo ──▶ entrada en
 *     el diario ──▶ checkpoint propio ──▶ cabeceras x-quota-* observadas
 * ```
 *
 *   · **La fuente se inyecta** y recibe la `FuenteDeCuota`: la real
 *     (`fuente-real.ts`) sale por `transporte.ts`, que reserva antes de llamar;
 *     la de los tests y del ensayo sirve fixtures. **Este módulo no importa el
 *     transporte** ni sabe construir una URL del proveedor. Tras cada página
 *     exige que se reservara **exactamente una vez**: una fuente que no reserva
 *     cierra `failed`, no gasta en silencio.
 *   · **Sin lock de catálogo** (`ESCRIBE_CATALOGO_POR_FASE_DEL_SEED.captura`):
 *     sus únicas escrituras en la base son su fila y su checkpoint, por la
 *     conexión de ops. Ni una fila de catálogo.
 *   · **`T0`** se toma de `relojDeT0` —en la captura real, el reloj del
 *     servidor PostgreSQL, el dominio de `finished_at` (§7)— inmediatamente
 *     antes de la primera reserva, y con él **`S`**. La captura no arranca si la
 *     M1 del plan no es del ciclo inmediatamente anterior (`m1_caducada`).
 *   · **Crudo antes que nada:** `plan.json` antes de la primera request; cada
 *     cuerpo, exacto, en cuanto llega; su entrada en el diario después; el
 *     checkpoint al final. Manifiesto y `SHA256SUMS` al cerrar.
 *   · **Parada:** al cerrar cada ronda (`objetivo_alcanzado`,
 *     `catalogo_agotado`); reserva denegada → `budget_stopped`, sin página a
 *     medias; respuesta inválida o cursor sin progreso → `failed`, con la
 *     página que lo delató guardada.
 *
 * ── Reanudar (`reanudar: true`) ─────────────────────────────────────────────
 *
 * Solo una captura `failed` o `budget_stopped` —o huérfana— del **mismo plan**,
 * dentro de `S + 72 h`. Hereda `T0` y `S`: **el ancla no se mueve**. Antes de
 * pedir nada reconstruye el recorrido desde el diario y lo contrasta con el
 * checkpoint persistido; si no cuadran, `crudo_incoherente` y 0 requests.
 * Después:
 *
 *   · aparta al diario el cierre anterior (manifiesto y sumas);
 *   · **adopta** la página escrita cuyo checkpoint no llegó a avanzar si su
 *     hash verifica (0 requests), o la **aparta** y la vuelve a pedir (+1: el
 *     error de siempre, sobrecontar, nunca perder);
 *   · aparta una página inválida —se vuelve a pedir su cursor— y todo cuerpo sin
 *     entrada.
 *
 * Un `cursor_sin_progreso` **no se reanuda** (`reanudacion_no_admitida`): pedir
 * el mismo cursor otra vez sería repetirse.
 */
import { escribirCheckpoint, leerUltimoCheckpoint } from "../../ops/checkpoint.ts";
import type { EjecutorSql, Presupuesto } from "../../ops/contratos.ts";
import {
  ArranqueDenegado,
  FalloOperativo,
  idDeEjecucion,
} from "../../ops/contratos.ts";
import type { ResultadoDeJob } from "../../ops/ejecucion.ts";
import { ejecutarJob } from "../../ops/ejecucion.ts";
import { calcularCiclo } from "../../ops/presupuesto.ts";
import type { FuenteDeCuota } from "../../ops/transporte.ts";
import { anclaCaducada } from "./ancla.ts";
import type { AlmacenDeCaptura } from "./crudo/almacen.ts";
import type {
  CierreDeCaptura,
  EntradaDePagina,
  EstratoDelPlan,
  ManifiestoDelSeed,
  PlanDelSeed,
} from "./crudo/formato.ts";
import {
  DIRECTORIO_DE_PAGINAS,
  FICHERO_DE_SUMAS,
  FICHERO_DEL_MANIFIESTO,
  FICHERO_DEL_PLAN,
  FORMATO_DEL_MANIFIESTO,
  VERSION_DEL_CRUDO,
  anclaDesdeT0,
  cicloSiguiente,
  entradaDePaginaV1,
  ficheroDePagina,
  idDeOpsComoTexto,
  queryDePagina,
} from "./crudo/formato.ts";
import { construirSumas, jsonDeFichero, sha256 } from "./crudo/huella.ts";
import { prepararCuota } from "./cuota.ts";
import type { CheckpointDeCaptura } from "./fases.ts";
import {
  VERSION_DEL_CHECKPOINT_DEL_SEED,
  checkpointDeCapturaV1,
  leerCheckpointDelSeed,
} from "./fases.ts";
import { leerPagina } from "./pagina.ts";
import type { EstadoDeRondas } from "./rondas.ts";
import {
  cerrarRonda,
  enFronteraDeRonda,
  iniciarRondas,
  rondasCompletas,
  registrarPagina,
  siguientePeticion,
} from "./rondas.ts";
import { crearAcumulador } from "./seleccion.ts";

export interface PeticionDePagina {
  readonly estrato: EstratoDelPlan;
  readonly ronda: number;
  readonly cursorDeEntrada: string | null;
  /** La query exacta, sin credencial. */
  readonly query: Readonly<Record<string, string>>;
}

export interface RespuestaDePagina {
  readonly status: number;
  /** El cuerpo exacto, byte a byte. Se guarda **antes** de interpretarlo. */
  readonly cuerpo: Uint8Array;
  readonly cabeceras: Readonly<Record<string, string>>;
}

/**
 * De dónde salen las páginas. **Tiene que llamar a `cuota.pedirCuota()` antes
 * de pedir la página**, una vez: el motor lo comprueba. Nunca `fetch` aquí.
 */
export type FuenteDePaginas = (
  peticion: PeticionDePagina,
  cuota: FuenteDeCuota,
) => Promise<RespuestaDePagina>;

export interface OpcionesDeCaptura {
  readonly ejecutorOps: EjecutorSql;
  readonly presupuesto: Presupuesto;
  readonly plan: PlanDelSeed;
  readonly fuente: FuenteDePaginas;
  readonly almacen: AlmacenDeCaptura;
  /** Reloj de reservas y respuestas, y del `started_at` de la fila. */
  readonly reloj: () => Date;
  /**
   * El reloj de `T0` y del plazo del ancla al reanudar. En la captura real, un
   * `clock_timestamp()` del servidor (ADR 0009 §7). Por defecto, `reloj`.
   */
  readonly relojDeT0?: () => Promise<Date>;
  /** La base donde vive la fila de la captura. Va al cierre del manifiesto. */
  readonly destino: string;
  readonly commitSha?: string | null;
  /** Reanudar la captura cortada de este mismo plan. */
  readonly reanudar?: boolean;
  /**
   * Guardia externa `x-quota-*`. **Obligatoria contra el proveedor**; `false`
   * solo para reenviar cuerpos ya pagados, que no traen cabeceras.
   */
  readonly comprobarCuotaDelProveedor: boolean;
}

export interface ResultadoDeCaptura {
  readonly resultado: ResultadoDeJob;
  /** `null` si la captura no llegó a empezar: sin crudo que verificar. */
  readonly manifiesto: ManifiestoDelSeed | null;
  readonly checkpoint: CheckpointDeCaptura | null;
  /** Lo que hizo la reanudación antes de pedir nada. `null` si no reanudó. */
  readonly reanudacion: InformeDeReanudacion | null;
}

export interface InformeDeReanudacion {
  readonly reanudaDe: number;
  readonly paginasConfirmadas: number;
  readonly adoptada: number | null;
  readonly apartadas: readonly { readonly ruta: string; readonly motivo: string }[];
  readonly cierreApartado: boolean;
}

const codificador = new TextEncoder();
const decodificador = new TextDecoder("utf-8", { fatal: true });

const RUTA_DE_ENTRADA = (n: number): string =>
  `entradas/${String(n).padStart(4, "0")}.json`;
const RUTA_DE_ADOPCION = (n: number): string =>
  `adopciones/${String(n).padStart(4, "0")}.json`;

function cuotaDe(
  cabeceras: Readonly<Record<string, string>>,
): EntradaDePagina["cuota"] {
  const usada = Number(cabeceras["x-quota-used"]);
  const concedida = Number(cabeceras["x-quota-granted"]);
  const reinicio = cabeceras["x-quota-reset"];
  if (
    !Number.isInteger(usada) ||
    !Number.isInteger(concedida) ||
    reinicio === undefined
  ) {
    return null;
  }
  return { usada, concedida, reinicio };
}

function checkpointDeRondas(
  base: Omit<
    CheckpointDeCaptura,
    "ronda" | "estratos" | "paginasConfirmadas" | "unicos"
  >,
  rondas: EstadoDeRondas,
  paginasConfirmadas: number,
  unicos: number,
): CheckpointDeCaptura {
  return checkpointDeCapturaV1.parse({
    ...base,
    ronda: rondas.ronda,
    estratos: rondas.estratos.map((e) => ({
      estrato: e.estrato,
      cursorDeEntrada: e.cursorDeEntrada,
      agotado: e.agotado,
      paginas: e.paginas,
    })),
    paginasConfirmadas,
    unicos,
  });
}

/** Las filas de esta captura ya abiertas, en la base de la captura. */
export const SQL_FILAS_DE_LA_CAPTURA = `
  SELECT id, requests_made
    FROM ops_sync_runs
   WHERE pipeline = 'seed'
     AND checkpoint ->> 'fase' = 'captura'
     AND checkpoint ->> 'capturaId' = $1
   ORDER BY id`;

interface FilaDeCaptura {
  readonly id: number;
  readonly requestsMade: number;
}

async function filasDeLaCaptura(
  ejecutorOps: EjecutorSql,
  capturaId: string,
): Promise<readonly FilaDeCaptura[]> {
  const filas = await ejecutorOps.ejecutar<{ id: unknown; requests_made: unknown }>(
    SQL_FILAS_DE_LA_CAPTURA,
    [capturaId],
  );
  return filas.map((f) => ({
    id: idDeEjecucion(f.id),
    requestsMade: Number(f.requests_made),
  }));
}

/**
 * Las entradas del diario, en orden: las activas (`entradas/`) o las apartadas
 * (`retiradas/<runId>/entradas/`). Una entrada ilegible es incoherencia.
 */
function leerEntradas(almacen: AlmacenDeCaptura, apartadas = false): EntradaDePagina[] {
  const rutas = apartadas
    ? almacen
        .listarDiario("retiradas/")
        .filter((r) => /^retiradas\/[^/]+\/entradas\//.test(r))
    : almacen.listarDiario("entradas/");
  return rutas.map((ruta) => {
    const bytes = almacen.leerDiario(ruta);
    const r =
      bytes === null
        ? null
        : entradaDePaginaV1.safeParse(JSON.parse(decodificador.decode(bytes)));
    if (r?.success !== true) {
      throw new ArranqueDenegado(
        "crudo_incoherente",
        `entrada ilegible en el diario: ${ruta}`,
        {
          ruta,
        },
      );
    }
    return r.data;
  });
}

/** Lo que la reanudación decidió en `checkpointInicial` y ejecuta el cuerpo. */
interface PlanDeReanudacion {
  readonly previa: number;
  readonly checkpoint: CheckpointDeCaptura;
  readonly rondas: EstadoDeRondas;
  readonly acumulador: ReturnType<typeof crearAcumulador>;
  readonly confirmadas: readonly EntradaDePagina[];
  /** La página escrita cuyo checkpoint no avanzó: se adopta. */
  readonly adoptar: EntradaDePagina | null;
  /** Rutas del crudo que se apartan, con su motivo. */
  readonly apartar: readonly {
    readonly ruta: string;
    readonly motivo: string;
    readonly n: number | null;
  }[];
}

function incoherente(
  detalle: string,
  contexto: Record<string, unknown> = {},
): ArranqueDenegado {
  return new ArranqueDenegado("crudo_incoherente", detalle, contexto);
}

/**
 * Reconstruye el recorrido desde el diario y lo contrasta con el checkpoint.
 * **No escribe nada**: solo decide. Cualquier discrepancia lanza, con 0
 * requests.
 */
async function planificarReanudacion(
  ejecutorOps: EjecutorSql,
  opciones: OpcionesDeCaptura,
  bytesDelPlan: Uint8Array,
  huellaDelPlan: string,
  ahora: Date,
): Promise<PlanDeReanudacion> {
  const { plan, almacen } = opciones;
  const planEnDisco = almacen.leer(FICHERO_DEL_PLAN);
  if (planEnDisco === null) {
    throw new ArranqueDenegado(
      "crudo_ausente",
      "no hay plan.json en el directorio del crudo.",
    );
  }
  if (
    sha256(planEnDisco) !== huellaDelPlan ||
    planEnDisco.length !== bytesDelPlan.length
  ) {
    throw new ArranqueDenegado(
      "plan_distinto",
      "el plan.json del crudo no es el de esta reanudación.",
    );
  }
  const ultimo = await leerUltimoCheckpoint(ejecutorOps, "seed");
  if (ultimo === null) {
    throw new ArranqueDenegado(
      "sin_captura_que_reanudar",
      "la base no tiene ninguna fila del seed.",
    );
  }
  const previo = leerCheckpointDelSeed(ultimo.checkpoint, ultimo.runId);
  if (previo.fase !== "captura" || previo.capturaId !== plan.capturaId) {
    throw new ArranqueDenegado(
      "sin_captura_que_reanudar",
      `la última fila del seed (${String(ultimo.runId)}) no es una captura de ${plan.capturaId}.`,
      { run_id: ultimo.runId },
    );
  }
  if (previo.huellaDelPlan !== huellaDelPlan) {
    throw new ArranqueDenegado("plan_distinto", "el checkpoint es de otro plan.", {
      run_id: ultimo.runId,
    });
  }
  if (ultimo.status === "succeeded") {
    throw new ArranqueDenegado(
      "captura_ya_cerrada",
      "la captura ya terminó succeeded.",
      {
        run_id: ultimo.runId,
      },
    );
  }
  if (anclaCaducada(new Date(previo.ancla), ahora)) {
    throw new ArranqueDenegado(
      "ancla_caducada",
      `S + 72 h ya pasó (S = ${previo.ancla}): una captura nueva, no una reanudación.`,
      { ancla: previo.ancla, ahora: ahora.toISOString() },
    );
  }

  const entradas = leerEntradas(almacen);
  entradas.forEach((e, i) => {
    if (e.n !== i + 1)
      throw incoherente(
        `el diario salta de la página ${String(i)} a la ${String(e.n)}.`,
      );
  });
  const P = previo.paginasConfirmadas;
  if (entradas.length !== P && entradas.length !== P + 1) {
    throw incoherente(
      `el diario tiene ${String(entradas.length)} páginas y el checkpoint confirma ${String(P)}.`,
      { entradas: entradas.length, confirmadas: P },
    );
  }

  const estratoPorNombre = new Map(plan.estratos.map((e) => [e.estrato, e]));
  let rondas = iniciarRondas(plan.estratos.map((e) => e.estrato));
  const acumulador = crearAcumulador();
  /** Lo que tocaba pedir, cerrando la ronda si estaba completa. */
  const tocaAhora = (n: number) => {
    if (siguientePeticion(rondas) === null) {
      const d = cerrarRonda(rondas, acumulador.unicosElegibles(), plan.objetivoUnicos);
      if (d.tipo === "parar") {
        throw incoherente(
          `la ronda ${String(d.ronda)} ya cumplía ${d.motivo} antes de la página ${String(n)}.`,
        );
      }
      rondas = d.estado;
    }
    const t = siguientePeticion(rondas);
    if (t === null) throw new Error("Una ronda nueva nace con estratos pendientes.");
    return t;
  };
  const coincide = (
    e: EntradaDePagina,
    t: { estrato: string; ronda: number; cursorDeEntrada: string | null },
  ) =>
    e.estrato === t.estrato &&
    e.ronda === t.ronda &&
    e.cursorDeEntrada === t.cursorDeEntrada &&
    e.fichero === ficheroDePagina(e.n, e.estrato, e.ronda);

  const confirmadas = entradas.slice(0, P);
  for (const e of confirmadas) {
    const t = tocaAhora(e.n);
    if (e.estado !== "confirmada" && e.estado !== "adoptada") {
      throw incoherente(
        `la página ${String(e.n)} está confirmada en el checkpoint y es ${e.estado}.`,
      );
    }
    if (!coincide(e, t))
      throw incoherente(`la página ${String(e.n)} no es la que tocaba.`);
    const cuerpo = almacen.leer(e.fichero);
    if (cuerpo === null || sha256(cuerpo) !== e.sha256) {
      throw incoherente(
        `la página ${String(e.n)} falta o no verifica su sha256: el crudo está dañado.`,
        {
          fichero: e.fichero,
        },
      );
    }
    const leida = leerPagina(e.http, cuerpo);
    if (!leida.valida)
      throw incoherente(`la página ${String(e.n)} confirmada no es válida.`);
    const estrato = estratoPorNombre.get(e.estrato);
    if (estrato === undefined)
      throw incoherente(`estrato fuera del plan: ${e.estrato}`);
    acumulador.anadir({
      n: e.n,
      estrato: e.estrato,
      respondidaEn: new Date(e.respondidaEn),
      shows: leida.pagina.shows,
    });
    const r = registrarPagina(rondas, {
      estrato: e.estrato,
      hasMore: leida.pagina.hasMore,
      nextCursor: leida.pagina.nextCursor,
    });
    rondas = r.estado;
    if (r.tipo === "cursor_sin_progreso") {
      if (e.n !== P)
        throw incoherente(`cursor sin progreso en la página ${String(e.n)}, y siguió.`);
      throw new ArranqueDenegado(
        "reanudacion_no_admitida",
        `la captura se detuvo por cursor_sin_progreso en ${e.estrato}: pedir el mismo cursor sería repetirse.`,
        { pagina: e.n, estrato: e.estrato },
      );
    }
  }

  // El recorrido reconstruido tiene que ser el que dice el checkpoint.
  const reconstruido = checkpointDeRondas(
    previo,
    rondas,
    P,
    acumulador.unicosElegibles(),
  );
  const mismo =
    reconstruido.ronda === previo.ronda &&
    reconstruido.unicos === previo.unicos &&
    JSON.stringify(reconstruido.estratos) === JSON.stringify(previo.estratos);
  if (!mismo) {
    throw incoherente(
      "el recorrido reconstruido desde el diario no es el del checkpoint.",
      {
        checkpoint: { ronda: previo.ronda, unicos: previo.unicos },
        diario: { ronda: reconstruido.ronda, unicos: reconstruido.unicos },
      },
    );
  }

  const apartar: { ruta: string; motivo: string; n: number | null }[] = [];
  let adoptar: EntradaDePagina | null = null;
  const candidata = entradas[P];
  if (candidata !== undefined) {
    const t = tocaAhora(candidata.n);
    if (!coincide(candidata, t)) {
      throw incoherente(
        `la página ${String(candidata.n)} del diario no es la que tocaba.`,
      );
    }
    const cuerpo = almacen.leer(candidata.fichero);
    const verifica = cuerpo !== null && sha256(cuerpo) === candidata.sha256;
    const valida =
      verifica &&
      candidata.estado === "confirmada" &&
      leerPagina(candidata.http, cuerpo).valida;
    if (valida) adoptar = candidata;
    else if (cuerpo !== null) {
      apartar.push({
        ruta: candidata.fichero,
        motivo: !verifica
          ? "sha256_no_verifica"
          : candidata.estado === "invalida"
            ? "respuesta_invalida"
            : "pagina_invalida",
        n: candidata.n,
      });
    } else {
      // Sin cuerpo, la entrada no tiene nada que apartar en el crudo.
      apartar.push({ ruta: "", motivo: "cuerpo_ausente", n: candidata.n });
    }
  }

  // Cuerpos sin entrada —la respuesta llegó y el proceso cayó antes de anotarla—
  // y cualquier otra cosa que no sea del crudo.
  const conEntrada = new Set(entradas.map((e) => e.fichero));
  for (const ruta of almacen.listar()) {
    // Un temporal que sobrevivió a una caída a mitad de escritura: nunca llegó
    // a ser fichero del crudo, y se aparta como evidencia.
    if (ruta.includes(".tmp-")) {
      apartar.push({ ruta, motivo: "temporal_incompleto", n: null });
      continue;
    }
    if (
      ruta === FICHERO_DEL_PLAN ||
      ruta === FICHERO_DEL_MANIFIESTO ||
      ruta === FICHERO_DE_SUMAS
    )
      continue;
    if (!ruta.startsWith(`${DIRECTORIO_DE_PAGINAS}/`)) {
      throw incoherente(`fichero ajeno al crudo: ${ruta}`, { ruta });
    }
    if (!conEntrada.has(ruta))
      apartar.push({ ruta, motivo: "cuerpo_sin_entrada", n: null });
  }

  return {
    previa: ultimo.runId,
    checkpoint: checkpointDeCapturaV1.parse({ ...previo, reanudaDe: ultimo.runId }),
    rondas,
    acumulador,
    confirmadas,
    adoptar,
    apartar,
  };
}

export async function ejecutarCaptura(
  opciones: OpcionesDeCaptura,
): Promise<ResultadoDeCaptura> {
  const { plan, reloj, almacen } = opciones;
  const relojDeT0 = opciones.relojDeT0 ?? (() => Promise.resolve(reloj()));
  const bytesDelPlan = codificador.encode(jsonDeFichero(plan));
  const huellaDelPlan = sha256(bytesDelPlan);
  const estratoPorNombre = new Map(plan.estratos.map((e) => [e.estrato, e]));

  let T0: Date | null = null;
  let rondas: EstadoDeRondas = iniciarRondas(plan.estratos.map((e) => e.estrato));
  let acumulador = crearAcumulador();
  let reanudacion: PlanDeReanudacion | null = null;
  let informeDeReanudacion: InformeDeReanudacion | null = null;
  const adoptadas = new Set<number>();
  let paginasActivas = 0;
  let respuestas = 0;
  let motivoDeExito: string | null = null;
  let checkpoint: CheckpointDeCaptura | null = null;
  let paginaInvalida = false;

  const resultado = await ejecutarJob(
    opciones.ejecutorOps,
    {
      pipeline: "seed",
      fase: "captura",
      presupuesto: opciones.presupuesto,
      ahora: reloj(),
      commitSha: opciones.commitSha ?? null,
      async checkpointInicial(ejecutorOps) {
        // Inmediatamente antes de la primera reserva: ni un paso más.
        const ahora = await relojDeT0();
        if (opciones.reanudar === true) {
          reanudacion = await planificarReanudacion(
            ejecutorOps,
            opciones,
            bytesDelPlan,
            huellaDelPlan,
            ahora,
          );
          T0 = new Date(reanudacion.checkpoint.T0);
          rondas = reanudacion.rondas;
          acumulador = reanudacion.acumulador;
          paginasActivas = reanudacion.confirmadas.length;
          checkpoint = reanudacion.checkpoint;
          return checkpoint;
        }
        if (almacen.listar().length > 0 || almacen.listarDiario("").length > 0) {
          throw new ArranqueDenegado(
            "crudo_no_vacio",
            "el directorio del crudo o su diario ya tienen ficheros: una captura nueva empieza vacía.",
          );
        }
        if ((await filasDeLaCaptura(ejecutorOps, plan.capturaId)).length > 0) {
          throw new ArranqueDenegado(
            "captura_ya_existe",
            `ya hay filas de la captura ${plan.capturaId}: se reanuda, no se repite con otro S.`,
          );
        }
        const cicloDeT0 = calcularCiclo(ahora, plan.m1.diaDeCiclo).clave;
        if (cicloDeT0 !== cicloSiguiente(plan.m1.cicloClave)) {
          throw new ArranqueDenegado(
            "m1_caducada",
            `la M1 del plan (fila ${plan.m1.runId}, ciclo ${String(plan.m1.cicloClave)}) ` +
              `solo autoriza una captura que empiece en ${String(cicloSiguiente(plan.m1.cicloClave))}, ` +
              `y esta empezaría en ${String(cicloDeT0)}.`,
            {
              m1_run_id: plan.m1.runId,
              ciclo_m1: plan.m1.cicloClave,
              ciclo_captura: cicloDeT0,
            },
          );
        }
        T0 = ahora;
        checkpoint = checkpointDeRondas(
          {
            v: VERSION_DEL_CHECKPOINT_DEL_SEED,
            fase: "captura",
            capturaId: plan.capturaId,
            huellaDelPlan,
            T0: ahora.toISOString(),
            ancla: anclaDesdeT0(ahora).toISOString(),
            reanudaDe: null,
          },
          rondas,
          0,
          0,
        );
        return checkpoint;
      },
    },
    async (contexto) => {
      const base = checkpoint;
      if (base === null) throw new Error("La captura corre sin checkpoint inicial.");
      const cuota = await prepararCuota({
        contexto,
        ejecutorOps: opciones.ejecutorOps,
        comprobarProveedor: opciones.comprobarCuotaDelProveedor,
        reloj,
      });
      const avanzar = async (): Promise<void> => {
        checkpoint = checkpointDeRondas(
          base,
          rondas,
          paginasActivas,
          acumulador.unicosElegibles(),
        );
        await escribirCheckpoint(opciones.ejecutorOps, contexto.runId, checkpoint);
      };

      const plr = reanudacion;
      if (plr === null) {
        // El plan, ANTES de la primera request.
        almacen.escribir(FICHERO_DEL_PLAN, bytesDelPlan);
      } else {
        const id = String(contexto.runId);
        let cierreApartado = false;
        for (const ruta of [FICHERO_DEL_MANIFIESTO, FICHERO_DE_SUMAS]) {
          if (almacen.leer(ruta) !== null) {
            almacen.apartar(ruta, `cierres/${id}/${ruta}`);
            cierreApartado = true;
          }
        }
        for (const a of plr.apartar) {
          if (a.ruta !== "") almacen.apartar(a.ruta, `retiradas/${id}/${a.ruta}`);
          if (a.n !== null) {
            // Se mueve: el número de página queda libre para volver a pedirla.
            const entrada = RUTA_DE_ENTRADA(a.n);
            if (almacen.leerDiario(entrada) !== null) {
              almacen.moverEnDiario(entrada, `retiradas/${id}/${entrada}`);
            }
          }
          almacen.escribirDiario(
            `retiradas/${id}/motivo-${a.n === null ? a.ruta.replace(/[/]/g, "_") : String(a.n)}.json`,
            codificador.encode(
              jsonDeFichero({ ruta: a.ruta, n: a.n, motivo: a.motivo, runId: id }),
            ),
          );
        }
        if (plr.adoptar !== null) {
          const e = plr.adoptar;
          const leida = leerPagina(e.http, almacen.leer(e.fichero) ?? new Uint8Array());
          if (!leida.valida) throw new Error("La página a adoptar dejó de ser válida.");
          almacen.escribirDiario(
            RUTA_DE_ADOPCION(e.n),
            codificador.encode(
              jsonDeFichero({ n: e.n, sha256: e.sha256, adoptadaPor: id }),
            ),
          );
          acumulador.anadir({
            n: e.n,
            estrato: e.estrato,
            respondidaEn: new Date(e.respondidaEn),
            shows: leida.pagina.shows,
          });
          const tocaba = siguientePeticion(rondas);
          if (tocaba === null) {
            const d = cerrarRonda(
              rondas,
              acumulador.unicosElegibles(),
              plan.objetivoUnicos,
            );
            if (d.tipo === "parar") throw new Error("Adoptar tras una parada.");
            rondas = d.estado;
          }
          const r = registrarPagina(rondas, {
            estrato: e.estrato,
            hasMore: leida.pagina.hasMore,
            nextCursor: leida.pagina.nextCursor,
          });
          rondas = r.estado;
          adoptadas.add(e.n);
          paginasActivas++;
          await avanzar();
          if (r.tipo === "cursor_sin_progreso") {
            throw new FalloOperativo(
              "cursor_sin_progreso",
              `el estrato ${r.estrato} devolvió hasMore sin un cursor nuevo.`,
              {
                pagina: e.n,
                estrato: r.estrato,
              },
            );
          }
        }
        informeDeReanudacion = {
          reanudaDe: plr.previa,
          paginasConfirmadas: plr.confirmadas.length,
          adoptada: plr.adoptar?.n ?? null,
          apartadas: plr.apartar.map((a) => ({ ruta: a.ruta, motivo: a.motivo })),
          cierreApartado,
        };
      }

      for (;;) {
        const tocaba = siguientePeticion(rondas);
        if (tocaba === null) {
          // Al cerrar la ronda, y solo entonces, el criterio de parada.
          const decision = cerrarRonda(
            rondas,
            acumulador.unicosElegibles(),
            plan.objetivoUnicos,
          );
          if (decision.tipo === "parar") {
            motivoDeExito = decision.motivo;
            return;
          }
          rondas = decision.estado;
          continue;
        }
        const estrato = estratoPorNombre.get(tocaba.estrato);
        if (estrato === undefined)
          throw new Error(`Estrato fuera del plan: ${tocaba.estrato}`);
        const query = queryDePagina(estrato, tocaba.cursorDeEntrada);

        const reservasAntes = cuota.reservas();
        // La fuente reserva: denegada → PresupuestoAgotado → budget_stopped.
        const respuesta = await opciones.fuente(
          {
            estrato,
            ronda: tocaba.ronda,
            cursorDeEntrada: tocaba.cursorDeEntrada,
            query,
          },
          cuota.fuente,
        );
        const reservadaEn = cuota.ultimaReserva();
        if (cuota.reservas() !== reservasAntes + 1 || reservadaEn === null) {
          throw new Error(
            `La fuente de páginas no reservó cuota exactamente una vez para ${estrato.estrato}: ` +
              `ninguna request puede salir sin reserva previa.`,
          );
        }
        respuestas++;
        const respondidaEn = reloj();

        const n = paginasActivas + 1;
        const fichero = ficheroDePagina(n, estrato.estrato, tocaba.ronda);
        // El cuerpo exacto, AL LLEGAR: lo pagado no se pierde aunque no se entienda.
        almacen.escribir(fichero, respuesta.cuerpo);
        const leida = leerPagina(respuesta.status, respuesta.cuerpo);
        const entrada: EntradaDePagina = {
          n,
          estrato: estrato.estrato,
          ronda: tocaba.ronda,
          fichero,
          cursorDeEntrada: tocaba.cursorDeEntrada,
          query: { ...query },
          reservadaEn: reservadaEn.toISOString(),
          respondidaEn: respondidaEn.toISOString(),
          http: respuesta.status,
          bytes: respuesta.cuerpo.length,
          sha256: sha256(respuesta.cuerpo),
          shows: leida.valida ? leida.pagina.shows.length : null,
          hasMore: leida.valida ? leida.pagina.hasMore : null,
          nextCursor: leida.valida ? leida.pagina.nextCursor : null,
          cuota: cuotaDe(respuesta.cabeceras),
          runId: idDeOpsComoTexto(contexto.runId),
          estado: leida.valida ? "confirmada" : "invalida",
        };
        // Después del cuerpo: una entrada nunca apunta a un cuerpo que no existe.
        almacen.escribirDiario(
          RUTA_DE_ENTRADA(n),
          codificador.encode(jsonDeFichero(entrada)),
        );
        paginasActivas = n;
        // La cuota del proveedor, tras guardar: cierra la guardia para la siguiente.
        cuota.observar(respuesta.status, respuesta.cabeceras);

        if (!leida.valida) {
          paginaInvalida = true;
          // Sin reintento automático: se revisa la causa y se reanuda.
          throw new FalloOperativo(
            "respuesta_invalida",
            `la página ${String(n)} (${estrato.estrato}) no es una respuesta válida de search/filters.`,
            {
              pagina: n,
              estrato: estrato.estrato,
              http: respuesta.status,
              cursor: tocaba.cursorDeEntrada,
              causa: leida.causa,
              ...(leida.showInvalido === null
                ? {}
                : {
                    show: leida.showInvalido.posicion,
                    problemas: leida.showInvalido.problemas,
                  }),
            },
          );
        }

        acumulador.anadir({
          n,
          estrato: estrato.estrato,
          respondidaEn,
          shows: leida.pagina.shows,
        });
        const r = registrarPagina(rondas, {
          estrato: estrato.estrato,
          hasMore: leida.pagina.hasMore,
          nextCursor: leida.pagina.nextCursor,
        });
        rondas = r.estado;
        // Después de escribir la página: si el proceso cae entre las dos
        // cosas, la página está en el crudo y la reanudación la adopta.
        await avanzar();

        if (r.tipo === "cursor_sin_progreso") {
          throw new FalloOperativo(
            "cursor_sin_progreso",
            `el estrato ${r.estrato} devolvió hasMore sin un cursor nuevo.`,
            {
              pagina: n,
              estrato: r.estrato,
              cursor: r.cursorDeEntrada,
              nextCursor: r.nextCursor,
            },
          );
        }
      }
    },
  );

  // Sin T0 no hubo captura —o la reanudación se denegó al planificar—: la
  // fila se abrió y cerró sin tocar el crudo.
  const t0 = T0 as Date | null;
  if (!resultado.ejecutado || t0 === null || checkpoint === null) {
    return {
      resultado,
      manifiesto: null,
      checkpoint,
      reanudacion: informeDeReanudacion,
    };
  }

  const primera = resultado.metricas.errorSamples[0];
  const motivo =
    resultado.estado === "succeeded"
      ? (motivoDeExito ?? "succeeded")
      : typeof primera?.motivo === "string"
        ? primera.motivo
        : "sin_muestra";

  // Adoptadas por esta ejecución o por cualquier reanudación anterior.
  const adoptadasEnDiario = new Set(
    almacen.listarDiario("adopciones/").map((r) => Number(/(\d+)\.json$/.exec(r)?.[1])),
  );
  const paginas = leerEntradas(almacen).map((e) =>
    adoptadas.has(e.n) || adoptadasEnDiario.has(e.n)
      ? { ...e, estado: "adoptada" as const }
      : e,
  );
  const ultima = paginas.at(-1);
  const idActual = idDeOpsComoTexto(resultado.runId);
  // Las filas de la captura, esta incluida: su `requests_made` es la verdad
  // del libro —también lo reservado y no respondido, que no se devuelve—.
  const filas = await filasDeLaCaptura(opciones.ejecutorOps, plan.capturaId);
  // Respuestas con cuerpo persistido de las ejecuciones anteriores —las
  // apartadas también fueron respuestas— más las de esta.
  const respuestasPrevias = [
    ...leerEntradas(almacen),
    ...leerEntradas(almacen, true),
  ].filter((e) => e.runId !== idActual).length;
  const cierre: CierreDeCaptura = {
    T0: t0.toISOString(),
    ancla: anclaDesdeT0(t0).toISOString(),
    T1: ultima === undefined ? t0.toISOString() : ultima.respondidaEn,
    estado: resultado.estado,
    motivo,
    cortadoPorTope:
      resultado.estado === "budget_stopped" && motivo === "tope_por_ejecucion",
    rondasCompletas: rondasCompletas(rondas),
    // Ninguna ronda a medias, ninguna página inválida, al menos una ronda entera.
    rondaCompleta:
      !paginaInvalida && enFronteraDeRonda(rondas) && rondasCompletas(rondas) >= 1,
    requestsReservadas: filas.reduce((s, f) => s + f.requestsMade, 0),
    respuestas: respuestasPrevias + respuestas,
    filasDeOps: filas.some((f) => idDeOpsComoTexto(f.id) === idActual)
      ? filas.map((f) => idDeOpsComoTexto(f.id))
      : [...filas.map((f) => idDeOpsComoTexto(f.id)), idActual],
    destino: opciones.destino,
  };
  const manifiesto: ManifiestoDelSeed = {
    formato: FORMATO_DEL_MANIFIESTO,
    v: VERSION_DEL_CRUDO,
    capturaId: plan.capturaId,
    huellaDelPlan,
    paginas,
    cierre,
  };
  almacen.escribir(
    FICHERO_DEL_MANIFIESTO,
    codificador.encode(jsonDeFichero(manifiesto)),
  );
  const sumas = almacen
    .listar()
    .filter((r) => r !== FICHERO_DE_SUMAS)
    .map((ruta) => ({ ruta, sha256: sha256(almacen.leer(ruta) ?? new Uint8Array()) }));
  almacen.escribir(FICHERO_DE_SUMAS, codificador.encode(construirSumas(sumas)));
  return { resultado, manifiesto, checkpoint, reanudacion: informeDeReanudacion };
}
