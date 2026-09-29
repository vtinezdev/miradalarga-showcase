/**
 * **Ejecución MANUAL del pipeline `updated`** contra `drizzle-schema-v1-test`.
 * Nunca contra `production`: las mismas guardas que la migración la hacen
 * inalcanzable.
 *
 *   pnpm api:run:updated --ensayo               CERO API · Neon · todo en ROLLBACK
 *   pnpm api:run:updated --reproducir <dir>     CERO API · Neon · todo en ROLLBACK
 *   pnpm api:run:updated --real --tope <n>      GASTA CUOTA · hasta n requests
 *
 * **Sin flag no hace nada.** Gastar cuota exige escribirlo dos veces: `--real`
 * y el tope.
 *
 * ⚖️ **`updated` no tiene presupuesto aprobado** (2026-09-25): tope 0 en el
 * repositorio, sin `pnpm job`, sin workflow y sin cron. Primero se mide el
 * coste. Por eso `--real` no lleva tope propio: lo escribe quien la lanza
 * (`exigirTopeDeMedicion`), nunca por encima del techo mensual, y cada
 * ejecución exige autorización explícita.
 *
 * ── Lo que mide ─────────────────────────────────────────────────────────────
 *
 * Lo del job de `/changes` de siempre y, además, **qué hizo cada aviso**
 * (`jobs/pipelines/updated/clasificacion.ts`): por plataforma, por tipo de
 * oferta, por campo, cuánto es precio, cuánto es Apple, cuánto no cambia nada.
 * Va al manifiesto, que está en `.updated-runs/`, fuera de git.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { EjecutorSql } from "../jobs/ops/contratos.ts";
import { ArranqueDenegado } from "../jobs/ops/contratos.ts";
import { leerUltimoCheckpoint } from "../jobs/ops/checkpoint.ts";
import { crearLibroEnMemoria } from "../jobs/ops/libro-en-memoria.ts";
import type { LibroEnMemoria } from "../jobs/ops/libro-en-memoria.ts";
import { calcularCiclo } from "../jobs/ops/presupuesto.ts";
import type { FuenteDeCuota, Transporte } from "../jobs/ops/transporte.ts";
import { crearTransporte } from "../jobs/ops/transporte.ts";
import {
  auditarEventos,
  contarOpcionesDuplicadas,
  contarTablas,
  diferenciaDeRecuentos,
  leerLibroDelCiclo,
  maximoIdDeEventos,
  verificarCuadre,
} from "../jobs/pipelines/deltas/auditoria.ts";
import { bucketDelDia } from "../jobs/pipelines/deltas/digest.ts";
import {
  transaccionConSavepoint,
  transaccionPorPagina,
} from "../jobs/pipelines/deltas/job.ts";
import type {
  EstadoInicial,
  Manifiesto,
  RegistroLocal,
} from "../jobs/pipelines/deltas/manifiesto.ts";
import {
  crearRegistroLocal,
  leerManifiesto,
  ventanaDesdeSegundos,
} from "../jobs/pipelines/deltas/manifiesto.ts";
import { CATALOGOS_MVP } from "../jobs/pipelines/deltas/origen.ts";
import {
  cambiosEnLaRama,
  compararConOriginal,
  planDeReconstruccion,
} from "../jobs/pipelines/horizonte/reproduccion.ts";
import { construirFilas } from "../jobs/pipelines/seed/filas.ts";
import { ejecutarSeed } from "../jobs/pipelines/seed/index.ts";
import { leerCorpusSpike1 } from "../jobs/pipelines/seed/origen.ts";
import {
  CHECKPOINTS_DE_UPDATED,
  PIPELINE_UPDATED,
  TIPOS_DE_UPDATED,
  tipoDeUpdated,
} from "../jobs/pipelines/updated/checkpoint.ts";
import type { InformeDeUpdated } from "../jobs/pipelines/updated/clasificacion.ts";
import type {
  PlanDeUpdated,
  ResultadoDelJobDeUpdated,
} from "../jobs/pipelines/updated/job.ts";
import { ejecutarJobDeUpdated } from "../jobs/pipelines/updated/job.ts";
import { CAMPOS_PROPIOS_DE_UPDATED } from "../jobs/pipelines/updated/reproduccion.ts";
import {
  RAIZ,
  RAIZ_SPIKE,
  RESPUESTAS_DE_CHANGES,
  grabadasDe,
  huellaDeLaRama,
  informarComparacion,
  opcionesConAusencias,
} from "./horizonte-manual.ts";
import type { Grabada } from "./manual-comun.ts";
import {
  cerrarComprobaciones,
  claveGrabada,
  comprobar,
  conectar,
  describirMedicionDeVentana,
  destinoVerificado,
  exigirTopeDeMedicion,
  fallar,
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

const PIPELINE = PIPELINE_UPDATED;
const DIRECTORIO_DE_EJECUCIONES = join(RAIZ, ".updated-runs");

/**
 * 📏 `raw/055` y `raw/056`: las dos páginas de `updated` de una ventana real
 * de 24 h, la segunda pedida con el cursor de la primera. Capturadas en la
 * misma sesión que el corpus del Spike 1, **después** que él: el corpus es la
 * línea base y estas, los avisos.
 */
const FIXTURE_P1 = "055-H-daily-updated-p1.json";
const FIXTURE_P2 = "056-H-daily-updated-p2.json";

/** Los pipelines que escriben el catálogo: no se solapan con una real. */
const ESCRITORES_DE_CATALOGO = ["deltas", "expiring", "upcoming", "updated"] as const;

interface FicheroDelSpike {
  readonly meta: {
    readonly ventana: { readonly from_epoch: number; readonly to_epoch: number };
    readonly catalogs: readonly string[];
  };
  readonly body: {
    readonly changes: readonly unknown[];
    readonly hasMore: boolean;
    readonly nextCursor?: string;
  };
}

function leerFixture(nombre: string): FicheroDelSpike {
  return JSON.parse(
    readFileSync(join(RAIZ_SPIKE, "raw", nombre), "utf8"),
  ) as FicheroDelSpike;
}

const estadoDe = (s: ResultadoDelJobDeUpdated): string =>
  s.resultado.ejecutado ? s.resultado.estado : "no_ejecutado";

// ── Informe de la clasificación ─────────────────────────────────────────────

function informarClasificacion(c: InformeDeUpdated | null): void {
  if (c === null) {
    console.log("  clasificación     — (la ejecución no terminó: no hay informe)");
    return;
  }
  console.log(`  avisos updated    ${String(c.avisos)}`);
  console.log(`  por plataforma    ${JSON.stringify(c.porPlataforma)}`);
  console.log(`  por tipo          ${JSON.stringify(c.porTipoDeOferta)}`);
  console.log("  por resultado");
  tabla(Object.fromEntries(Object.entries(c.porResultado).filter(([, n]) => n > 0)));
  console.log("  por grupo (plataforma/tipo)");
  for (const [grupo, g] of Object.entries(c.porGrupo)) {
    console.log(
      `    ${grupo.padEnd(28)} ${String(g.avisos).padStart(4)} · ${JSON.stringify(g.resultados)}` +
        (g.preciosCambiados > 0 ? ` · precios ${String(g.preciosCambiados)}` : ""),
    );
  }
  console.log(`  campos de opción  ${JSON.stringify(c.camposCambiados)}`);
  console.log(
    `  precios           ${String(c.precios.cambios)} cambios · suben ${String(c.precios.suben)} · ` +
      `bajan ${String(c.precios.bajan)} · aparecen ${String(c.precios.aparecen)} · ` +
      `desaparecen ${String(c.precios.desaparecen)} · moneda ${String(c.precios.cambiosDeMoneda)}`,
  );
  console.log(
    `  eventos (avisos)  ${JSON.stringify(c.eventos.deAvisos)} · campos ${JSON.stringify(c.eventos.camposDeAvisos)}`,
  );
  console.log(
    `  eventos (resto)   ${JSON.stringify(c.eventos.deAcompanantes)} · campos ${JSON.stringify(c.eventos.camposDeAcompanantes)}`,
  );
  console.log(
    `  sin verse         ${String(c.opcionesQueSobrevivenSinVerse)} opciones siguen activas sin que el snapshot las liste`,
  );
  console.log(
    `  fuera de catálogo ${String(c.titulosFueraDeCatalogo)} títulos no escritos`,
  );
}

/** Cuenta los `DELETE` sobre opciones que pasan por un ejecutor. */
function contandoBorrados(db: EjecutorSql): {
  ejecutor: EjecutorSql;
  borrados: () => number;
} {
  let borrados = 0;
  return {
    ejecutor: {
      ejecutar<T>(texto: string, valores?: readonly unknown[]) {
        if (texto.trim().startsWith("DELETE FROM external_availability_options"))
          borrados++;
        return db.ejecutar<T>(texto, valores);
      },
    },
    borrados: () => borrados,
  };
}

// ── --ensayo ────────────────────────────────────────────────────────────────

async function ensayo(): Promise<void> {
  console.log(
    "ENSAYO DE updated CONTRA NEON — CERO API · TODO DENTRO DE UN ROLLBACK\n",
  );
  const url = await destinoVerificado();
  // Exactamente las 2 páginas grabadas.
  const presupuesto = presupuestoInyectado(PIPELINE, 2);

  const p1 = leerFixture(FIXTURE_P1);
  const p2 = leerFixture(FIXTURE_P2);
  const cursor = p1.body.nextCursor;
  if (cursor === undefined) throw new Error(`${FIXTURE_P1} no trae nextCursor.`);
  const ventanaMedida = p1.meta.ventana;
  // El `ahora` del ensayo es el final de la ventana medida.
  const ahora = new Date(ventanaMedida.to_epoch * 1000);
  const ventana = ventanaDesdeSegundos({
    from: ventanaMedida.from_epoch,
    to: ventanaMedida.to_epoch,
  });
  const avisosDelCrudo = p1.body.changes.length + p2.body.changes.length;

  // ⚠️ Cabeceras SINTÉTICAS: el Spike 1 no las grabó para 055/056. Sirven para
  // ejercitar la guardia externa; no son evidencia del proveedor.
  let usadaSintetica = 0;
  const cabecerasSinteticas = (): Record<string, string> => ({
    "x-quota-used": String(++usadaSintetica),
    "x-quota-granted": "1000",
    "x-quota-reset": "2026-10-01T00:00:00Z",
  });
  const validarUrl = (u: URL): void => {
    // La query tiene que ser EXACTAMENTE la medida en probe-daily.mjs.
    const q = u.searchParams;
    const esperadas = [
      "catalogs",
      "change_type",
      "country",
      "from",
      "item_type",
      "output_language",
      "to",
    ];
    const recibidas = [...q.keys()].filter((k) => k !== "cursor").sort();
    if (JSON.stringify(recibidas) !== JSON.stringify(esperadas)) {
      throw new Error(`Query distinta de la medida: ${recibidas.join(",")}`);
    }
    if (q.get("change_type") !== "updated") {
      throw new Error(`change_type distinto: ${q.get("change_type") ?? "?"}`);
    }
    if (
      Number(q.get("from")) !== ventanaMedida.from_epoch ||
      Number(q.get("to")) !== ventanaMedida.to_epoch
    ) {
      throw new Error(
        `Ventana distinta de la medida: ${q.get("from") ?? "?"}–${q.get("to") ?? "?"}`,
      );
    }
    if (
      q.get("catalogs") !== p1.meta.catalogs.join(",") ||
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
        claveGrabada("updated", null),
        { cuerpo: JSON.stringify(p1.body), cabeceras: cabecerasSinteticas() },
      ],
      [
        claveGrabada("updated", cursor),
        { cuerpo: JSON.stringify(p2.body), cabeceras: cabecerasSinteticas() },
      ],
    ]);
    return llamadaDesdeDisco(grabadas, validarUrl);
  };

  const directorio = join(DIRECTORIO_DE_EJECUCIONES, `${sello()}-ensayo`);
  console.log(`  manifiestos       ${rutaCopiable(directorio)}`);
  console.log(
    `  ventana           ${ventana.desde.toISOString()} → ${ventana.hasta.toISOString()}`,
  );
  console.log("  ⚠️  cabeceras x-quota SINTÉTICAS: 055/056 no las grabaron");

  const datos = await conectar(url);
  const db = datos.ejecutor;

  try {
    seccion("0 · Foto previa (fuera de la transacción)");
    const previos = await contarTablas(db);
    tabla(previos);
    const maxPrevio = await maximoIdDeEventos(db);
    const huella = await huellaDeLaRama(db);

    await db.ejecutar("BEGIN");
    try {
      seccion("1 · Línea base: catálogo del Spike 1, SIN las respuestas de /changes");
      const corpus = leerCorpusSpike1(RAIZ_SPIKE, {
        excluir: (f) => RESPUESTAS_DE_CHANGES.test(f),
      });
      await ejecutarSeed(db, construirFilas(corpus.titulos));
      const base = await contarTablas(db);
      console.log(
        `    ${String(base.external_titles)} títulos · ${String(base.external_availability)} ofertas`,
      );
      await db.ejecutar("SAVEPOINT ensayo_base");
      const estadoInicial: EstadoInicial = {
        tipo: "corpus_spike1",
        excluir: RESPUESTAS_DE_CHANGES.source,
        previas: [],
        rama: huella,
      };

      const correr = async (
        subdirectorio: string,
        extra: {
          datos?: EjecutorSql;
          libro?: LibroEnMemoria;
          persistente?: boolean;
          estadoInicial?: EstadoInicial;
        } = {},
      ) => {
        const ejecutorDatos = extra.datos ?? db;
        const libro = extra.libro ?? crearLibroEnMemoria();
        const plan: PlanDeUpdated =
          extra.persistente === true
            ? { origen: "persistente", sinCheckpoint: "prohibido" }
            : { origen: "fijo", ventana };
        const salida = await ejecutarJobDeUpdated({
          regimen: REGIMEN_DE_LOS_SCRIPTS,
          ejecutorOps: libro.ejecutor,
          ejecutorDatos,
          transaccion: transaccionConSavepoint(ejecutorDatos),
          presupuesto,
          crearLlamada: servir(),
          apiKey: "ensayo-sin-clave",
          plan,
          ahora,
          crearRegistro: (cabecera) =>
            crearRegistroLocal(join(directorio, subdirectorio), {
              modo: "ensayo",
              pipeline: PIPELINE,
              ...(extra.estadoInicial === undefined
                ? {}
                : { estadoInicial: extra.estadoInicial }),
              ...cabecera,
            }),
          vincularEventos: false,
        });
        informarEjecucion(PIPELINE, salida);
        return salida;
      };

      // ── Pasada 1 ──────────────────────────────────────────────────────────
      seccion("2 · Pasada 1: las dos páginas de updated sobre la línea base");
      const ausenciasAntes = await opcionesConAusencias(db);
      const conBorrados = contandoBorrados(db);
      const p1Salida = await correr("pasada-1", {
        datos: conBorrados.ejecutor,
        estadoInicial,
      });
      informarClasificacion(p1Salida.clasificacion);
      comprobar("pasada 1 cierra succeeded", estadoDe(p1Salida) === "succeeded");
      comprobar(
        "2 reservas: las dos páginas, la segunda con el cursor de la primera",
        p1Salida.contadores.reservasConcedidas === 2,
        String(p1Salida.contadores.reservasConcedidas),
      );
      const aud1 = await auditarEventos(db, maxPrevio);
      const escritos1 = Object.values(aud1.porTipo).reduce((n, x) => n + x, 0);
      console.log(`    eventos en la base: ${JSON.stringify(aud1.porTipo)}`);
      comprobar(
        "eventos en la base == eventos escritos por el pipeline",
        escritos1 === (p1Salida.informe?.eventosEscritos ?? -1),
        `${String(escritos1)} frente a ${String(p1Salida.informe?.eventosEscritos ?? "?")}`,
      );
      comprobar("ningún evento con before == after", aud1.sinCambio === 0);
      comprobar(
        "ninguna alta ni baja: updated solo cambia lo que existe",
        (aud1.porTipo.added ?? 0) === 0 && (aud1.porTipo.removed ?? 0) === 0,
        JSON.stringify(aud1.porTipo),
      );
      comprobar(
        "todos en el bucket del día (Madrid)",
        aud1.buckets.every((b) => b === bucketDelDia(ahora).toISOString()),
        aud1.buckets.join(", ") || "sin eventos",
      );
      comprobar(
        "ninguna ausencia interpretada: mismas opciones con missing_streak > 0",
        (await opcionesConAusencias(db)) === ausenciasAntes,
      );
      comprobar(
        "ningún borrado de opciones",
        conBorrados.borrados() === 0,
        String(conBorrados.borrados()),
      );
      const tras1 = await contarTablas(db);
      comprobar(
        "ningún título nuevo: solo se tocan los que ya estaban",
        tras1.external_titles === base.external_titles,
        `${String(base.external_titles)} → ${String(tras1.external_titles)}`,
      );
      comprobar("0 opciones duplicadas", (await contarOpcionesDuplicadas(db)) === 0);
      comprobar(
        "la clasificación cubre todos los avisos del crudo",
        p1Salida.clasificacion?.avisos === avisosDelCrudo,
        `${String(p1Salida.clasificacion?.avisos ?? "?")} de ${String(avisosDelCrudo)}`,
      );

      // ── Pasada 2: idempotencia ────────────────────────────────────────────
      seccion("3 · Pasada 2: mismos avisos, mismo `ahora`");
      const maxTras1 = await maximoIdDeEventos(db);
      const p2Salida = await correr("pasada-2");
      comprobar(
        "0 eventos calculados",
        Object.keys(p2Salida.informe?.eventos ?? { x: 1 }).length === 0,
        JSON.stringify(p2Salida.informe?.eventos ?? null),
      );
      comprobar(
        "ningún evento nuevo en la base",
        (await maximoIdDeEventos(db)) === maxTras1,
      );
      const dif2 = diferenciaDeRecuentos(tras1, await contarTablas(db));
      comprobar(
        "0 inserciones en todas las tablas",
        Object.keys(dif2).length === 0,
        JSON.stringify(dif2),
      );
      const r1 = p1Salida.clasificacion?.porResultado;
      const comparados1 =
        (r1?.evento ?? 0) +
        (r1?.cambio_sin_efecto_en_agregado ?? 0) +
        (r1?.solo_metadatos ?? 0) +
        (r1?.no_op ?? 0) +
        (r1?.linea_base ?? 0) +
        (r1?.misma_observacion ?? 0);
      comprobar(
        "todo lo que la pasada 1 escribió es ahora la misma observación",
        p2Salida.clasificacion?.porResultado.misma_observacion === comparados1,
        `${String(p2Salida.clasificacion?.porResultado.misma_observacion ?? "?")} frente a ${String(comparados1)}`,
      );

      // ── Fallo y reanudación ───────────────────────────────────────────────
      seccion("4 · Fallo inyectado al empezar la página 2, y reanudación");
      await db.ejecutar("ROLLBACK TO SAVEPOINT ensayo_base");
      let paginaActual = 0;
      let recuentosAlEmpezarPagina2: Record<string, number> | null = null;
      let fallado = false;
      const conFallo: EjecutorSql = {
        async ejecutar<T>(texto: string, valores?: readonly unknown[]) {
          // La primera sentencia de cada página: qué títulos existen.
          if (texto.trim().startsWith("SELECT imdb_id FROM external_titles")) {
            paginaActual++;
            if (paginaActual === 2 && !fallado) {
              recuentosAlEmpezarPagina2 = await contarTablas(db);
              fallado = true;
              throw new Error("fallo inyectado: página 2");
            }
          }
          return db.ejecutar<T>(texto, valores);
        },
      };
      const libroCompartido = crearLibroEnMemoria();
      const pf = await correr("fallo", { datos: conFallo, libro: libroCompartido });
      comprobar("el fallo se produjo de verdad en la página 2", fallado);
      comprobar("la ejecución cierra failed", estadoDe(pf) === "failed", estadoDe(pf));
      const difF = diferenciaDeRecuentos(
        recuentosAlEmpezarPagina2 ?? {},
        await contarTablas(db),
      );
      comprobar(
        "la página 2 se revirtió entera",
        recuentosAlEmpezarPagina2 !== null && Object.keys(difF).length === 0,
        JSON.stringify(difF),
      );
      comprobar(
        "el checkpoint apunta a la página 2 con su cursor",
        pf.checkpoint?.pendiente?.changeType === "updated" &&
          pf.checkpoint.pendiente.cursorDeEntrada === cursor,
        JSON.stringify(pf.checkpoint?.pendiente ?? null),
      );
      const pr = await correr("reanudacion", {
        libro: libroCompartido,
        persistente: true,
      });
      comprobar(
        "la reanudación cierra succeeded",
        estadoDe(pr) === "succeeded",
        estadoDe(pr),
      );
      comprobar(
        "reanuda la misma ventana, desde la ejecución que falló",
        mismoValorJson(pr.checkpoint?.ventana, pf.checkpoint?.ventana) &&
          pr.checkpoint?.reanudaDe === libroCompartido.filas[0]?.id,
        `${JSON.stringify(pr.checkpoint?.ventana)} · reanudaDe ${String(pr.checkpoint?.reanudaDe)}`,
      );
      comprobar(
        "con 1 sola request: la de la página que faltaba",
        pr.contadores.reservasConcedidas === 1,
        String(pr.contadores.reservasConcedidas),
      );
      const difR = diferenciaDeRecuentos(tras1, await contarTablas(db));
      comprobar(
        "fallo + reanudación == pasada limpia: mismo estado final",
        Object.keys(difR).length === 0,
        JSON.stringify(difR),
      );
      const audR = await auditarEventos(db, maxPrevio);
      comprobar(
        "ni eventos perdidos ni duplicados",
        mismoValorJson(audR.porTipo, aud1.porTipo),
        `${JSON.stringify(audR.porTipo)} frente a ${JSON.stringify(aud1.porTipo)}`,
      );
    } finally {
      await db.ejecutar("ROLLBACK");
    }

    seccion("5 · Rastro cero");
    const difFinal = diferenciaDeRecuentos(previos, await contarTablas(db));
    comprobar(
      "los recuentos vuelven a la foto previa",
      Object.keys(difFinal).length === 0,
      JSON.stringify(difFinal),
    );
    comprobar("ningún evento sobrevive", (await maximoIdDeEventos(db)) === maxPrevio);
    console.log(
      `\n  Reproducir:  pnpm api:run:updated --reproducir ${rutaCopiable(join(directorio, "pasada-1"))}`,
    );
  } finally {
    await datos.cliente.end().catch(() => undefined);
  }
}

// ── --reproducir ────────────────────────────────────────────────────────────

/**
 * Repite UNA ejecución grabada —su crudo, su ventana, su `ahora`, su tope— y
 * devuelve el manifiesto que deja la repetición, para compararlo.
 */
async function repetir(
  db: EjecutorSql,
  origen: string,
  destino: string,
): Promise<{
  original: Manifiesto;
  repetido: Manifiesto;
  salida: ResultadoDelJobDeUpdated;
}> {
  const original = leerManifiesto(origen, PIPELINE);
  let registro: RegistroLocal | null = null;
  const reanudaDe = original.reanudaDe;
  const salida = await ejecutarJobDeUpdated({
    regimen: REGIMEN_DE_LOS_SCRIPTS,
    ejecutorOps: crearLibroEnMemoria().ejecutor,
    ejecutorDatos: db,
    transaccion: transaccionConSavepoint(db),
    // Lo que la original gastó: pide las mismas páginas y, si aquella se
    // cortó, esta se corta en el mismo punto.
    presupuesto: presupuestoInyectado(
      PIPELINE,
      Math.max(1, original.requests.reservadas),
    ),
    crearLlamada: llamadaDesdeDisco(grabadasDe(origen, original)),
    apiKey: "reproduccion-sin-clave",
    // La ventana GRABADA, no la de hoy: se reproduce lo que se pagó.
    plan: {
      origen: "fijo",
      ventana: ventanaDesdeSegundos(original.ventana),
      ...(reanudaDe === null
        ? {}
        : {
            reanudarEn: {
              tipo: tipoDeUpdated.parse(reanudaDe.changeType),
              cursor: reanudaDe.cursorDeEntrada,
            },
          }),
    },
    ahora: new Date(original.ahora),
    crearRegistro: (cabecera) => {
      registro = crearRegistroLocal(destino, {
        modo: "reproduccion",
        pipeline: PIPELINE,
        ...cabecera,
        reanudaDe,
      });
      return registro;
    },
    vincularEventos: false,
  });
  informarEjecucion(PIPELINE, salida);
  informarClasificacion(salida.clasificacion);
  const repetido = (registro as RegistroLocal | null)?.manifiesto();
  if (repetido === undefined) {
    throw new Error(`La repetición de ${origen} no llegó a crear su manifiesto.`);
  }
  return { original, repetido, salida };
}

/**
 * Reproduce una ejecución **desde su mismo estado lógico de partida**, todo
 * dentro de un `ROLLBACK`: exacta si partió del corpus y la rama sigue igual;
 * de idempotencia si fue una ejecución real. Ver `horizonte/reproduccion.ts`.
 */
async function reproducir(argumento: string): Promise<void> {
  console.log(
    "REPRODUCCIÓN DE UNA EJECUCIÓN DE updated — CERO API · TODO DENTRO DE UN ROLLBACK\n",
  );
  const directorio = resolve(RAIZ, argumento);
  const plan = planDeReconstruccion(
    PIPELINE,
    directorio,
    (dir) => leerManifiesto(dir, PIPELINE),
    (base, relativa) => resolve(base, relativa),
  );
  console.log(`  manifiesto        ${rutaCopiable(directorio)}`);
  console.log(
    `  estado inicial    ${
      plan.tipo === "corpus_spike1"
        ? "rama + corpus del Spike 1: reconstruible"
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
          "  ⚠️  La rama ha cambiado (el cron de deltas la mueve a diario): la comparación\n" +
            "     se degrada a idempotencia. Para una exacta: nuevo --ensayo y reprodúcelo antes.",
        );
      }
    }

    await db.ejecutar("BEGIN");
    try {
      if (plan.tipo === "corpus_spike1") {
        seccion("1 · Estado de partida: el mismo corpus que el ensayo");
        const corpus = leerCorpusSpike1(RAIZ_SPIKE, {
          excluir: (f) => plan.excluir.test(f),
        });
        await ejecutarSeed(db, construirFilas(corpus.titulos));
        for (const [i, previa] of plan.previas.entries()) {
          seccion(`1.${String(i + 1)} · Ejecución previa: ${rutaCopiable(previa)}`);
          const r = await repetir(
            db,
            previa,
            join(salidaDir, `previa-${String(i + 1)}`),
          );
          informarComparacion(
            compararConOriginal(
              r.original,
              r.repetido,
              exacta,
              CAMPOS_PROPIOS_DE_UPDATED,
            ),
            "previa: ",
          );
        }
      } else {
        seccion("1 · Estado de partida: la rama tal cual está");
        console.log(
          "  ⚖️  La ejecución original ya confirmó su trabajo: se exige lo que sale del crudo;\n" +
            "     la clasificación completa se enseña como información.",
        );
      }

      seccion("2 · La ejecución, desde ese estado");
      const ausenciasAntes = await opcionesConAusencias(db);
      const a = await repetir(db, directorio, join(salidaDir, "pasada-1"));
      seccion(
        `2 · Comparación con la original (${exacta ? "exacta" : "de idempotencia"})`,
      );
      informarComparacion(
        compararConOriginal(a.original, a.repetido, exacta, CAMPOS_PROPIOS_DE_UPDATED),
        "",
      );
      const tras1 = await contarTablas(db);
      const maxTras1 = await maximoIdDeEventos(db);

      seccion("3 · La misma ejecución otra vez: tiene que ser un no-op");
      const b = await repetir(db, directorio, join(salidaDir, "pasada-2"));
      comprobar(
        "0 eventos calculados",
        b.salida.informe === null || Object.keys(b.salida.informe.eventos).length === 0,
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
        "ninguna ausencia interpretada en las dos pasadas",
        (await opcionesConAusencias(db)) === ausenciasAntes,
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

/**
 * ⚠️ **GASTA CUOTA.** Hasta `--tope` requests. Exige autorización explícita
 * cada vez; este script no la presupone.
 */
async function real(argumentoDelTope: string | undefined): Promise<void> {
  // Antes que nada: ni credencial, ni conexión, ni request sin un tope válido.
  const tope = exigirTopeDeMedicion(PIPELINE, argumentoDelTope);
  console.log(
    `EJECUCIÓN REAL DE updated — GASTA CUOTA · máximo ${String(tope)} requests (tope de medición, no aprobado)\n`,
  );

  const apiKey = process.env.STREAMING_AVAILABILITY_API_KEY?.trim();
  if (apiKey === undefined || apiKey === "") {
    throw new Error(
      "Falta STREAMING_AVAILABILITY_API_KEY en la sesión. Sin credencial no se llama a nadie.",
    );
  }
  const base = process.env.STREAMING_API_BASE_URL?.trim();
  const url = await destinoVerificado();
  const presupuesto = presupuestoInyectado(PIPELINE, tope);

  const ahora = new Date();
  const ops = await conectar(url);
  const datos = await conectar(url);
  try {
    seccion("Antes");
    const ciclo = calcularCiclo(ahora, presupuesto.diaDeCiclo);
    const libroAntes = await leerLibroDelCiclo(ops.ejecutor, ciclo, PIPELINE);
    const vivasDeOtros: string[] = [];
    for (const p of ESCRITORES_DE_CATALOGO) {
      if (p === PIPELINE) continue;
      const libro = await leerLibroDelCiclo(ops.ejecutor, ciclo, p);
      if (libro.vivasDelPipeline > 0) vivasDeOtros.push(p);
    }
    console.log(
      `  libro del ciclo   total ${String(libroAntes.total)} · ${PIPELINE} ${String(libroAntes.delPipeline)}` +
        ` · vivas ${String(libroAntes.vivasDelPipeline)} · otros escritores vivos ${vivasDeOtros.join(", ") || "ninguno"}`,
    );
    const previos = await contarTablas(datos.ejecutor);
    tabla(previos);
    const maxPrevio = await maximoIdDeEventos(datos.ejecutor);
    const ausenciasAntes = await opcionesConAusencias(datos.ejecutor);

    // Vista previa, de solo lectura, de lo que decidirá el job con el lock
    // tomado. Aborta ANTES de pedir nada si el plan es imposible.
    let vistaPrevia;
    try {
      vistaPrevia = CHECKPOINTS_DE_UPDATED.planificarDesde({
        ultimo: await leerUltimoCheckpoint(ops.ejecutor, PIPELINE),
        ahora,
        sinCheckpoint: "ventana_de_validacion",
        tipos: TIPOS_DE_UPDATED,
      });
    } catch (error) {
      if (error instanceof ArranqueDenegado) {
        throw new Error(`${error.message}\nNo se ha pedido nada.`);
      }
      throw error;
    }
    const v = ventanaDesdeSegundos(vistaPrevia.ventana);
    console.log(
      `  plan              ${vistaPrevia.reanudaDe === null ? "ventana nueva" : `reanuda la ejecución ${String(vistaPrevia.reanudaDe)}`}`,
    );
    console.log(
      `  ventana           ${v.desde.toISOString()} → ${v.hasta.toISOString()}`,
    );
    console.log(`  pendiente         ${JSON.stringify(vistaPrevia.pendiente)}`);

    const abortos: string[] = [];
    if (libroAntes.vivasDelPipeline > 0)
      abortos.push("hay una ejecución de updated en `running`");
    for (const p of vivasDeOtros)
      abortos.push(`hay una ejecución de ${p} en \`running\``);
    if (libroAntes.delPipeline + tope > presupuesto.techoMensualPorPipeline[PIPELINE]) {
      abortos.push("el tope no cabe en lo que queda del techo mensual de updated");
    }
    if (libroAntes.total + tope > presupuesto.umbralGlobal) {
      abortos.push("el tope no cabe en lo que queda del umbral global");
    }
    if (abortos.length > 0) {
      for (const a of abortos) console.log(`  ❌ ${a}`);
      throw new Error("Precondiciones no cumplidas. No se ha pedido nada.");
    }

    const directorio = join(DIRECTORIO_DE_EJECUCIONES, `${sello()}-real`);
    console.log(`  manifiesto        ${rutaCopiable(directorio)}`);

    seccion("Ejecución");
    const salida = await ejecutarJobDeUpdated({
      regimen: REGIMEN_DE_LOS_SCRIPTS,
      ejecutorOps: ops.ejecutor,
      ejecutorDatos: datos.ejecutor,
      transaccion: transaccionPorPagina(datos.ejecutor),
      presupuesto,
      crearLlamada: crearTransporte,
      apiKey,
      ...(base === undefined || base === "" ? {} : { base }),
      // La ventana la decide ops_sync_runs.checkpoint, con el lock tomado. Sin
      // checkpoint previo, la de validación: las guardas ya confirmaron que el
      // destino es drizzle-schema-v1-test.
      plan: { origen: "persistente", sinCheckpoint: "ventana_de_validacion" },
      ahora,
      crearRegistro: (cabecera) =>
        crearRegistroLocal(directorio, {
          modo: cabecera.reanudaDe === null ? "real" : "reanudacion",
          pipeline: PIPELINE,
          // No reconstruible: su --reproducir será de idempotencia.
          estadoInicial: { tipo: "rama" },
          ...cabecera,
        }),
      vincularEventos: true,
    });
    informarEjecucion(PIPELINE, salida);
    informarClasificacion(salida.clasificacion);

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
    // Por VALOR: `jsonb` reordena las claves (fila 44).
    comprobar(
      "el checkpoint de la fila es el último punto confirmado",
      mismoValorJson(fila?.checkpoint ?? null, salida.checkpoint),
      JSON.stringify(fila?.checkpoint ?? null),
    );
    const libroDespues = await leerLibroDelCiclo(ops.ejecutor, ciclo, PIPELINE);
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
      "updated dentro del tope de la medición",
      salida.contadores.reservasConcedidas <= tope,
      `${String(salida.contadores.reservasConcedidas)} / ${String(tope)}`,
    );

    const aud = await auditarEventos(datos.ejecutor, maxPrevio);
    console.log(`  eventos           ${JSON.stringify(aud.porTipo)}`);
    comprobar(
      "ninguna alta ni baja: updated solo cambia lo que existe",
      (aud.porTipo.added ?? 0) === 0 && (aud.porTipo.removed ?? 0) === 0,
      JSON.stringify(aud.porTipo),
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
    tabla(diferenciaDeRecuentos(previos, await contarTablas(datos.ejecutor)));

    seccion("La medición");
    for (const linea of describirMedicionDeVentana({
      desde: v.desde,
      hasta: v.hasta,
      // El del checkpoint que usó el job, no el de la vista previa.
      reanudaDe: salida.checkpoint?.reanudaDe ?? null,
      completa: salida.reanudacion === null && estadoDe(salida) === "succeeded",
      requests: salida.contadores.reservasConcedidas,
    })) {
      console.log(`  ${linea}`);
    }
    console.log(
      `\n  Reproducir sin cuota:  pnpm api:run:updated --reproducir ${rutaCopiable(directorio)}`,
    );
  } finally {
    await ops.cliente.end().catch(() => undefined);
    await datos.cliente.end().catch(() => undefined);
  }
}

// ── Principal ───────────────────────────────────────────────────────────────

function uso(): never {
  console.error(
    [
      "Uso:",
      "  pnpm api:run:updated --ensayo               cero API · Neon · ROLLBACK",
      "  pnpm api:run:updated --reproducir <dir>     cero API · Neon · ROLLBACK",
      "  pnpm api:run:updated --real --tope <n>      GASTA CUOTA (máx. n) · reanuda desde la base",
    ].join("\n"),
  );
  process.exit(1);
}

async function principal(): Promise<void> {
  const args = process.argv.slice(2);
  const valorDe = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };

  if (args.includes("--ensayo")) await ensayo();
  else if (args.includes("--reproducir")) {
    const dir = valorDe("--reproducir");
    if (dir === undefined) uso();
    await reproducir(dir);
  } else if (args.includes("--real")) await real(valorDe("--tope"));
  else uso();

  cerrarComprobaciones();
}

principal().catch(fallar);
