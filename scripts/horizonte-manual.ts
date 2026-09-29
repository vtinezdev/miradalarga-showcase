/**
 * Lo que comparten las ejecuciones **manuales** de los recorridos del
 * horizonte —`run-expiring-manual.ts` y `run-upcoming-manual.ts`— contra
 * `drizzle-schema-v1-test`: el ensayo, la reproducción y la ejecución real.
 *
 *   --ensayo            CERO API · Neon · todo en ROLLBACK
 *   --reproducir <dir>  CERO API · Neon · todo en ROLLBACK
 *   --real              GASTA CUOTA · hasta el tope del script, nunca por encima
 *                       del oficial del pipeline (`exigirTopeOficial`)
 *
 * Aquí no hay ninguna decisión de pipeline: cada script pone su descriptor
 * —job, tope, fixtures— y las comprobaciones que solo tienen sentido para él.
 * Lo común se escribe una vez para que las dos mediciones se hagan igual.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import type {
  EjecutorSql,
  NombreDePipeline,
  Presupuesto,
} from "../jobs/ops/contratos.ts";
import { crearLibroEnMemoria } from "../jobs/ops/libro-en-memoria.ts";
import type { LibroEnMemoria } from "../jobs/ops/libro-en-memoria.ts";
import {
  TOPE_POR_EJECUCION_POR_DEFECTO,
  calcularCiclo,
} from "../jobs/ops/presupuesto.ts";
import type { FuenteDeCuota, Transporte } from "../jobs/ops/transporte.ts";
import { crearTransporte } from "../jobs/ops/transporte.ts";
import type { EventosAuditados } from "../jobs/pipelines/deltas/auditoria.ts";
import {
  auditarEventos,
  contarOpcionesDuplicadas,
  contarTablas,
  diferenciaDeRecuentos,
  leerLibroDelCiclo,
  maximoIdDeEventos,
  verificarCuadre,
} from "../jobs/pipelines/deltas/auditoria.ts";
import type { CheckpointDeCambios } from "../jobs/pipelines/deltas/checkpoint.ts";
import type {
  OpcionesDelJobDeCambios,
  ResultadoDelJobDeCambios,
} from "../jobs/pipelines/deltas/job.ts";
import {
  transaccionConSavepoint,
  transaccionPorPagina,
} from "../jobs/pipelines/deltas/job.ts";
import {
  crearRegistroLocal,
  leerManifiesto,
  ventanaDesdeSegundos,
  ventanaEnSegundos,
} from "../jobs/pipelines/deltas/manifiesto.ts";
import type {
  HuellaDeLaRama,
  Manifiesto,
  RegistroLocal,
  ResultadoDelHorizonte,
} from "../jobs/pipelines/deltas/manifiesto.ts";
import { CATALOGOS_MVP, ventanaHaciaDelante } from "../jobs/pipelines/deltas/origen.ts";
import type { TipoDeHorizonte } from "../jobs/pipelines/horizonte/checkpoint.ts";
import { HORIZONTE_MAXIMO_DIAS } from "../jobs/pipelines/horizonte/checkpoint.ts";
import type {
  Diferencia,
  LectorDeManifiestos,
  PlanDeReconstruccion,
  ResolverRuta,
} from "../jobs/pipelines/horizonte/reproduccion.ts";
import { cambiosEnLaRama } from "../jobs/pipelines/horizonte/reproduccion.ts";
import { construirFilas } from "../jobs/pipelines/seed/filas.ts";
import { ejecutarSeed } from "../jobs/pipelines/seed/index.ts";
import { leerCorpusSpike1 } from "../jobs/pipelines/seed/origen.ts";
import type { RegimenDeArranque } from "../jobs/pipelines/arranque.ts";
import type { Grabada } from "./manual-comun.ts";
import {
  claveGrabada,
  comprobar,
  conectar,
  destinoVerificado,
  informarEjecucion,
  llamadaDesdeDisco,
  mismoValorJson,
  presupuestoInyectado,
  REGIMEN_DE_LOS_SCRIPTS,
  rutaCopiable,
  seccion,
  sello,
  tabla,
} from "./manual-comun.ts";

export const RAIZ = join(import.meta.dirname, "..");

/**
 * **El tope de una ejecución real manual nunca supera el oficial del
 * pipeline** (`TOPE_POR_EJECUCION_POR_DEFECTO`). Una medición pudo necesitar
 * otro tope antes de que existiera uno aprobado; una vez aprobado, el script
 * manual no es una puerta trasera para gastar más que `pnpm job`.
 *
 * Devuelve el tope si es válido; si no, lanza **antes** de leer la credencial
 * o abrir una conexión. Con un tope oficial de 0 —pipeline no autorizado— no
 * cabe ninguno.
 */
export function exigirTopeOficial(pipeline: NombreDePipeline, tope: number): number {
  const oficial = TOPE_POR_EJECUCION_POR_DEFECTO[pipeline];
  if (!Number.isSafeInteger(tope) || tope < 1 || tope > oficial) {
    throw new Error(
      `El tope de la ejecución real de ${pipeline} (${String(tope)}) tiene que ser un ` +
        `entero entre 1 y su tope oficial (${String(oficial)}, jobs/ops/presupuesto.ts). ` +
        "No se ha pedido nada.",
    );
  }
  return tope;
}
export const RAIZ_SPIKE = join(RAIZ, "spike-1");

/** Todas las respuestas de `/changes` del Spike 1: C (017–024), D (025–036), H (053–056). */
export const RESPUESTAS_DE_CHANGES = /^\d{3}-(C-changes|D-|H-daily)-/;

// ── El crudo del Spike ──────────────────────────────────────────────────────

export interface AvisoCrudo {
  readonly changeType: string;
  readonly showId: string;
  readonly service: { readonly id: string };
  readonly streamingOptionType: string;
  readonly addon?: { readonly id: string };
  readonly link?: string;
  readonly timestamp: number;
}

export interface CuerpoDeCambios {
  readonly changes: readonly AvisoCrudo[];
  readonly shows: Readonly<Record<string, { readonly imdbId: string }>>;
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

interface FicheroDelSpike {
  readonly meta: {
    readonly ventana: { readonly from_epoch: number; readonly to_epoch: number };
    readonly catalogs: readonly string[];
  };
  readonly body: CuerpoDeCambios;
}

function leerFixture(nombre: string): FicheroDelSpike {
  return JSON.parse(
    readFileSync(join(RAIZ_SPIKE, "raw", nombre), "utf8"),
  ) as FicheroDelSpike;
}

/**
 * ⚠️ **La página 2 es SINTÉTICA.** El Spike 1 nunca pidió la página 2 de la
 * lista combinada, y las de `changes_validation` (filas 19–20) no se
 * guardaron. Se compone con los avisos **reales** de las listas por
 * plataforma (`porPlataforma`) que no estaban ya en la página 1, en orden de
 * fecha, con `hasMore=false`. Sirve para ejercitar la paginación y el
 * recorrido completo; **no** es evidencia del volumen.
 */
function componerPagina2(
  pagina1: CuerpoDeCambios,
  porPlataforma: RegExp,
): CuerpoDeCambios {
  const firma = (a: AvisoCrudo) =>
    `${a.showId}|${a.service.id}|${a.streamingOptionType}|${a.addon?.id ?? ""}`;
  const vistas = new Set(pagina1.changes.map(firma));
  const avisos: AvisoCrudo[] = [];
  const shows: Record<string, { readonly imdbId: string }> = {};
  const ficheros = readdirSync(join(RAIZ_SPIKE, "raw"))
    .filter((f) => porPlataforma.test(f))
    .sort();
  for (const fichero of ficheros) {
    const cuerpo = leerFixture(fichero).body;
    for (const a of cuerpo.changes) {
      if (vistas.has(firma(a))) continue;
      vistas.add(firma(a));
      avisos.push(a);
      const show = cuerpo.shows[a.showId];
      if (show !== undefined) shows[a.showId] = show;
    }
  }
  avisos.sort((x, y) => x.timestamp - y.timestamp);
  return { changes: avisos, shows, hasMore: false };
}

// ── Consultas de auditoría comunes ──────────────────────────────────────────

/** Opciones con `missing_streak > 0`: si el recorrido no interpreta ausencias, no cambia. */
export async function opcionesConAusencias(db: EjecutorSql): Promise<number> {
  const [fila] = await db.ejecutar<{ n: string }>(
    "SELECT count(*)::text AS n FROM external_availability_options WHERE missing_streak > 0",
  );
  return Number(fila?.n ?? -1);
}

/** La huella de la rama: ver `HuellaDeLaRama` en `deltas/manifiesto.ts`. */
export async function huellaDeLaRama(db: EjecutorSql): Promise<HuellaDeLaRama> {
  const [fila] = await db.ejecutar<{ m: Date | string | null }>(
    "SELECT max(last_checked_at) AS m FROM external_availability",
  );
  const m = fila?.m ?? null;
  return {
    recuentos: await contarTablas(db),
    ultimoEvento: await maximoIdDeEventos(db),
    ultimaComprobacion: m === null ? null : new Date(m).toISOString(),
  };
}

// ── El descriptor de un pipeline del horizonte ──────────────────────────────

export type ResultadoDeHorizonte = ResultadoDelJobDeCambios<CheckpointDeCambios> & {
  readonly horizonte: ResultadoDelHorizonte | null;
};

export interface DescriptorDeHorizonte<R extends ResultadoDeHorizonte> {
  readonly pipeline: NombreDePipeline;
  readonly tipo: TipoDeHorizonte;
  /**
   * El tope de la ejecución real, inyectado en este proceso. **Nunca por
   * encima del oficial**: `real` lo rechaza (`exigirTopeOficial`).
   */
  readonly tope: number;
  /** Absoluto: `.expiring-runs/`, `.upcoming-runs/`. */
  readonly directorioDeEjecuciones: string;
  ejecutar(
    opciones: OpcionesDelJobDeCambios & { readonly regimen: RegimenDeArranque },
  ): Promise<R>;
  planificar(ahora: Date): CheckpointDeCambios;
  /** Lanza si el checkpoint de la fila no es v1 de este pipeline. */
  leerCheckpoint(valor: unknown, runId: number): unknown;
  planDeReconstruccion(
    directorio: string,
    leer: LectorDeManifiestos,
    resolver: ResolverRuta,
  ): PlanDeReconstruccion;
  comparar(
    original: Manifiesto,
    reproducido: Manifiesto,
    exacta: boolean,
  ): readonly Diferencia[];
  /** Lo propio que imprimir tras cada ejecución: el horizonte, los anuncios… */
  informar(salida: R): void;
}

export const estadoDe = (s: ResultadoDeHorizonte): string =>
  s.resultado.ejecutado ? s.resultado.estado : "no_ejecutado";

/** El resultado del horizonte, completo o no, con su muestra. */
export function informarHorizonte(salida: ResultadoDeHorizonte): void {
  const h = salida.horizonte;
  if (h === null) return;
  if (!h.completo) {
    const pendiente = salida.checkpoint?.pendiente;
    console.log(
      `  horizonte         INCOMPLETO` +
        (pendiente === null || pendiente === undefined
          ? ""
          : ` · hasMore=true, se cortó antes de ${pendiente.cursorDeEntrada ?? "la primera página"}`),
    );
    console.log(
      "                    desaparecidas: sin dato (el recorrido no terminó)",
    );
    return;
  }
  console.log(
    `  horizonte         COMPLETO · ${String(salida.checkpoint?.paginasConfirmadas ?? "?")} páginas · ` +
      `desaparecidas ${String(h.desaparecidas)}` +
      (h.fueraDeCobertura === undefined
        ? ""
        : ` · fuera de cobertura ${String(h.fueraDeCobertura)}`),
  );
  for (const clave of h.muestra) console.log(`                    · ${clave}`);
}

// ── --ensayo ────────────────────────────────────────────────────────────────

export interface FixturesDelEnsayo {
  /** La página 1 medida: la lista combinada de las seis plataformas. */
  readonly pagina1: string;
  /** Las listas por plataforma de las que se compone la página 2. */
  readonly porPlataforma: RegExp;
  /** Cómo nombrarlas en la salida: `raw/023`, `raw/025–030`… */
  readonly etiquetaPagina1: string;
  readonly etiquetaPagina2: string;
}

export interface PaginasDelEnsayo {
  readonly pagina1: CuerpoDeCambios;
  readonly pagina2: CuerpoDeCambios;
}

export interface ComprobacionesDelEnsayo<
  R extends ResultadoDeHorizonte,
  P = undefined,
> {
  /** Los `event_type` que la pasada 1 puede producir sobre el corpus. */
  readonly eventosPermitidos: readonly string[];
  /**
   * Lo que hay que mirar de la base **antes** de la pasada 1, con la línea
   * base ya sembrada. Lo recibe `pasada1` como `previo`.
   */
  preparar?(db: EjecutorSql): Promise<P>;
  /** Lo propio del pipeline tras la pasada 1. */
  pasada1(
    db: EjecutorSql,
    salida: R,
    paginas: PaginasDelEnsayo,
    ahora: Date,
    previo: P | undefined,
  ): Promise<void>;
}

export async function ensayo<R extends ResultadoDeHorizonte, P = undefined>(
  d: DescriptorDeHorizonte<R>,
  fixtures: FixturesDelEnsayo,
  propias: ComprobacionesDelEnsayo<R, P>,
): Promise<void> {
  console.log(
    `ENSAYO DE ${d.pipeline} CONTRA NEON — CERO API · TODO DENTRO DE UN ROLLBACK\n`,
  );
  const url = await destinoVerificado();
  const presupuesto = presupuestoInyectado(d.pipeline, d.tope);

  const fichero1 = leerFixture(fixtures.pagina1);
  const pagina1 = fichero1.body;
  const pagina2 = componerPagina2(pagina1, fixtures.porPlataforma);
  const cursor1 = pagina1.nextCursor;
  if (cursor1 === undefined) {
    throw new Error(`${fixtures.etiquetaPagina1} no trae nextCursor.`);
  }

  // El `ahora` del ensayo hace que `to` coincida AL SEGUNDO con el medido:
  // `to = ahora + 31 días`. `from` lleva el margen de reloj de 60 s.
  const medida = fichero1.meta.ventana;
  const ahora = new Date((medida.to_epoch - HORIZONTE_MAXIMO_DIAS * 86_400) * 1000);
  const ventana = ventanaHaciaDelante(ahora, HORIZONTE_MAXIMO_DIAS);
  const v = ventanaEnSegundos(ventana);

  // ⚠️ Cabeceras SINTÉTICAS para las dos páginas: sirven para ejercitar la
  // guardia externa; no son evidencia del proveedor.
  let usadaSintetica = 0;
  const cabecerasSinteticas = (): Record<string, string> => ({
    "x-quota-used": String(++usadaSintetica),
    "x-quota-granted": "1000",
    "x-quota-reset": "2026-10-01T00:00:00Z",
  });

  const cursoresPedidos: (string | null)[] = [];
  const validarUrl = (u: URL): void => {
    const q = u.searchParams;
    cursoresPedidos.push(q.get("cursor"));
    const esperadas = [
      "catalogs",
      "change_type",
      "country",
      "from",
      "include_unknown_dates",
      "item_type",
      "output_language",
      "to",
    ];
    const recibidas = [...q.keys()].filter((k) => k !== "cursor").sort();
    if (JSON.stringify(recibidas) !== JSON.stringify(esperadas)) {
      throw new Error(`Query distinta de la esperada: ${recibidas.join(",")}`);
    }
    if (q.get("change_type") !== d.tipo || q.get("include_unknown_dates") !== "false") {
      throw new Error("change_type o include_unknown_dates distintos de los medidos.");
    }
    if (Number(q.get("to")) !== medida.to_epoch || Number(q.get("from")) !== v.from) {
      throw new Error(
        `Ventana distinta: ${q.get("from") ?? "?"}–${q.get("to") ?? "?"} frente a ` +
          `${String(v.from)}–${String(medida.to_epoch)}`,
      );
    }
    if (
      q.get("catalogs") !== fichero1.meta.catalogs.join(",") ||
      q.get("catalogs") !== CATALOGOS_MVP
    ) {
      throw new Error(
        `Catálogos distintos de los medidos: ${q.get("catalogs") ?? "?"}`,
      );
    }
  };

  const servir = (): ((fuente: FuenteDeCuota) => Transporte) => {
    const grabadas = new Map<string, Grabada>([
      [
        claveGrabada(d.tipo, null),
        { cuerpo: JSON.stringify(pagina1), cabeceras: cabecerasSinteticas() },
      ],
      [
        claveGrabada(d.tipo, cursor1),
        { cuerpo: JSON.stringify(pagina2), cabeceras: cabecerasSinteticas() },
      ],
    ]);
    return llamadaDesdeDisco(grabadas, validarUrl);
  };

  const directorio = join(d.directorioDeEjecuciones, `${sello()}-ensayo`);
  console.log(`  manifiestos       ${rutaCopiable(directorio)}`);
  console.log(
    `  ventana           ${ventana.desde.toISOString()} → ${ventana.hasta.toISOString()}`,
  );
  console.log(
    `  página 1          ${fixtures.etiquetaPagina1} · ${String(pagina1.changes.length)} avisos · hasMore ${String(pagina1.hasMore)}`,
  );
  console.log(
    `  página 2          ⚠️ SINTÉTICA (${fixtures.etiquetaPagina2} sin repetir) · ${String(pagina2.changes.length)} avisos`,
  );
  console.log("  ⚠️  cabeceras x-quota SINTÉTICAS");

  const datos = await conectar(url);
  const db = datos.ejecutor;

  try {
    seccion("0 · Foto previa (fuera de la transacción)");
    const previos = await contarTablas(db);
    tabla(previos);
    const maxPrevio = await maximoIdDeEventos(db);
    // El corpus se siembra ENCIMA de la rama: su huella queda en cada
    // manifiesto para que `--reproducir` sepa si sigue siendo la misma base.
    const rama = await huellaDeLaRama(db);

    await db.ejecutar("BEGIN");
    try {
      seccion(
        "1 · Línea base: catálogo del Spike 1, SIN ninguna respuesta de /changes",
      );
      const corpus = leerCorpusSpike1(RAIZ_SPIKE, {
        excluir: (f) => RESPUESTAS_DE_CHANGES.test(f),
      });
      await ejecutarSeed(db, construirFilas(corpus.titulos));
      const base = await contarTablas(db);
      console.log(
        `    ${String(base.external_titles)} títulos · ${String(base.external_availability)} ofertas`,
      );
      await db.ejecutar("SAVEPOINT ensayo_base");

      /**
       * `previas`: las ejecuciones de este ensayo que ya estaban aplicadas
       * cuando empezó esta, relativas a su directorio. Con ellas y el corpus,
       * `--reproducir` reconstruye **exactamente** el estado de partida.
       */
      const correr = async (
        subdirectorio: string,
        previas: readonly string[],
        extra: {
          libro?: LibroEnMemoria;
          persistente?: boolean;
          presupuesto?: Presupuesto;
        } = {},
      ) => {
        const libro = extra.libro ?? crearLibroEnMemoria();
        cursoresPedidos.length = 0;
        const salida = await d.ejecutar({
          ejecutorOps: libro.ejecutor,
          ejecutorDatos: db,
          transaccion: transaccionConSavepoint(db),
          presupuesto: extra.presupuesto ?? presupuesto,
          crearLlamada: servir(),
          apiKey: "ensayo-sin-clave",
          plan:
            extra.persistente === true
              ? { origen: "persistente" }
              : { origen: "fijo", ventana },
          regimen: REGIMEN_DE_LOS_SCRIPTS,
          ahora,
          crearRegistro: (cabecera) =>
            crearRegistroLocal(join(directorio, subdirectorio), {
              modo: "ensayo",
              pipeline: d.pipeline,
              estadoInicial: {
                tipo: "corpus_spike1",
                excluir: RESPUESTAS_DE_CHANGES.source,
                previas,
                rama,
              },
              ...cabecera,
            }),
          vincularEventos: false,
        });
        informarEjecucion(d.pipeline, salida);
        d.informar(salida);
        return { salida, libro, cursores: [...cursoresPedidos] };
      };

      // ── Pasada 1 ──────────────────────────────────────────────────────────
      seccion("2 · Pasada 1: recorrido completo del horizonte sobre la línea base");
      const ausenciasAntes = await opcionesConAusencias(db);
      const previo = await propias.preparar?.(db);
      const { salida: p1 } = await correr("pasada-1", []);
      comprobar(
        "pasada 1 cierra succeeded",
        estadoDe(p1) === "succeeded",
        estadoDe(p1),
      );
      comprobar(
        "2 reservas: dos páginas, una request cada una",
        p1.contadores.reservasConcedidas === 2,
        String(p1.contadores.reservasConcedidas),
      );
      comprobar(
        "el recorrido del horizonte termina: pendiente = null",
        p1.checkpoint?.pendiente === null && p1.horizonte?.completo === true,
        JSON.stringify(p1.checkpoint?.pendiente ?? "sin checkpoint"),
      );
      comprobar(
        "con el recorrido completo, las desaparecidas se miden (número, no null)",
        typeof p1.horizonte?.desaparecidas === "number",
        String(p1.horizonte?.desaparecidas ?? null),
      );
      const aud1 = await auditarEventos(db, maxPrevio);
      console.log(`    eventos en la base: ${JSON.stringify(aud1.porTipo)}`);
      const tiposNoPermitidos = Object.keys(aud1.porTipo).filter(
        (t) => !propias.eventosPermitidos.includes(t),
      );
      comprobar(
        `solo ${propias.eventosPermitidos.map((t) => `\`${t}\``).join(" o ")}: ` +
          `${d.pipeline} no puede producir nada más`,
        tiposNoPermitidos.length === 0,
        tiposNoPermitidos.join(", ") || "ninguno fuera de lo permitido",
      );
      comprobar(
        "ningún evento con before == after",
        aud1.sinCambio === 0,
        String(aud1.sinCambio),
      );
      await propias.pasada1(db, p1, { pagina1, pagina2 }, ahora, previo);
      comprobar(
        "ninguna ausencia interpretada: mismas opciones con missing_streak > 0",
        (await opcionesConAusencias(db)) === ausenciasAntes,
        `${String(ausenciasAntes)} antes`,
      );
      comprobar("0 opciones duplicadas", (await contarOpcionesDuplicadas(db)) === 0);
      const tras1 = await contarTablas(db);

      // ── Pasada 2: idempotencia ────────────────────────────────────────────
      seccion("3 · Pasada 2: el mismo recorrido, el mismo `ahora`");
      const maxTras1 = await maximoIdDeEventos(db);
      const { salida: p2 } = await correr("pasada-2", ["../pasada-1"]);
      comprobar(
        "0 eventos calculados",
        Object.keys(p2.informe?.eventos ?? { x: 1 }).length === 0,
        JSON.stringify(p2.informe?.eventos ?? null),
      );
      comprobar(
        "ningún evento nuevo en la base",
        (await maximoIdDeEventos(db)) === maxTras1,
      );
      const dif2 = diferenciaDeRecuentos(tras1, await contarTablas(db));
      comprobar(
        "0 inserciones en todas las tablas; mismos recuentos",
        Object.keys(dif2).length === 0,
        JSON.stringify(dif2),
      );
      comprobar(
        "misma medición del horizonte",
        mismoValorJson(p2.horizonte, p1.horizonte),
        JSON.stringify(p2.horizonte),
      );

      // ── Corte por tope: recorrido incompleto ──────────────────────────────
      seccion("4 · Corte por tope (1): hasMore=true sin ampliar el límite");
      await db.ejecutar("ROLLBACK TO SAVEPOINT ensayo_base");
      const libroCompartido = crearLibroEnMemoria();
      const ausenciasCorte = await opcionesConAusencias(db);
      const { salida: pc } = await correr("corte", [], {
        libro: libroCompartido,
        presupuesto: presupuestoInyectado(d.pipeline, 1),
      });
      comprobar(
        "cierra budget_stopped",
        estadoDe(pc) === "budget_stopped",
        estadoDe(pc),
      );
      comprobar(
        "1 sola reserva: la segunda página no se pide",
        pc.contadores.reservasConcedidas === 1,
        String(pc.contadores.reservasConcedidas),
      );
      comprobar(
        "el checkpoint dice dónde se cortó: el nextCursor de la página 1",
        pc.checkpoint?.pendiente?.cursorDeEntrada === cursor1,
        JSON.stringify(pc.checkpoint?.pendiente ?? null),
      );
      comprobar(
        "recorrido incompleto: desaparecidas = null, no cero",
        pc.horizonte?.completo === false && pc.horizonte.desaparecidas === null,
        JSON.stringify(pc.horizonte),
      );
      comprobar(
        "ninguna ausencia interpretada tras el corte",
        (await opcionesConAusencias(db)) === ausenciasCorte,
      );

      // ── Nuevo recorrido: desde el principio, no desde el corte ────────────
      seccion("5 · El recorrido siguiente empieza desde su primera página");
      const { salida: pn, cursores } = await correr(
        "recorrido-siguiente",
        ["../corte"],
        {
          libro: libroCompartido,
          persistente: true,
        },
      );
      comprobar(
        "la primera página se pide SIN cursor",
        cursores[0] === null,
        JSON.stringify(cursores),
      );
      comprobar(
        "no reanuda la ejecución cortada: reanudaDe = null",
        pn.checkpoint?.reanudaDe === null,
        String(pn.checkpoint?.reanudaDe),
      );
      comprobar(
        "la ventana es la del plan: [ahora − 60 s, ahora + 31 d]",
        mismoValorJson(pn.checkpoint?.ventana, d.planificar(ahora).ventana),
        JSON.stringify(pn.checkpoint?.ventana),
      );
      comprobar(
        "cierra succeeded con el recorrido completo",
        estadoDe(pn) === "succeeded" && pn.horizonte?.completo === true,
        estadoDe(pn),
      );
      const audN: EventosAuditados = await auditarEventos(db, maxPrevio);
      comprobar(
        "corte + recorrido nuevo == pasada limpia en eventos",
        mismoValorJson(audN.porTipo, aud1.porTipo),
        `${JSON.stringify(audN.porTipo)} frente a ${JSON.stringify(aud1.porTipo)}`,
      );
      const difN = diferenciaDeRecuentos(tras1, await contarTablas(db));
      comprobar(
        "mismo estado final que la pasada limpia",
        Object.keys(difN).length === 0,
        JSON.stringify(difN),
      );
    } finally {
      await db.ejecutar("ROLLBACK");
    }

    seccion("6 · Rastro cero");
    const difFinal = diferenciaDeRecuentos(previos, await contarTablas(db));
    comprobar(
      "los 14 recuentos vuelven a la foto previa",
      Object.keys(difFinal).length === 0,
      JSON.stringify(difFinal),
    );
    comprobar("ningún evento sobrevive", (await maximoIdDeEventos(db)) === maxPrevio);
    console.log(
      `\n  Reproducir sin cuota:  pnpm api:run:${d.pipeline} --reproducir ${rutaCopiable(join(directorio, "pasada-1"))}` +
        "\n  (exacta solo mientras la rama no cambie: antes del próximo cron de deltas, 04:37 UTC)",
    );
  } finally {
    await datos.cliente.end().catch(() => undefined);
  }
}

// ── --reproducir ────────────────────────────────────────────────────────────

/** Las respuestas 2xx de un manifiesto, listas para servirse desde disco. */
export function grabadasDe(
  directorio: string,
  manifiesto: Manifiesto,
): Map<string, Grabada> {
  const grabadas = new Map<string, Grabada>();
  for (const r of manifiesto.respuestas) {
    if (r.status < 200 || r.status >= 300) continue;
    const cabeceras: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.cabeceras)) if (v !== null) cabeceras[k] = v;
    grabadas.set(claveGrabada(r.changeType, r.cursorDeEntrada), {
      cuerpo: readFileSync(join(directorio, r.fichero), "utf8"),
      cabeceras,
    });
  }
  return grabadas;
}

/**
 * Repite UNA ejecución grabada —su crudo, su ventana, su `ahora`, su tope— y
 * devuelve el manifiesto que deja la repetición, para compararlo.
 */
export async function repetir<R extends ResultadoDeHorizonte>(
  d: DescriptorDeHorizonte<R>,
  db: EjecutorSql,
  origen: string,
  destino: string,
): Promise<{ original: Manifiesto; repetido: Manifiesto; salida: R }> {
  const original = leerManifiesto(origen, d.pipeline);
  if (original.tipos.length !== 1 || original.tipos[0] !== d.tipo) {
    throw new Error(
      `${origen} no es un recorrido de ${d.pipeline}: ${original.tipos.join(",")}`,
    );
  }
  let registro: RegistroLocal | null = null;
  const salida = await d.ejecutar({
    ejecutorOps: crearLibroEnMemoria().ejecutor,
    ejecutorDatos: db,
    transaccion: transaccionConSavepoint(db),
    // El tope es lo que la original gastó: pide las mismas páginas y, si
    // aquella se cortó, esta se corta en el mismo punto.
    presupuesto: presupuestoInyectado(
      d.pipeline,
      Math.max(1, original.requests.reservadas),
    ),
    crearLlamada: llamadaDesdeDisco(grabadasDe(origen, original)),
    apiKey: "reproduccion-sin-clave",
    // La ventana GRABADA, no la de hoy: se reproduce lo que se pagó.
    plan: { origen: "fijo", ventana: ventanaDesdeSegundos(original.ventana) },
    regimen: REGIMEN_DE_LOS_SCRIPTS,
    ahora: new Date(original.ahora),
    crearRegistro: (cabecera) => {
      registro = crearRegistroLocal(destino, {
        modo: "reproduccion",
        pipeline: d.pipeline,
        ...cabecera,
      });
      return registro;
    },
    vincularEventos: false,
  });
  informarEjecucion(d.pipeline, salida);
  d.informar(salida);
  const repetido = (registro as RegistroLocal | null)?.manifiesto();
  if (repetido === undefined) {
    throw new Error(`La repetición de ${origen} no llegó a crear su manifiesto.`);
  }
  return { original, repetido, salida };
}

/** Cada campo comparado, como comprobación (exigible) o como información. */
export function informarComparacion(
  diferencias: readonly Diferencia[],
  prefijo: string,
): void {
  for (const dif of diferencias) {
    const detalle = dif.igual
      ? ""
      : `original ${JSON.stringify(dif.original)} · reproducido ${JSON.stringify(dif.reproducido)}`;
    if (dif.exigible) {
      comprobar(`${prefijo}${dif.campo} coincide con la original`, dif.igual, detalle);
    } else {
      console.log(
        `  ℹ️  ${prefijo}${dif.campo}: ${dif.igual ? "coincide" : "NO comparable"}` +
          (dif.igual ? "" : ` — ${detalle}`),
      );
    }
  }
}

/**
 * Reproduce una ejecución **desde su mismo estado lógico de partida**
 * (`jobs/pipelines/horizonte/reproduccion.ts`), todo dentro de un `ROLLBACK`:
 *
 *   1. reconstruye el estado de partida: el corpus y las ejecuciones previas
 *      (ensayo), o la rama tal cual (ejecución real: no reconstruible);
 *   2. repite la ejecución y la compara con la original — **todo** si la
 *      reconstrucción es exacta; lo que sale del crudo si no;
 *   3. la repite otra vez: tiene que ser un no-op.
 */
export async function reproducir<R extends ResultadoDeHorizonte>(
  d: DescriptorDeHorizonte<R>,
  argumento: string,
): Promise<void> {
  console.log(
    `REPRODUCCIÓN DE UNA EJECUCIÓN DE ${d.pipeline} — CERO API · TODO DENTRO DE UN ROLLBACK\n`,
  );
  const directorio = resolve(RAIZ, argumento);
  const plan = d.planDeReconstruccion(
    directorio,
    (dir) => leerManifiesto(dir, d.pipeline),
    (base, relativa) => resolve(base, relativa),
  );
  console.log(`  manifiesto        ${rutaCopiable(directorio)}`);
  console.log(
    `  estado inicial    ${
      plan.tipo === "corpus_spike1"
        ? `rama + corpus del Spike 1 + ${String(plan.previas.length)} ejecución(es) previa(s): reconstruible`
        : `rama actual: NO reconstruible (${plan.motivo})`
    }`,
  );
  const url = await destinoVerificado();
  const salidaDir = join(directorio, `reproduccion-${sello()}`);

  const datos = await conectar(url);
  const db = datos.ejecutor;
  try {
    const previos = await contarTablas(db);
    const maxPrevio = await maximoIdDeEventos(db);

    // La reconstrucción solo es EXACTA si la rama bajo el corpus sigue igual.
    let exacta = false;
    if (plan.tipo === "corpus_spike1") {
      seccion("0 · La rama bajo el corpus, frente a la del ensayo");
      const cambios = cambiosEnLaRama(plan.rama, await huellaDeLaRama(db));
      comprobar(
        "la rama está como cuando se hizo el ensayo",
        cambios === null,
        cambios ?? "",
      );
      exacta = cambios === null;
      if (!exacta) {
        console.log(
          "  ⚠️  La rama ha cambiado (el cron de deltas la mueve a diario): el estado de\n" +
            "     partida ya no es el del ensayo y la comparación se degrada a idempotencia.\n" +
            "     Para una reproducción exacta: nuevo --ensayo y reprodúcelo antes del cron.",
        );
      }
    }

    await db.ejecutar("BEGIN");
    try {
      // ── 1 · El estado de partida ──────────────────────────────────────────
      if (plan.tipo === "corpus_spike1") {
        seccion("1 · Estado de partida: el mismo corpus que el ensayo");
        const corpus = leerCorpusSpike1(RAIZ_SPIKE, {
          excluir: (f) => plan.excluir.test(f),
        });
        await ejecutarSeed(db, construirFilas(corpus.titulos));
        const base = await contarTablas(db);
        console.log(
          `    ${String(base.external_titles)} títulos · ${String(base.external_availability)} ofertas`,
        );
        for (const [i, previa] of plan.previas.entries()) {
          seccion(`1.${String(i + 1)} · Ejecución previa: ${rutaCopiable(previa)}`);
          const r = await repetir(
            d,
            db,
            previa,
            join(salidaDir, `previa-${String(i + 1)}`),
          );
          // Si una previa no se repite igual, el estado de partida ya no es el
          // mismo y nada de lo que venga después puede compararse.
          informarComparacion(d.comparar(r.original, r.repetido, exacta), "previa: ");
        }
      } else {
        seccion("1 · Estado de partida: la rama tal cual está");
        console.log(
          "  ⚖️  Diferencia deliberada: la ejecución original ya confirmó su trabajo y la\n" +
            "     rama ha seguido cambiando. Se exige lo que sale del crudo; el resumen y el\n" +
            "     horizonte se enseñan como información. La reproducción prueba que\n" +
            "     reprocesar lo pagado no escribe nada nuevo, no que se repita la medición.",
        );
      }

      // ── 2 · La ejecución, comparada con la original ───────────────────────
      seccion("2 · La ejecución, desde ese estado");
      const ausenciasAntes = await opcionesConAusencias(db);
      const a = await repetir(d, db, directorio, join(salidaDir, "pasada-1"));
      seccion(
        `2 · Comparación con la original (${exacta ? "exacta" : "de idempotencia"})`,
      );
      informarComparacion(d.comparar(a.original, a.repetido, exacta), "");
      const tras1 = await contarTablas(db);
      const maxTras1 = await maximoIdDeEventos(db);

      // ── 3 · Idempotencia ──────────────────────────────────────────────────
      seccion("3 · La misma ejecución otra vez: tiene que ser un no-op");
      const b = await repetir(d, db, directorio, join(salidaDir, "pasada-2"));
      comprobar(
        "0 eventos calculados",
        Object.keys(b.salida.informe?.eventos ?? { x: 1 }).length === 0 ||
          b.salida.informe === null,
        JSON.stringify(b.salida.informe?.eventos ?? null),
      );
      comprobar("ningún evento nuevo", (await maximoIdDeEventos(db)) === maxTras1);
      const dif = diferenciaDeRecuentos(tras1, await contarTablas(db));
      comprobar(
        "0 inserciones en todas las tablas",
        Object.keys(dif).length === 0,
        JSON.stringify(dif),
      );
      comprobar(
        "misma medición del horizonte que la primera repetición",
        mismoValorJson(b.salida.horizonte, a.salida.horizonte),
        JSON.stringify(b.salida.horizonte),
      );
      comprobar(
        "ninguna ausencia interpretada en las dos pasadas",
        (await opcionesConAusencias(db)) === ausenciasAntes,
        `${String(ausenciasAntes)} antes`,
      );
    } finally {
      await db.ejecutar("ROLLBACK");
    }
    const dif = diferenciaDeRecuentos(previos, await contarTablas(db));
    comprobar(
      "rastro cero tras el ROLLBACK",
      Object.keys(dif).length === 0 && (await maximoIdDeEventos(db)) === maxPrevio,
      JSON.stringify(dif),
    );
    console.log(`\n  Manifiestos de la reproducción: ${rutaCopiable(salidaDir)}`);
  } finally {
    await datos.cliente.end().catch(() => undefined);
  }
}

// ── --real ──────────────────────────────────────────────────────────────────

/** Los pipelines que escriben el catálogo y se excluyen con el lock de catálogo. */
const ESCRITORES_DE_CATALOGO: readonly NombreDePipeline[] = [
  "deltas",
  "expiring",
  "upcoming",
];

export interface ComprobacionesDeLaReal<R extends ResultadoDeHorizonte, P = undefined> {
  /** Lo que hay que mirar de la base **antes** de la ejecución. */
  preparar?(db: EjecutorSql): Promise<P>;
  /**
   * Lo propio del pipeline tras la ejecución. `cuerpos`: el crudo de las
   * páginas **confirmadas**, leído del manifiesto.
   */
  despues(
    db: EjecutorSql,
    salida: R,
    cuerpos: readonly CuerpoDeCambios[],
    ahora: Date,
    previo: P | undefined,
  ): Promise<void>;
}

/** El crudo de las páginas confirmadas de una ejecución, desde su manifiesto. */
function cuerposConfirmados(directorio: string, pipeline: NombreDePipeline) {
  const m = leerManifiesto(directorio, pipeline);
  return m.respuestas
    .filter((r) => r.status >= 200 && r.status < 300)
    .slice(0, m.paginas.length)
    .map(
      (r) =>
        JSON.parse(
          readFileSync(join(directorio, r.fichero), "utf8"),
        ) as CuerpoDeCambios,
    );
}

/**
 * ⚠️ **GASTA CUOTA.** Hasta `d.tope` requests. Exige autorización explícita
 * cada vez; este script no la presupone.
 */
export async function real<R extends ResultadoDeHorizonte, P = undefined>(
  d: DescriptorDeHorizonte<R>,
  propias: ComprobacionesDeLaReal<R, P>,
): Promise<void> {
  // Antes que nada: ni credencial, ni conexión, ni request con un tope que
  // supere el oficial.
  const tope = exigirTopeOficial(d.pipeline, d.tope);
  console.log(
    `EJECUCIÓN REAL DE ${d.pipeline} — GASTA CUOTA · máximo ${String(tope)} requests\n`,
  );

  const apiKey = process.env.STREAMING_AVAILABILITY_API_KEY?.trim();
  if (apiKey === undefined || apiKey === "") {
    throw new Error(
      "Falta STREAMING_AVAILABILITY_API_KEY en la sesión. Sin credencial no se llama a nadie.",
    );
  }
  const base = process.env.STREAMING_API_BASE_URL?.trim();
  const url = await destinoVerificado();
  const presupuesto = presupuestoInyectado(d.pipeline, tope);

  const ahora = new Date();
  const ops = await conectar(url);
  const datos = await conectar(url);
  try {
    seccion("Antes");
    const ciclo = calcularCiclo(ahora, presupuesto.diaDeCiclo);
    const libroAntes = await leerLibroDelCiclo(ops.ejecutor, ciclo, d.pipeline);
    const otros = ESCRITORES_DE_CATALOGO.filter((p) => p !== d.pipeline);
    const vivasDeOtros: string[] = [];
    for (const p of otros) {
      const libro = await leerLibroDelCiclo(ops.ejecutor, ciclo, p);
      if (libro.vivasDelPipeline > 0) vivasDeOtros.push(p);
    }
    console.log(
      `  libro del ciclo   total ${String(libroAntes.total)} · ${d.pipeline} ${String(libroAntes.delPipeline)}` +
        ` · vivas ${String(libroAntes.vivasDelPipeline)} · otros escritores vivos ${vivasDeOtros.join(", ") || "ninguno"}`,
    );
    const previos = await contarTablas(datos.ejecutor);
    tabla(previos);
    const maxPrevio = await maximoIdDeEventos(datos.ejecutor);
    const ausenciasAntes = await opcionesConAusencias(datos.ejecutor);

    const plan = d.planificar(ahora);
    const v = ventanaDesdeSegundos(plan.ventana);
    console.log(
      `  ventana           ${v.desde.toISOString()} → ${v.hasta.toISOString()}`,
    );

    const abortos: string[] = [];
    if (libroAntes.vivasDelPipeline > 0)
      abortos.push(`hay una ejecución de ${d.pipeline} en \`running\``);
    // Todos escriben el mismo catálogo: no se solapan con el cron de deltas.
    for (const p of vivasDeOtros)
      abortos.push(`hay una ejecución de ${p} en \`running\``);
    if (
      libroAntes.delPipeline + d.tope >
      presupuesto.techoMensualPorPipeline[d.pipeline]
    ) {
      abortos.push(
        `el tope no cabe en lo que queda del techo mensual de ${d.pipeline}`,
      );
    }
    if (libroAntes.total + d.tope > presupuesto.umbralGlobal) {
      abortos.push("el tope no cabe en lo que queda del umbral global");
    }
    if (abortos.length > 0) {
      for (const a of abortos) console.log(`  ❌ ${a}`);
      throw new Error("Precondiciones no cumplidas. No se ha pedido nada.");
    }

    const directorio = join(d.directorioDeEjecuciones, `${sello()}-real`);
    console.log(`  manifiesto        ${rutaCopiable(directorio)}`);
    const previo = await propias.preparar?.(datos.ejecutor);

    seccion("Ejecución");
    const salida = await d.ejecutar({
      ejecutorOps: ops.ejecutor,
      ejecutorDatos: datos.ejecutor,
      transaccion: transaccionPorPagina(datos.ejecutor),
      presupuesto,
      crearLlamada: crearTransporte,
      apiKey,
      ...(base === undefined || base === "" ? {} : { base }),
      plan: { origen: "persistente" },
      regimen: REGIMEN_DE_LOS_SCRIPTS,
      ahora,
      crearRegistro: (cabecera) =>
        crearRegistroLocal(directorio, {
          modo: "real",
          pipeline: d.pipeline,
          // No reconstruible: su --reproducir será de idempotencia.
          estadoInicial: { tipo: "rama" },
          ...cabecera,
        }),
      vincularEventos: true,
    });
    informarEjecucion(d.pipeline, salida);
    d.informar(salida);

    seccion("Después");
    if (!salida.resultado.ejecutado) return;
    const runId = salida.resultado.runId;
    const fila = (
      await ops.ejecutor.ejecutar<{
        status: string;
        requests_made: number;
        budget_limit: number;
        finished_at: Date | null;
        checkpoint: unknown;
      }>(
        "SELECT status, requests_made, budget_limit, finished_at, checkpoint FROM ops_sync_runs WHERE id = $1",
        [runId],
      )
    )[0];
    console.log(
      `  ops_sync_runs     id ${String(runId)} · ${JSON.stringify(fila ?? null)}`,
    );
    comprobar("la fila está cerrada", fila?.finished_at !== null && fila !== undefined);
    comprobar(
      "budget_limit = umbral operativo",
      fila?.budget_limit === presupuesto.umbralGlobal,
    );
    let legible = "";
    try {
      d.leerCheckpoint(fila?.checkpoint, runId);
    } catch (error) {
      legible = error instanceof Error ? error.message : String(error);
    }
    comprobar(
      "el checkpoint de la fila se lee con el formato v1",
      legible === "",
      legible,
    );
    // Por VALOR: `jsonb` reordena las claves (fila 44). Ver `mismoValorJson`.
    comprobar(
      "el checkpoint de la fila es el último punto confirmado",
      mismoValorJson(fila?.checkpoint ?? null, salida.checkpoint),
      `fila ${JSON.stringify(fila?.checkpoint ?? null)} · job ${JSON.stringify(salida.checkpoint)}`,
    );
    const libroDespues = await leerLibroDelCiclo(ops.ejecutor, ciclo, d.pipeline);
    for (const c of verificarCuadre({
      requestsMade: fila?.requests_made ?? -1,
      reservasConcedidas: salida.contadores.reservasConcedidas,
      deltaDelLibro: libroDespues.total - libroAntes.total,
      respuestas: salida.contadores.respuestas,
      cuota: salida.cuotaDelProveedor,
    })) {
      comprobar(c.nombre, c.ok, c.detalle);
    }
    comprobar(
      `${d.pipeline} dentro del tope de la medición`,
      salida.contadores.reservasConcedidas <= d.tope,
      `${String(salida.contadores.reservasConcedidas)} / ${String(d.tope)}`,
    );

    const aud = await auditarEventos(datos.ejecutor, maxPrevio);
    console.log(`  eventos           ${JSON.stringify(aud.porTipo)}`);
    comprobar(
      `ninguna baja: ${d.pipeline} no interpreta ausencias`,
      (aud.porTipo.removed ?? 0) === 0,
      String(aud.porTipo.removed ?? 0),
    );
    comprobar("ningún evento con before == after", aud.sinCambio === 0);
    comprobar(
      "ninguna ausencia interpretada: mismas opciones con missing_streak > 0",
      (await opcionesConAusencias(datos.ejecutor)) === ausenciasAntes,
    );
    comprobar(
      "0 opciones duplicadas",
      (await contarOpcionesDuplicadas(datos.ejecutor)) === 0,
    );
    await propias.despues(
      datos.ejecutor,
      salida,
      cuerposConfirmados(directorio, d.pipeline),
      ahora,
      previo,
    );
    tabla(diferenciaDeRecuentos(previos, await contarTablas(datos.ejecutor)));

    seccion("La medición");
    if (salida.horizonte?.completo === true) {
      console.log(
        `  📏 El horizonte de ${String(HORIZONTE_MAXIMO_DIAS)} días cabe en ` +
          `${String(salida.contadores.reservasConcedidas)} requests.`,
      );
    } else {
      console.log(
        `  ⚠️  hasMore=true al llegar a ${String(d.tope)} requests: el recorrido quedó INCOMPLETO.\n` +
          "     La cifra es un SUELO, no el total. El tope NO se amplía automáticamente:\n" +
          "     ampliarlo exige una decisión nueva.",
      );
      if (salida.checkpoint?.ultimoTimestampConfirmado !== null) {
        console.log(
          `     Última fecha confirmada: ${salida.checkpoint?.ultimoTimestampConfirmado ?? "?"}`,
        );
      }
    }
    console.log(
      `\n  Reproducir sin cuota:  pnpm api:run:${d.pipeline} --reproducir ${rutaCopiable(directorio)}`,
    );
  } finally {
    await ops.cliente.end().catch(() => undefined);
    await datos.cliente.end().catch(() => undefined);
  }
}

// ── Principal ───────────────────────────────────────────────────────────────

/** `--ensayo`, `--reproducir <dir>` o `--real`. Sin flag no hace nada. */
export async function despachar(
  pipeline: NombreDePipeline,
  tope: number,
  acciones: {
    readonly ensayo: () => Promise<void>;
    readonly reproducir: (dir: string) => Promise<void>;
    readonly real: () => Promise<void>;
  },
): Promise<void> {
  const args = process.argv.slice(2);
  const valorDe = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  const uso = (): never => {
    console.error(
      [
        "Uso:",
        `  pnpm api:run:${pipeline} --ensayo               cero API · Neon · ROLLBACK`,
        `  pnpm api:run:${pipeline} --reproducir <dir>     cero API · Neon · ROLLBACK`,
        `  pnpm api:run:${pipeline} --real                 GASTA CUOTA (máx. ${String(tope)})`,
      ].join("\n"),
    );
    process.exit(1);
  };

  if (args.includes("--ensayo")) await acciones.ensayo();
  else if (args.includes("--reproducir")) {
    const dir = valorDe("--reproducir");
    if (dir === undefined) uso();
    else await acciones.reproducir(dir);
  } else if (args.includes("--real")) await acciones.real();
  else uso();
}
