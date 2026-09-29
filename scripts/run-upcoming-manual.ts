/**
 * **Ejecución MANUAL del pipeline `upcoming`** contra `drizzle-schema-v1-test`.
 * Nunca contra `production`: las mismas guardas que la migración la hacen
 * inalcanzable.
 *
 *   pnpm api:run:upcoming --ensayo               CERO API · Neon · todo en ROLLBACK
 *   pnpm api:run:upcoming --reproducir <dir>     CERO API · Neon · todo en ROLLBACK
 *   pnpm api:run:upcoming --real                 GASTA CUOTA · hasta el tope oficial (8)
 *
 * **Sin flag no hace nada.** Gastar cuota exige escribirlo: `--real`, y una
 * autorización explícita cada vez.
 *
 * El ensayo, la reproducción y la real son los comunes a los recorridos del
 * horizonte (`horizonte-manual.ts`), los mismos que midieron `expiring`; aquí
 * solo vive lo propio de `upcoming`.
 *
 * ── Para qué existe (2026-09-24) ────────────────────────────────────────────
 *
 * Nació para **medir cuánto cuesta un horizonte completo de 31 días**. 📏 Ya
 * está medido: **3 requests** (`ops_sync_runs` fila 50, con un tope de
 * medición de 12 que ya no existe). Con esa cifra se fijó el presupuesto
 * operativo —tope 8, techo 40— y `upcoming` se registró en
 * `pnpm job upcoming` (2026-09-24), que es su camino desatendido.
 *
 *   · **Horizonte: 31 días**, el máximo de `/changes`.
 *   · **Tope: el oficial**, `TOPE_POR_EJECUCION_POR_DEFECTO.upcoming` (8), el
 *     mismo que `pnpm job upcoming`. Sin literal propio: `real` rechaza
 *     cualquier tope por encima del oficial (`exigirTopeOficial`).
 *   · **Si al llegar al tope sigue `hasMore=true`, se detiene y lo reporta.**
 *     No se amplía solo: el recorrido queda incompleto y la cifra es un suelo.
 *   · **Ninguna ausencia se interpreta.** Con el recorrido completo solo se
 *     **cuentan** los anuncios que ya no se listan.
 *   · **Cada anuncio es una fila de `external_availability_announcements`**
 *     (ADR 0007), con o sin link. Ni opciones sintéticas ni eventos.
 *
 * ── Lo que este script NO hace ──────────────────────────────────────────────
 *
 * No es el job programado (`jobs/pipelines/upcoming/programado.ts`), no crea
 * workflow ni cron, no toca las migraciones y no cambia ningún presupuesto
 * del repositorio.
 */
import { join } from "node:path";

import type { EjecutorSql } from "../jobs/ops/contratos.ts";
import { maximoIdDeEventos } from "../jobs/pipelines/deltas/auditoria.ts";
import { PAIS } from "../jobs/pipelines/deltas/contratos.ts";
import type { ResumenDeAnuncios } from "../jobs/pipelines/deltas/manifiesto.ts";
import { TOPE_POR_EJECUCION_POR_DEFECTO } from "../jobs/ops/presupuesto.ts";
import { plataformaDesdeFuente } from "../jobs/pipelines/seed/plataformas.ts";
import {
  PIPELINE_UPCOMING,
  leerCheckpointDeUpcoming,
  planificarUpcoming,
} from "../jobs/pipelines/upcoming/checkpoint.ts";
import type { ResultadoDelJobDeUpcoming } from "../jobs/pipelines/upcoming/job.ts";
import { ejecutarJobDeUpcoming } from "../jobs/pipelines/upcoming/job.ts";
import { lineasDeAnunciosGuardados } from "../jobs/pipelines/upcoming/programado.ts";
import {
  compararConOriginal,
  planDeReconstruccion,
} from "../jobs/pipelines/upcoming/reproduccion.ts";
import type { CuerpoDeCambios, DescriptorDeHorizonte } from "./horizonte-manual.ts";
import {
  RAIZ,
  despachar,
  ensayo,
  informarHorizonte,
  real,
  reproducir,
} from "./horizonte-manual.ts";
import {
  cerrarComprobaciones,
  comprobar,
  fallar,
  mismoValorJson,
} from "./manual-comun.ts";

/**
 * ⚖️ **El tope de la ejecución real: el oficial**, 8 (2026-09-24). 📏 Un
 * horizonte completo midió 3 (fila 50). La medición usó un tope inyectado de
 * 12; con `upcoming` ya en operación, ese override desaparece y el script
 * manual gasta como mucho lo mismo que `pnpm job upcoming`.
 */
const TOPE = TOPE_POR_EJECUCION_POR_DEFECTO.upcoming;

/** Lo que el resumen de anuncios dice, para la consola. */
function informarAnuncios(a: ResumenDeAnuncios | null): void {
  if (a === null) return;
  const lista = (r: Readonly<Record<string, number>>) =>
    Object.entries(r)
      .map(([k, n]) => `${k} ${String(n)}`)
      .join(" · ") || "—";
  console.log(
    `  anuncios          ${String(a.avisos)} en ${String(a.paginas)} páginas` +
      (a.completo ? "" : " · INCOMPLETO: las cifras son un suelo"),
  );
  console.log(`    por plataforma  ${lista(a.porPlataforma)}`);
  if (Object.keys(a.fueraDelMvp).length > 0) {
    console.log(`    fuera del MVP   ${lista(a.fueraDelMvp)}`);
  }
  console.log(
    `    sin link        ${String(a.sinEnlace.total)} · ${lista(a.sinEnlace.porPlataforma)}`,
  );
  for (const s of a.sinEnlace.muestra) {
    console.log(
      `                    · ${s.imdbId ?? `show ${s.idProveedor}`} ${s.plataforma} ${s.tipoOferta}` +
        `${s.addon === null ? "" : `/${s.addon}`} → ${s.instante}`,
    );
  }
  console.log(
    `    sin opciones en ES ${String(a.sinDisponibilidadEnEs)} · ya en el catálogo ` +
      `${String(a.yaEnElCatalogo)} · sin show ${String(a.sinShow)} · repetidos ${String(a.repetidos)}`,
  );
  console.log(
    `    fuera de la ventana: antes ${String(a.fueraDelHorizonte.antes)} · ` +
      `después ${String(a.fueraDelHorizonte.despues)}`,
  );
}

const UPCOMING: DescriptorDeHorizonte<ResultadoDelJobDeUpcoming> = {
  pipeline: PIPELINE_UPCOMING,
  tipo: "upcoming",
  tope: TOPE,
  directorioDeEjecuciones: join(RAIZ, ".upcoming-runs"),
  ejecutar: ejecutarJobDeUpcoming,
  planificar: (ahora) => planificarUpcoming(ahora),
  leerCheckpoint: leerCheckpointDeUpcoming,
  planDeReconstruccion,
  comparar: compararConOriginal,
  informar(salida) {
    informarHorizonte(salida);
    informarAnuncios(salida.anuncios);
    // Las mismas dos líneas que `pnpm job upcoming`: la primera suma.
    if (salida.anunciosGuardados !== null) {
      for (const linea of lineasDeAnunciosGuardados(
        salida.anunciosGuardados,
        salida.anuncios?.repetidos ?? null,
      )) {
        console.log(`  ${linea}`);
      }
    }
    if (salida.informe !== null) {
      console.log(
        `    sobre oferta ya disponible ${String(salida.informe.anunciosSobreOfertaDisponible)}` +
          " (guardados como anuncio; la disponibilidad no se toca)",
      );
    }
  },
};

// ── Auditoría específica de upcoming ────────────────────────────────────────
//
// ADR 0007: un anuncio es una fila de `external_availability_announcements`
// y **nunca** una opción. La auditoría lo comprueba contra la base real, con
// la regla re-derivada aquí a partir del crudo —no llamando al planificador
// del pipeline, que sería comprobarlo consigo mismo—.

/** Una fila de anuncios, tal y como está en la base. */
interface FilaDeAnuncio {
  readonly announced_for: Date | string;
  readonly first_announced_for: Date | string;
  readonly link: string | null;
  readonly first_seen_at: Date | string;
  readonly last_seen_at: Date | string;
  readonly last_seen_run_id: string | number | null;
}

/** La base antes de la pasada: anuncios, opciones por oferta y último evento. */
interface EstadoPrevio {
  readonly anuncios: ReadonlyMap<string, FilaDeAnuncio>;
  readonly opciones: ReadonlyMap<string, readonly string[]>;
  readonly ultimoEvento: number;
}

const etiquetaDe = (
  imdb: string,
  plataforma: string,
  tipo: string,
  addon: string | null,
) => `${imdb}|${plataforma}|${tipo}|${addon ?? ""}`;

const SQL_ANUNCIOS = `
  SELECT t.imdb_id, an.platform_id, an.offer_type, an.addon,
         an.announced_for, an.first_announced_for, an.link,
         an.first_seen_at, an.last_seen_at, an.last_seen_run_id
    FROM external_availability_announcements an
    JOIN external_titles t ON t.id = an.title_id
   WHERE an.country = $1`;

async function leerAnuncios(db: EjecutorSql): Promise<Map<string, FilaDeAnuncio>> {
  const filas = await db.ejecutar<
    FilaDeAnuncio & {
      imdb_id: string;
      platform_id: string;
      offer_type: string;
      addon: string | null;
    }
  >(SQL_ANUNCIOS, [PAIS]);
  return new Map(
    filas.map((f) => [etiquetaDe(f.imdb_id, f.platform_id, f.offer_type, f.addon), f]),
  );
}

/** Cada opción como `link|quality|available_since`, por oferta. */
const SQL_OPCIONES = `
  SELECT t.imdb_id, av.platform_id, av.offer_type, av.addon,
         o.link, o.quality, o.available_since
    FROM external_availability av
    JOIN external_titles t ON t.id = av.title_id
    JOIN external_availability_options o ON o.availability_id = av.id
   WHERE av.country = $1`;

async function leerOpciones(db: EjecutorSql): Promise<Map<string, string[]>> {
  const filas = await db.ejecutar<{
    imdb_id: string;
    platform_id: string;
    offer_type: string;
    addon: string | null;
    link: string;
    quality: string | null;
    available_since: Date | string | null;
  }>(SQL_OPCIONES, [PAIS]);
  const salida = new Map<string, string[]>();
  for (const f of filas) {
    const clave = etiquetaDe(f.imdb_id, f.platform_id, f.offer_type, f.addon);
    const lista = salida.get(clave) ?? [];
    lista.push(`${f.link}|${f.quality ?? ""}|${iso(f.available_since) ?? ""}`);
    salida.set(clave, lista);
  }
  return salida;
}

async function capturarEstadoPrevio(db: EjecutorSql): Promise<EstadoPrevio> {
  return {
    anuncios: await leerAnuncios(db),
    opciones: await leerOpciones(db),
    ultimoEvento: await maximoIdDeEventos(db),
  };
}

const iso = (d: Date | string | null) =>
  d === null ? null : new Date(d).toISOString();

/** Lo que el crudo dice de una oferta anunciada, en el orden del proveedor. */
interface Anunciada {
  readonly etiqueta: string;
  readonly avisos: readonly { readonly fecha: string; readonly link: string | null }[];
}

function anunciadas(cuerpos: readonly CuerpoDeCambios[]): readonly Anunciada[] {
  const porEtiqueta = new Map<string, { fecha: string; link: string | null }[]>();
  for (const cuerpo of cuerpos) {
    for (const a of cuerpo.changes) {
      const plataforma = plataformaDesdeFuente(a.service.id);
      const imdb = cuerpo.shows[a.showId]?.imdbId;
      if (plataforma === null || imdb === undefined) continue;
      const etiqueta = etiquetaDe(
        imdb,
        plataforma,
        a.streamingOptionType,
        a.addon?.id ?? null,
      );
      const lista = porEtiqueta.get(etiqueta) ?? [];
      lista.push({
        fecha: new Date(a.timestamp * 1000).toISOString(),
        link: a.link ?? null,
      });
      porEtiqueta.set(etiqueta, lista);
    }
  }
  return [...porEtiqueta].map(([etiqueta, avisos]) => ({ etiqueta, avisos }));
}

/**
 * Cada oferta anunciada, contra su fila de **antes** (ADR 0007):
 *
 *   · **sin fila** o **observación nueva** (`last_seen_at < ahora`) → la fila
 *     tiene la fecha del **primer** aviso, `last_seen_at = ahora` y el run
 *     esperado. El link: el del primer aviso; si llega `NULL` en el mismo
 *     ciclo, el conocido; en un ciclo nuevo, nunca el anterior. Un aviso
 *     posterior de la misma ejecución puede completar un `NULL`.
 *     `first_*` = esta observación si no había fila o la fecha anterior ya
 *     había vencido (ciclo nuevo); si no, los de antes.
 *   · **fuera de orden** o **misma observación** (`last_seen_at >= ahora`) →
 *     la fila queda **idéntica**.
 *   · Otro aviso de la misma oferta con otra fecha, u otro link no nulo, en
 *     esta ejecución es un **conflicto** y no se aplica: se cuentan aquí para
 *     cuadrarlos con el informe. Un `NULL` frente a un link no lo es.
 *
 * Y lo que un anuncio **no** hace: ninguna opción de la oferta cambia si el
 * snapshot no la lista, y ninguna opción nueva lleva la fecha de un anuncio
 * sin calidad —la huella de la antigua opción sintética—.
 */
async function verificarAnuncios(
  db: EjecutorSql,
  cuerpos: readonly CuerpoDeCambios[],
  previo: EstadoPrevio,
  ahora: Date,
  runEsperado: number | null,
): Promise<{
  porClase: Record<string, number>;
  fallos: string[];
  conflictos: number;
  sinLink: number;
  sinteticas: string[];
}> {
  const despues = await leerAnuncios(db);
  const opcionesDespues = await leerOpciones(db);
  const porClase: Record<string, number> = {
    nueva: 0,
    mismo_ciclo: 0,
    ciclo_nuevo: 0,
    ya_aplicada: 0,
  };
  const fallos: string[] = [];
  const sinteticas: string[] = [];
  let conflictos = 0;
  let sinLink = 0;

  for (const { etiqueta, avisos } of anunciadas(cuerpos)) {
    const [primero] = avisos;
    if (primero === undefined) continue;
    const antes = previo.anuncios.get(etiqueta);
    const ahoraEs = despues.get(etiqueta);

    const vista = antes === undefined ? null : new Date(antes.last_seen_at).getTime();
    const yaAplicada = vista !== null && vista >= ahora.getTime();
    const cicloNuevo =
      antes === undefined || new Date(antes.announced_for).getTime() <= ahora.getTime();

    // La regla de link y conflictos, re-derivada del crudo (ADR 0007). Lo
    // vigente arranca en el primer aviso si la observación es nueva —con el
    // link conocido si llega NULL en el mismo ciclo; en un ciclo nuevo, no se
    // hereda—, o en la fila si ya era de este instante. Fuera de orden, nada.
    // Cada aviso siguiente repite, completa un link donde había NULL, o choca:
    // otra fecha u otro link no nulo es UN conflicto.
    let vigente: { fecha: string | null; link: string | null } | null = null;
    let resto = avisos;
    if (antes === undefined || (vista !== null && vista < ahora.getTime())) {
      vigente = {
        fecha: primero.fecha,
        link: primero.link ?? (cicloNuevo ? null : (antes?.link ?? null)),
      };
      resto = avisos.slice(1);
    } else if (vista === ahora.getTime()) {
      vigente = { fecha: iso(antes.announced_for), link: antes.link };
    }
    if (vigente !== null) {
      for (const a of resto) {
        const otraFecha = a.fecha !== vigente.fecha;
        const otroLink =
          a.link !== null && vigente.link !== null && a.link !== vigente.link;
        if (otraFecha || otroLink) conflictos++;
        else if (a.link !== null && vigente.link === null) {
          vigente = { ...vigente, link: a.link };
        }
      }
    }

    let bien: boolean;
    if (yaAplicada && antes !== undefined) {
      porClase.ya_aplicada = (porClase.ya_aplicada ?? 0) + 1;
      // Intacta, salvo un link completado en este mismo instante.
      bien =
        ahoraEs !== undefined &&
        mismoValorJson({ ...ahoraEs, link: null }, { ...antes, link: null }) &&
        ahoraEs.link === (vigente?.link ?? antes.link);
    } else {
      const clase =
        antes === undefined ? "nueva" : cicloNuevo ? "ciclo_nuevo" : "mismo_ciclo";
      porClase[clase] = (porClase[clase] ?? 0) + 1;
      bien =
        vigente !== null &&
        ahoraEs !== undefined &&
        iso(ahoraEs.announced_for) === primero.fecha &&
        ahoraEs.link === vigente.link &&
        iso(ahoraEs.last_seen_at) === ahora.toISOString() &&
        (ahoraEs.last_seen_run_id === null
          ? null
          : Number(ahoraEs.last_seen_run_id)) === runEsperado &&
        (cicloNuevo
          ? iso(ahoraEs.first_seen_at) === ahora.toISOString() &&
            iso(ahoraEs.first_announced_for) === primero.fecha
          : iso(ahoraEs.first_seen_at) === iso(antes.first_seen_at) &&
            iso(ahoraEs.first_announced_for) === iso(antes.first_announced_for));
    }
    if (!bien) fallos.push(etiqueta);
    if (ahoraEs?.link === null) sinLink++;

    // Ninguna opción nueva con la huella de la antigua sintética.
    const previas = new Set(previo.opciones.get(etiqueta) ?? []);
    for (const aviso of avisos) {
      if (aviso.link === null) continue;
      const huella = `${aviso.link}||${aviso.fecha}`;
      if (
        (opcionesDespues.get(etiqueta) ?? []).includes(huella) &&
        !previas.has(huella)
      ) {
        sinteticas.push(etiqueta);
      }
    }
  }
  return { porClase, fallos, conflictos, sinLink, sinteticas };
}

async function comprobarAnuncios(
  db: EjecutorSql,
  salida: ResultadoDelJobDeUpcoming,
  cuerpos: readonly CuerpoDeCambios[],
  previo: EstadoPrevio | undefined,
  ahora: Date,
  runEsperado: number | null,
): Promise<void> {
  if (previo === undefined) throw new Error("Falta el estado previo de la pasada.");
  const r = await verificarAnuncios(db, cuerpos, previo, ahora, runEsperado);
  const clases = Object.entries(r.porClase)
    .map(([c, n]) => `${c} ${String(n)}`)
    .join(" · ");
  comprobar(
    "ADR 0007 · cada oferta anunciada tiene su fila: fecha y link del primer aviso, " +
      "last_seen_at = ahora, su run y first_* según el ciclo; lo ya aplicado, intacto",
    r.fallos.length === 0,
    clases +
      (r.fallos.length === 0
        ? ""
        : ` — ${String(r.fallos.length)} fallos: ${r.fallos.slice(0, 5).join(" · ")}`),
  );
  comprobar(
    "ningún anuncio sintetiza una opción (link del aviso, sin calidad, su fecha)",
    r.sinteticas.length === 0,
    r.sinteticas.slice(0, 5).join(" · "),
  );
  const g = salida.anunciosGuardados;
  comprobar(
    "los conflictos del informe cuadran con el crudo (se reportan, no se aplican)",
    (g?.conflictos.length ?? -1) === r.conflictos,
    `${String(g?.conflictos.length ?? "?")} en el informe · ${String(r.conflictos)} en el crudo`,
  );
  for (const c of g?.conflictos ?? []) {
    console.log(
      `       · ${c.clave}: vigente ${c.vigente.anunciadoPara} ${c.vigente.enlace ?? "(sin link)"}` +
        ` · descartado ${c.descartado.anunciadoPara} ${c.descartado.enlace ?? "(sin link)"}`,
    );
  }
  const a = salida.anuncios;
  if (a !== null && a.sinShow === 0 && Object.keys(a.fueraDelMvp).length === 0) {
    comprobar(
      "📏 cada anuncio sin link queda guardado con link NULL: informe == resumen del crudo",
      g?.sinEnlace === a.sinEnlace.total,
      `${String(g?.sinEnlace ?? "?")} en el informe · ${String(a.sinEnlace.total)} en el crudo` +
        ` · ${String(r.sinLink)} filas con link NULL`,
    );
  }
}

// ── Las tres acciones ───────────────────────────────────────────────────────

/** 📏 `raw/024`: `upcoming` de las seis plataformas, página 1, 31 días. */
const FIXTURES = {
  pagina1: "024-C-changes-upcoming.json",
  /** 📏 `raw/031`–`036`: `upcoming` por plataforma, página 1 de cada una. */
  porPlataforma: /^03[1-6]-D-upcoming-/,
  etiquetaPagina1: "raw/024",
  etiquetaPagina2: "raw/031–036",
};

async function ensayoDeUpcoming(): Promise<void> {
  await ensayo(UPCOMING, FIXTURES, {
    // ADR 0007: un anuncio no emite eventos. Lo único posible es un `changed`
    // de una oferta que el snapshot del show lista y el corpus ya tenía.
    eventosPermitidos: ["changed"],
    preparar: capturarEstadoPrevio,
    async pasada1(db, salida, { pagina1, pagina2 }, ahora, previo) {
      // El ensayo corre con la fila en memoria: `last_seen_run_id = NULL`.
      await comprobarAnuncios(db, salida, [pagina1, pagina2], previo, ahora, null);
    },
  });
}

async function realDeUpcoming(): Promise<void> {
  await real(UPCOMING, {
    preparar: capturarEstadoPrevio,
    async despues(db, salida, cuerpos, ahora, previo) {
      const runId = salida.resultado.ejecutado ? salida.resultado.runId : null;
      await comprobarAnuncios(db, salida, cuerpos, previo, ahora, runId);
    },
  });
}

async function principal(): Promise<void> {
  await despachar(PIPELINE_UPCOMING, TOPE, {
    ensayo: ensayoDeUpcoming,
    reproducir: (dir) => reproducir(UPCOMING, dir),
    real: realDeUpcoming,
  });
  cerrarComprobaciones();
}

principal().catch(fallar);
