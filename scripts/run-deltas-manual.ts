/**
 * **Ejecución MANUAL del pipeline `deltas` (`removed` + `new`)** contra
 * `drizzle-schema-v1-test`. Nunca contra `production`: las mismas guardas que
 * la migración la hacen inalcanzable.
 *
 *   pnpm api:run:deltas --ensayo               CERO API · Neon · todo en ROLLBACK
 *   pnpm api:run:deltas --reproducir <dir>     CERO API · Neon · todo en ROLLBACK
 *   pnpm api:run:deltas --real                 GASTA CUOTA · hasta 4 requests
 *
 * **Sin flag no hace nada.** Gastar cuota exige escribirlo: `--real`.
 *
 * ⚖️ **`--real` decide su ventana con `ops_sync_runs.checkpoint`** (ADR 0006):
 * reanuda la lista pendiente con su ventana y su cursor exactos, o sigue con la
 * ventana contigua. `--reanudar <dir>` ya no existe: el manifiesto local es
 * auditoría y reproducción, y la base es la única fuente para reanudar.
 *
 * ── Los cerrojos ────────────────────────────────────────────────────────────
 *
 *   · **Tope inyectado: 4** (`TOPE_APROBADO_PRIMERA_EJECUCION`). Vive aquí, en
 *     el diff, y **no** en `TOPE_POR_EJECUCION_POR_DEFECTO`, que sigue a 0:
 *     ningún `pnpm job` ni workflow puede heredarlo.
 *   · **Dos guardias de cuota:** el libro interno (`ops_sync_runs`,
 *     `reservar()`) y las cabeceras del proveedor (`x-quota-*`), que cierran la
 *     ejecución al 90 % de lo que el proveedor dice haber concedido.
 *   · **Sin checkpoint previo, ventana de validación.** `[ahora − 24 h, ahora]`
 *     solo se permite porque las guardas confirman que el destino es
 *     `drizzle-schema-v1-test`. `production` necesitará el ancla del seed.
 *   · **El crudo y el manifiesto** van a `.deltas-runs/`, fuera de git.
 *
 * ── Lo que este script NO hace ──────────────────────────────────────────────
 *
 * No registra el job en `jobs/run.ts`, no crea workflow ni cron y no toca las
 * migraciones.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { EjecutorSql } from "../jobs/ops/contratos.ts";
import { leerUltimoCheckpoint } from "../jobs/ops/checkpoint.ts";
import { ArranqueDenegado } from "../jobs/ops/contratos.ts";
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
import type { TipoDeDeltas } from "../jobs/pipelines/deltas/checkpoint.ts";
import { planificarDesde, tipoDeDeltas } from "../jobs/pipelines/deltas/checkpoint.ts";
import { bucketDelDia } from "../jobs/pipelines/deltas/digest.ts";
import {
  PIPELINE,
  TIPOS_DE_DELTAS,
  ejecutarJobDeDeltas,
  transaccionConSavepoint,
  transaccionPorPagina,
} from "../jobs/pipelines/deltas/job.ts";
import {
  crearRegistroLocal,
  leerManifiesto,
  ventanaDesdeSegundos,
} from "../jobs/pipelines/deltas/manifiesto.ts";
import { CATALOGOS_MVP, ventanaHaciaAtras } from "../jobs/pipelines/deltas/origen.ts";
import { claveDeOferta, construirFilas } from "../jobs/pipelines/seed/filas.ts";
import { ejecutarSeed } from "../jobs/pipelines/seed/index.ts";
import { leerCorpusSpike1 } from "../jobs/pipelines/seed/origen.ts";
import { plataformaDesdeFuente } from "../jobs/pipelines/seed/plataformas.ts";
import type { Grabada } from "./manual-comun.ts";
import {
  cerrarComprobaciones,
  claveGrabada,
  comprobar,
  conectar,
  destinoVerificado,
  fallar,
  informarEjecucion,
  llamadaDesdeDisco,
  mismoValorJson,
  presupuestoInyectado,
  rutaCopiable,
  seccion,
  sello,
  tabla,
} from "./manual-comun.ts";

/**
 * ⚖️ **El tope aprobado para la primera ejecución manual.** 📏 Día normal: 2
 * requests (`new` 8 + `removed` 3 en 24 h, `spike-1/daily.json`). 📏 Pico: ≥ 22 y
 * ≥ 21 avisos en medio día (`raw/018`, `raw/020`), probablemente 2 páginas por
 * tipo → 4. Cumple `tope ≤ techo mensual (60)`.
 */
const TOPE_APROBADO_PRIMERA_EJECUCION = 4;

const RAIZ = join(import.meta.dirname, "..");
const DIRECTORIO_DE_EJECUCIONES = join(RAIZ, ".deltas-runs");
const RAIZ_SPIKE = join(RAIZ, "spike-1");

/** Las claves de oferta que nombran los avisos de un tipo, en un cuerpo crudo. */
function clavesNombradas(cuerpo: string, tipo: TipoDeDeltas): Set<string> {
  const r = JSON.parse(cuerpo) as {
    changes: {
      changeType: string;
      showId: string;
      service: { id: string };
      streamingOptionType: string;
      addon?: { id: string };
    }[];
    shows: Record<string, { imdbId: string }>;
  };
  const claves = new Set<string>();
  for (const c of r.changes) {
    if (c.changeType !== tipo) continue;
    const plataforma = plataformaDesdeFuente(c.service.id);
    const imdb = r.shows[c.showId]?.imdbId;
    if (plataforma === null || imdb === undefined) continue;
    claves.add(
      claveDeOferta(imdb, plataforma, c.streamingOptionType, c.addon?.id ?? null),
    );
  }
  return claves;
}

// ── --ensayo ────────────────────────────────────────────────────────────────

/**
 * 📏 `raw/053` y `raw/054`: `new` y `removed` en una ventana real de 24 h,
 * capturadas **en la misma sesión que el corpus del Spike 1**. Son un par
 * antes/después coherente: el corpus es la línea base y estas, los avisos.
 */
const FIXTURE_REMOVED = "054-H-daily-removed-p1.json";
/** Las respuestas de `/changes` del Spike 1: `C-changes-*` (017–024) y `H-daily-*` (053–056). */
const RESPUESTAS_DE_CHANGES = /^\d{3}-(C-changes|H-daily)-/;
const FIXTURE_NEW = "053-H-daily-new-p1.json";

interface FicheroDelSpike {
  readonly meta: {
    readonly ventana: { readonly from_epoch: number; readonly to_epoch: number };
    readonly catalogs: readonly string[];
  };
  readonly body: unknown;
}

function leerFixture(nombre: string): FicheroDelSpike {
  return JSON.parse(
    readFileSync(join(RAIZ_SPIKE, "raw", nombre), "utf8"),
  ) as FicheroDelSpike;
}

async function ensayo(): Promise<void> {
  console.log("ENSAYO DE deltas CONTRA NEON — CERO API · TODO DENTRO DE UN ROLLBACK\n");
  const url = await destinoVerificado();
  const presupuesto = presupuestoInyectado(PIPELINE, TOPE_APROBADO_PRIMERA_EJECUCION);

  const removed = leerFixture(FIXTURE_REMOVED);
  const nuevo = leerFixture(FIXTURE_NEW);
  const ventanaMedida = nuevo.meta.ventana;
  // El `ahora` del ensayo es el final de la ventana medida: así la ventana que
  // construye el pipeline tiene que coincidir AL SEGUNDO con la que se envió.
  const ahora = new Date(ventanaMedida.to_epoch * 1000);
  const ventana = ventanaHaciaAtras(ahora);

  // ⚠️ Cabeceras SINTÉTICAS: el Spike 1 no las grabó para 053/054. Sirven para
  // ejercitar la guardia externa; no son evidencia del proveedor.
  let usadaSintetica = 0;
  const grabadas = new Map<string, Grabada>();
  const cabecerasSinteticas = (): Record<string, string> => ({
    "x-quota-used": String(++usadaSintetica),
    "x-quota-granted": "1000",
    "x-quota-reset": "2026-10-01T00:00:00Z",
  });
  const cuerpoRemoved = JSON.stringify(removed.body);
  const cuerpoNew = JSON.stringify(nuevo.body);

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
    if (
      Number(q.get("from")) !== ventanaMedida.from_epoch ||
      Number(q.get("to")) !== ventanaMedida.to_epoch
    ) {
      throw new Error(
        `Ventana distinta de la medida: ${q.get("from") ?? "?"}–${q.get("to") ?? "?"} ` +
          `frente a ${String(ventanaMedida.from_epoch)}–${String(ventanaMedida.to_epoch)}`,
      );
    }
    if (
      q.get("catalogs") !== nuevo.meta.catalogs.join(",") ||
      q.get("catalogs") !== CATALOGOS_MVP
    ) {
      throw new Error(
        `Catálogos distintos de los medidos: ${q.get("catalogs") ?? "?"}`,
      );
    }
  };

  const servir = (): ((fuente: FuenteDeCuota) => Transporte) => {
    grabadas.clear();
    grabadas.set(claveGrabada("removed", null), {
      cuerpo: cuerpoRemoved,
      cabeceras: cabecerasSinteticas(),
    });
    grabadas.set(claveGrabada("new", null), {
      cuerpo: cuerpoNew,
      cabeceras: cabecerasSinteticas(),
    });
    return llamadaDesdeDisco(grabadas, validarUrl);
  };

  const directorio = join(DIRECTORIO_DE_EJECUCIONES, `${sello()}-ensayo`);
  console.log(`  manifiestos       ${rutaCopiable(directorio)}`);
  console.log(
    `  ventana           ${ventana.desde.toISOString()} → ${ventana.hasta.toISOString()}`,
  );
  console.log("  ⚠️  cabeceras x-quota SINTÉTICAS: 053/054 no las grabaron");

  const datos = await conectar(url);
  const db = datos.ejecutor;

  try {
    seccion("0 · Foto previa (fuera de la transacción)");
    const previos = await contarTablas(db);
    tabla(previos);
    const maxPrevio = await maximoIdDeEventos(db);

    await db.ejecutar("BEGIN");
    try {
      seccion("1 · Línea base: catálogo del Spike 1, SIN las respuestas de /changes");
      // 📏 Con el corpus entero, la base ya contendría el snapshot de los
      // propios avisos —053 y los `updated` 055/056, capturados DESPUÉS— y el
      // ensayo no tendría nada que comparar. La línea base es el catálogo
      // (búsquedas y top); los avisos son lo que se ensaya contra ella.
      const corpus = leerCorpusSpike1(RAIZ_SPIKE, {
        excluir: (f) => RESPUESTAS_DE_CHANGES.test(f),
      });
      await ejecutarSeed(db, construirFilas(corpus.titulos));
      const base = await contarTablas(db);
      console.log(
        `    ${String(base.external_titles)} títulos · ${String(base.external_availability)} ofertas`,
      );
      await db.ejecutar("SAVEPOINT ensayo_base");

      const correr = async (
        subdirectorio: string,
        extra: {
          datos?: EjecutorSql;
          /** El libro de ops: compartirlo es «otra ejecución que lee lo que dejó esta». */
          libro?: LibroEnMemoria;
          /** Por defecto, la ventana medida. `persistente`: la del checkpoint. */
          persistente?: boolean;
        } = {},
      ) => {
        const ejecutorDatos = extra.datos ?? db;
        const libro = extra.libro ?? crearLibroEnMemoria();
        const salida = await ejecutarJobDeDeltas({
          ejecutorOps: libro.ejecutor,
          ejecutorDatos,
          transaccion: transaccionConSavepoint(ejecutorDatos),
          presupuesto,
          crearLlamada: servir(),
          apiKey: "ensayo-sin-clave",
          plan:
            extra.persistente === true
              ? { origen: "persistente", sinCheckpoint: "prohibido" }
              : { origen: "fijo", ventana },
          ahora,
          crearRegistro: (cabecera) =>
            crearRegistroLocal(join(directorio, subdirectorio), {
              modo: "ensayo",
              ...cabecera,
            }),
          vincularEventos: false,
        });
        informarEjecucion(PIPELINE, salida);
        return { salida, libro };
      };

      // ── Pasada 1 ──────────────────────────────────────────────────────────
      seccion("2 · Pasada 1: removed + new sobre la línea base");
      const { salida: p1 } = await correr("pasada-1");
      const estado1 = p1.resultado.ejecutado ? p1.resultado.estado : "no_ejecutado";
      comprobar("pasada 1 cierra succeeded", estado1 === "succeeded", estado1);
      comprobar(
        "2 reservas: una página por tipo",
        p1.contadores.reservasConcedidas === 2,
        String(p1.contadores.reservasConcedidas),
      );
      const aud1 = await auditarEventos(db, maxPrevio);
      const escritos1 = Object.values(aud1.porTipo).reduce((n, x) => n + x, 0);
      console.log(`    eventos en la base: ${JSON.stringify(aud1.porTipo)}`);
      comprobar(
        "eventos en la base == eventos escritos por el pipeline",
        escritos1 === (p1.informe?.eventosEscritos ?? -1),
        `${String(escritos1)} frente a ${String(p1.informe?.eventosEscritos ?? "?")}`,
      );
      comprobar(
        "ningún evento con before == after",
        aud1.sinCambio === 0,
        String(aud1.sinCambio),
      );
      comprobar(
        "todos en el bucket del día (Madrid)",
        aud1.buckets.every((b) => b === bucketDelDia(ahora).toISOString()),
        aud1.buckets.join(", ") || "sin eventos",
      );

      const nombradasNew = clavesNombradas(cuerpoNew, "new");
      const nombradasRemoved = clavesNombradas(cuerpoRemoved, "removed");
      const clavesDe = (tipo: string) =>
        aud1.claves
          .filter((c) => c.tipo === tipo)
          .map((c) => claveDeOferta(c.imdbId, c.plataforma, c.tipoOferta, c.addon));
      const addedHuerfanos = clavesDe("added").filter((k) => !nombradasNew.has(k));
      const removedHuerfanos = clavesDe("removed").filter(
        (k) => !nombradasRemoved.has(k),
      );
      // Un `added` sin aviso solo es legítimo si la oferta EXISTÍA con 0
      // activas; tras un seed recién hecho no hay ninguna así.
      comprobar(
        "cada `added` corresponde a un aviso `new` que nombra esa oferta",
        addedHuerfanos.length === 0,
        addedHuerfanos.length === 0
          ? `${String(clavesDe("added").length)} altas`
          : addedHuerfanos.join(" · "),
      );
      comprobar(
        "cada `removed` corresponde a un aviso `removed` (una pasada no alcanza una racha de 2)",
        removedHuerfanos.length === 0,
        removedHuerfanos.length === 0
          ? `${String(clavesDe("removed").length)} bajas`
          : removedHuerfanos.join(" · "),
      );
      comprobar("0 opciones duplicadas", (await contarOpcionesDuplicadas(db)) === 0);
      const tras1 = await contarTablas(db);
      const porPagina1 = p1.informe?.eventos ?? {};

      // ── Pasada 2: idempotencia ────────────────────────────────────────────
      seccion("3 · Pasada 2: mismos avisos, mismo `ahora`");
      const maxTras1 = await maximoIdDeEventos(db);
      const { salida: p2 } = await correr("pasada-2");
      comprobar(
        "0 eventos calculados",
        Object.keys(p2.informe?.eventos ?? { x: 1 }).length === 0,
        JSON.stringify(p2.informe?.eventos ?? null),
      );
      comprobar("0 eventos escritos", (p2.informe?.eventosEscritos ?? -1) === 0);
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

      // ── Duplicación imposible por la base de datos ────────────────────────
      seccion("4 · El UNIQUE de eventos: reinsertar la pasada 1 a propósito");
      if (escritos1 === 0) {
        comprobar(
          "reinserción de eventos",
          false,
          "SIN DATOS: la pasada 1 no escribió eventos",
        );
      } else {
        const reinsertadas = await db.ejecutar<{ id: string }>(
          `INSERT INTO external_availability_events
             (availability_id, event_type, changed_fields, before, after,
              event_digest, dedupe_bucket_at, detected_at, sync_run_id)
           SELECT availability_id, event_type, changed_fields, before, after,
                  event_digest, dedupe_bucket_at, detected_at, sync_run_id
             FROM external_availability_events WHERE id > $1
           ON CONFLICT ON CONSTRAINT external_availability_events_key DO NOTHING
           RETURNING id`,
          [maxPrevio],
        );
        comprobar(
          "ON CONFLICT DO NOTHING: 0 filas reinsertadas",
          reinsertadas.length === 0,
          `${String(reinsertadas.length)} de ${String(escritos1)}`,
        );
      }

      // ── Fallo entre estado y evento, y reanudación ────────────────────────
      seccion("5 · Fallo inyectado en la página 2, tras escribir su estado");
      await db.ejecutar("ROLLBACK TO SAVEPOINT ensayo_base");

      let paginaActual = 0;
      let recuentosAlEmpezarPagina2: Record<string, number> | null = null;
      let fallado = false;
      const conFallo: EjecutorSql = {
        async ejecutar<T>(texto: string, valores?: readonly unknown[]) {
          if (texto.includes("FROM external_availability a")) {
            paginaActual++;
            // Dentro de la transacción: es exactamente el estado tras la pág. 1.
            if (paginaActual === 2) recuentosAlEmpezarPagina2 = await contarTablas(db);
          }
          const filas = await db.ejecutar<T>(texto, valores);
          if (
            !fallado &&
            paginaActual === 2 &&
            texto.trim().startsWith("INSERT INTO external_availability_options")
          ) {
            fallado = true;
            throw new Error("fallo inyectado: estado escrito, eventos todavía no");
          }
          return filas;
        },
      };
      const libroCompartido = crearLibroEnMemoria();
      const { salida: pf } = await correr("fallo", {
        datos: conFallo,
        libro: libroCompartido,
      });
      const estadoF = pf.resultado.ejecutado ? pf.resultado.estado : "no_ejecutado";
      comprobar("el fallo se produjo de verdad en la página 2", fallado);
      comprobar("la ejecución cierra failed", estadoF === "failed", estadoF);
      comprobar(
        "la cuota de las 2 requests sigue contada",
        pf.contadores.reservasConcedidas === 2,
        String(pf.contadores.reservasConcedidas),
      );
      const dif = diferenciaDeRecuentos(
        recuentosAlEmpezarPagina2 ?? {},
        await contarTablas(db),
      );
      comprobar(
        "la página 2 se revirtió ENTERA: estado igual al de tras la página 1",
        recuentosAlEmpezarPagina2 !== null && Object.keys(dif).length === 0,
        JSON.stringify(dif),
      );
      comprobar(
        "el punto de reanudación apunta a la página que falló",
        pf.reanudacion?.changeType === "new" && pf.reanudacion.cursorDeEntrada === null,
        JSON.stringify(pf.reanudacion),
      );

      comprobar(
        "el checkpoint del fallo es el mismo punto, confirmado en su fila",
        JSON.stringify(libroCompartido.filas[0]?.checkpoint ?? null) ===
          JSON.stringify(pf.checkpoint) &&
          pf.checkpoint?.pendiente?.changeType === "new",
        JSON.stringify(libroCompartido.filas[0]?.checkpoint ?? null),
      );

      seccion("6 · Reanudar desde ops_sync_runs.checkpoint, no desde el manifiesto");
      // «Persistente» y SIN ventana de validación: si no encontrara el
      // checkpoint del fallo, fallaría en vez de inventarse otra ventana.
      const { salida: pr } = await correr("reanudacion", {
        libro: libroCompartido,
        persistente: true,
      });
      comprobar(
        "reanuda LA MISMA ventana y el mismo cursor que dejó el fallo",
        JSON.stringify(pr.checkpoint?.ventana) ===
          JSON.stringify(pf.checkpoint?.ventana) &&
          pr.checkpoint?.reanudaDe === libroCompartido.filas[0]?.id,
        `${JSON.stringify(pr.checkpoint?.ventana)} · reanudaDe ${String(pr.checkpoint?.reanudaDe)}`,
      );
      const estadoR = pr.resultado.ejecutado ? pr.resultado.estado : "no_ejecutado";
      comprobar("la reanudación cierra succeeded", estadoR === "succeeded", estadoR);
      comprobar(
        "reanuda con 1 sola request: la de la página que faltaba",
        pr.contadores.reservasConcedidas === 1,
        String(pr.contadores.reservasConcedidas),
      );
      const audR = await auditarEventos(db, maxPrevio);
      comprobar(
        "fallo + reanudación == pasada limpia: ni eventos perdidos ni duplicados",
        JSON.stringify(audR.porTipo) === JSON.stringify(aud1.porTipo),
        `${JSON.stringify(audR.porTipo)} frente a ${JSON.stringify(aud1.porTipo)}`,
      );
      const difR = diferenciaDeRecuentos(tras1, await contarTablas(db));
      comprobar(
        "mismo estado final que la pasada limpia",
        Object.keys(difR).length === 0,
        JSON.stringify(difR),
      );
      comprobar(
        "la reanudación deja la ventana agotada: pendiente = null",
        pr.checkpoint !== null && pr.checkpoint.pendiente === null,
        JSON.stringify(pr.checkpoint?.pendiente ?? "sin checkpoint"),
      );
      console.log(
        `    (eventos de la pasada limpia por tipo: ${JSON.stringify(porPagina1)})`,
      );
    } finally {
      await db.ejecutar("ROLLBACK");
    }

    seccion("7 · Rastro cero");
    const posteriores = await contarTablas(db);
    const difFinal = diferenciaDeRecuentos(previos, posteriores);
    comprobar(
      "los 14 recuentos vuelven a la foto previa",
      Object.keys(difFinal).length === 0,
      JSON.stringify(difFinal),
    );
    comprobar("ningún evento sobrevive", (await maximoIdDeEventos(db)) === maxPrevio);
  } finally {
    await datos.cliente.end().catch(() => undefined);
  }
}

// ── --reproducir ────────────────────────────────────────────────────────────

async function reproducir(directorio: string): Promise<void> {
  console.log(
    "REPRODUCCIÓN DE UNA EJECUCIÓN DE deltas — CERO API · TODO DENTRO DE UN ROLLBACK\n",
  );
  const manifiesto = leerManifiesto(directorio);
  const url = await destinoVerificado();
  // El tope de la reproducción es lo que la original gastó: pide exactamente
  // las mismas páginas y, si aquella se cortó, esta se corta en el mismo punto.
  const presupuesto = presupuestoInyectado(
    PIPELINE,
    Math.max(1, manifiesto.requests.reservadas),
  );

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

  const ahora = new Date(manifiesto.ahora);
  const ventana = ventanaDesdeSegundos(manifiesto.ventana);
  const tipos: readonly TipoDeDeltas[] = tipoDeDeltas.array().parse(manifiesto.tipos);
  const datos = await conectar(url);
  const db = datos.ejecutor;
  try {
    const previos = await contarTablas(db);
    const maxPrevio = await maximoIdDeEventos(db);
    await db.ejecutar("BEGIN");
    try {
      const libro = crearLibroEnMemoria();
      const salida = await ejecutarJobDeDeltas({
        ejecutorOps: libro.ejecutor,
        ejecutorDatos: db,
        transaccion: transaccionConSavepoint(db),
        presupuesto,
        crearLlamada: llamadaDesdeDisco(grabadas),
        apiKey: "reproduccion-sin-clave",
        // La ventana GRABADA, no la de hoy: se reproduce lo que se pagó.
        plan: {
          origen: "fijo",
          ventana,
          ...(manifiesto.reanudaDe === null
            ? {}
            : {
                reanudarEn: {
                  tipo: tipoDeDeltas.parse(manifiesto.reanudaDe.changeType),
                  cursor: manifiesto.reanudaDe.cursorDeEntrada,
                },
              }),
        },
        tipos,
        ahora,
        crearRegistro: (cabecera) =>
          crearRegistroLocal(join(directorio, `reproduccion-${sello()}`), {
            modo: "reproduccion",
            ...cabecera,
            reanudaDe: manifiesto.reanudaDe,
          }),
        vincularEventos: false,
      });
      informarEjecucion(PIPELINE, salida);
      seccion("Idempotencia frente al estado ya escrito");
      comprobar(
        "0 eventos calculados",
        Object.keys(salida.informe?.eventos ?? { x: 1 }).length === 0,
        JSON.stringify(salida.informe?.eventos ?? null),
      );
      comprobar("ningún evento nuevo", (await maximoIdDeEventos(db)) === maxPrevio);
      const dif = diferenciaDeRecuentos(previos, await contarTablas(db));
      comprobar(
        "0 inserciones en todas las tablas",
        Object.keys(dif).length === 0,
        JSON.stringify(dif),
      );
    } finally {
      await db.ejecutar("ROLLBACK");
    }
    const dif = diferenciaDeRecuentos(previos, await contarTablas(db));
    comprobar(
      "rastro cero tras el ROLLBACK",
      Object.keys(dif).length === 0,
      JSON.stringify(dif),
    );
  } finally {
    await datos.cliente.end().catch(() => undefined);
  }
}

// ── --real ──────────────────────────────────────────────────────────────────

async function real(): Promise<void> {
  console.log(
    `EJECUCIÓN REAL DE deltas — GASTA CUOTA · ` +
      `máximo ${String(TOPE_APROBADO_PRIMERA_EJECUCION)} requests\n`,
  );

  const apiKey = process.env.STREAMING_AVAILABILITY_API_KEY?.trim();
  if (apiKey === undefined || apiKey === "") {
    throw new Error(
      "Falta STREAMING_AVAILABILITY_API_KEY en la sesión. Sin credencial no se llama a nadie.",
    );
  }
  const base = process.env.STREAMING_API_BASE_URL?.trim();
  const url = await destinoVerificado();
  const presupuesto = presupuestoInyectado(PIPELINE, TOPE_APROBADO_PRIMERA_EJECUCION);

  const ahora = new Date();
  const ops = await conectar(url);
  const datos = await conectar(url);
  try {
    seccion("Antes");
    const ciclo = calcularCiclo(ahora, presupuesto.diaDeCiclo);
    const libroAntes = await leerLibroDelCiclo(ops.ejecutor, ciclo, PIPELINE);
    console.log(
      `  libro del ciclo   total ${String(libroAntes.total)} · ${PIPELINE} ${String(libroAntes.delPipeline)}` +
        ` · vivas ${String(libroAntes.vivasDelPipeline)}`,
    );
    const previos = await contarTablas(datos.ejecutor);
    tabla(previos);
    const maxPrevio = await maximoIdDeEventos(datos.ejecutor);

    // Vista previa, de solo lectura, de lo que decidirá el job. La decisión
    // de verdad la toma el job con el lock tomado: esto solo la enseña y
    // aborta ANTES de conectar nada más si el plan es imposible.
    let vistaPrevia;
    try {
      vistaPrevia = planificarDesde({
        ultimo: await leerUltimoCheckpoint(ops.ejecutor, PIPELINE),
        ahora,
        sinCheckpoint: "ventana_de_validacion",
        tipos: TIPOS_DE_DELTAS,
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
      abortos.push("hay una ejecución de deltas en `running`");
    if (
      libroAntes.delPipeline + TOPE_APROBADO_PRIMERA_EJECUCION >
      presupuesto.techoMensualPorPipeline[PIPELINE]
    ) {
      abortos.push("el tope no cabe en lo que queda del techo mensual de deltas");
    }
    if (libroAntes.total + TOPE_APROBADO_PRIMERA_EJECUCION > presupuesto.umbralGlobal) {
      abortos.push("el tope no cabe en lo que queda del umbral global");
    }
    if (abortos.length > 0) {
      for (const a of abortos) console.log(`  ❌ ${a}`);
      throw new Error("Precondiciones no cumplidas. No se ha pedido nada.");
    }

    const directorio = join(DIRECTORIO_DE_EJECUCIONES, `${sello()}-real`);
    console.log(`  manifiesto        ${rutaCopiable(directorio)}`);

    seccion("Ejecución");
    const salida = await ejecutarJobDeDeltas({
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
          ...cabecera,
        }),
      vincularEventos: true,
    });
    informarEjecucion(PIPELINE, salida);

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
    // Por VALOR: `jsonb` reordena las claves. Con `JSON.stringify` esta
    // comprobación falla siempre contra una fila real (📏 fila 44, expiring).
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
      `${PIPELINE} dentro de su techo mensual`,
      libroDespues.delPipeline <= presupuesto.techoMensualPorPipeline[PIPELINE],
      `${String(libroDespues.delPipeline)} / ${String(presupuesto.techoMensualPorPipeline[PIPELINE])}`,
    );

    const aud = await auditarEventos(datos.ejecutor, maxPrevio);
    console.log(`  eventos           ${JSON.stringify(aud.porTipo)}`);
    comprobar("ningún evento con before == after", aud.sinCambio === 0);
    comprobar(
      "todos en el bucket del día (Madrid)",
      aud.buckets.every((b) => b === bucketDelDia(ahora).toISOString()),
      aud.buckets.join(", ") || "sin eventos",
    );
    comprobar(
      "0 opciones duplicadas",
      (await contarOpcionesDuplicadas(datos.ejecutor)) === 0,
    );
    tabla(diferenciaDeRecuentos(previos, await contarTablas(datos.ejecutor)));
    console.log(
      `\n  Reproducir sin cuota:  pnpm api:run:deltas --reproducir ${rutaCopiable(directorio)}`,
    );
    if (salida.reanudacion !== null) {
      console.log(
        "  Quedó una lista pendiente: la próxima `--real` la reanuda desde\n" +
          "  ops_sync_runs.checkpoint, con la misma ventana y el mismo cursor (GASTA).",
      );
    }
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
      "  pnpm api:run:deltas --ensayo               cero API · Neon · ROLLBACK",
      "  pnpm api:run:deltas --reproducir <dir>     cero API · Neon · ROLLBACK",
      "  pnpm api:run:deltas --real                 GASTA CUOTA (máx. 4) · reanuda desde la base",
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
    await reproducir(resolve(RAIZ, dir));
  } else if (args.includes("--real")) await real();
  else if (args.includes("--reanudar")) {
    throw new Error(
      "--reanudar ya no existe: la reanudación sale de ops_sync_runs.checkpoint " +
        "(ADR 0006). `--real` reanuda sola la lista pendiente, con su ventana y su " +
        "cursor. El manifiesto local sirve para --reproducir.",
    );
  } else uso();

  cerrarComprobaciones();
}

principal().catch(fallar);
