/**
 * **Ejecución MANUAL del pipeline `expiring`** contra `drizzle-schema-v1-test`.
 * Nunca contra `production`: las mismas guardas que la migración la hacen
 * inalcanzable.
 *
 *   pnpm api:run:expiring --ensayo               CERO API · Neon · todo en ROLLBACK
 *   pnpm api:run:expiring --reproducir <dir>     CERO API · Neon · todo en ROLLBACK
 *   pnpm api:run:expiring --real                 GASTA CUOTA · hasta 12 requests
 *
 * **Sin flag no hace nada.** Gastar cuota exige escribirlo: `--real`, y una
 * autorización explícita cada vez.
 *
 * El ensayo, la reproducción y la real son los comunes a los recorridos del
 * horizonte (`horizonte-manual.ts`); aquí solo vive lo propio de `expiring`.
 *
 * ── Lo decidido para la medición inicial (2026-09-24) ───────────────────────
 *
 *   · **Horizonte: 31 días.** Cadencia semanal: cron de los lunes a las
 *     05:17 UTC en `.github/workflows/expiring.yml`, tras la fila 49.
 *   · **Tope: 12 requests** (`TOPE_DE_MEDICION`). Nació aquí, inyectado; desde
 *     el 2026-09-24 es también el de `TOPE_POR_EJECUCION_POR_DEFECTO`.
 *   · **Si al llegar a 12 sigue `hasMore=true`, se detiene y lo reporta.** No
 *     se amplía el tope automáticamente: es `budget_stopped`, el recorrido
 *     queda incompleto y la cifra es un suelo.
 *   · **El techo mensual** se fijó tras la medición (6 requests): 60.
 *   · **Ninguna ausencia se interpreta como eliminación.** Con el recorrido
 *     completo solo se **cuentan** las ofertas que desaparecen del horizonte.
 *
 * ── Lo que este script NO hace ──────────────────────────────────────────────
 *
 * No es el job programado —ese es `pnpm job expiring`
 * (`jobs/pipelines/expiring/programado.ts`)—, no crea workflow ni cron y no
 * toca las migraciones.
 */
import { join } from "node:path";

import type { EjecutorSql } from "../jobs/ops/contratos.ts";
import { PAIS, UMBRAL_DE_INACTIVIDAD } from "../jobs/pipelines/deltas/contratos.ts";
import { DIAS_DE_SALIDA_PROXIMA } from "../jobs/pipelines/deltas/estado.ts";
import {
  PIPELINE_EXPIRING,
  leerCheckpointDeExpiring,
  planificarExpiring,
} from "../jobs/pipelines/expiring/checkpoint.ts";
import type { ResultadoDelJobDeExpiring } from "../jobs/pipelines/expiring/job.ts";
import { ejecutarJobDeExpiring } from "../jobs/pipelines/expiring/job.ts";
import {
  compararConOriginal,
  planDeReconstruccion,
} from "../jobs/pipelines/expiring/reproduccion.ts";
import { plataformaDesdeFuente } from "../jobs/pipelines/seed/plataformas.ts";
import type { CuerpoDeCambios, DescriptorDeHorizonte } from "./horizonte-manual.ts";
import {
  RAIZ,
  despachar,
  ensayo,
  informarHorizonte,
  real,
  reproducir,
} from "./horizonte-manual.ts";
import { cerrarComprobaciones, comprobar, fallar } from "./manual-comun.ts";

/**
 * ⚖️ **El tope de la medición inicial: 12** (decidido el 2026-09-24).
 * 📐 Extrapolación, no medida: `raw/023` cubre 0,4–7,4 días con 25 avisos, así
 * que 31 días podrían ser ~8–10 páginas. 12 deja margen; si no basta, la
 * ejecución se detiene con `hasMore=true` y lo dice.
 */
const TOPE_DE_MEDICION = 12;

const EXPIRING: DescriptorDeHorizonte<ResultadoDelJobDeExpiring> = {
  pipeline: PIPELINE_EXPIRING,
  tipo: "expiring",
  tope: TOPE_DE_MEDICION,
  directorioDeEjecuciones: join(RAIZ, ".expiring-runs"),
  ejecutar: ejecutarJobDeExpiring,
  planificar: (ahora) => planificarExpiring(ahora),
  leerCheckpoint: leerCheckpointDeExpiring,
  planDeReconstruccion,
  comparar: compararConOriginal,
  informar: informarHorizonte,
};

// ── Auditoría específica de expiring ────────────────────────────────────────

/**
 * 📏 Cada aviso con enlace: ¿la opción de **esa oferta** y **ese enlace**
 * quedó con `expires_at == timestamp`? Por oferta y enlace, nunca solo por
 * enlace: dos addons de Prime comparten deeplink (`raw/023`, ADR 0005).
 */
async function verificarFechasDeSalida(
  db: EjecutorSql,
  cuerpos: readonly CuerpoDeCambios[],
): Promise<{ coinciden: number; distintas: string[]; sinOpcion: string[] }> {
  let coinciden = 0;
  const distintas: string[] = [];
  const sinOpcion: string[] = [];
  for (const cuerpo of cuerpos) {
    for (const a of cuerpo.changes) {
      const plataforma = plataformaDesdeFuente(a.service.id);
      const imdb = cuerpo.shows[a.showId]?.imdbId;
      if (plataforma === null || imdb === undefined || a.link === undefined) continue;
      const etiqueta = `${imdb}|${plataforma}|${a.streamingOptionType}|${a.addon?.id ?? ""}`;
      const filas = await db.ejecutar<{ expires_at: Date | null }>(
        `SELECT o.expires_at
           FROM external_availability_options o
           JOIN external_availability av ON av.id = o.availability_id
           JOIN external_titles t ON t.id = av.title_id
          WHERE t.imdb_id = $1 AND av.platform_id = $2 AND av.country = $3
            AND av.offer_type = $4 AND av.addon IS NOT DISTINCT FROM $5
            AND o.link = $6`,
        [imdb, plataforma, PAIS, a.streamingOptionType, a.addon?.id ?? null, a.link],
      );
      if (filas.length === 0) {
        sinOpcion.push(etiqueta);
        continue;
      }
      const esperado = a.timestamp * 1000;
      if (
        filas.every(
          (f) => f.expires_at !== null && new Date(f.expires_at).getTime() === esperado,
        )
      ) {
        coinciden++;
      } else {
        distintas.push(etiqueta);
      }
    }
  }
  return { coinciden, distintas, sinOpcion };
}

/** Informativo: ofertas activas con salida futura en los próximos 30 días. */
async function ofertasEnUltimosDias(db: EjecutorSql, ahora: Date): Promise<number> {
  const [fila] = await db.ejecutar<{ n: string }>(
    `SELECT count(DISTINCT o.availability_id)::text AS n
       FROM external_availability_options o
      WHERE o.missing_streak < $1
        AND o.expires_at > $2::timestamptz
        AND o.expires_at <= $3::timestamptz`,
    [
      UMBRAL_DE_INACTIVIDAD,
      ahora,
      new Date(ahora.getTime() + DIAS_DE_SALIDA_PROXIMA * 86_400_000),
    ],
  );
  return Number(fila?.n ?? -1);
}

// ── Las tres acciones ───────────────────────────────────────────────────────

/** 📏 `raw/023`: `expiring` de las seis plataformas, página 1, 31 días. */
const FIXTURES = {
  pagina1: "023-C-changes-expiring.json",
  /** 📏 `raw/025`–`030`: `expiring` por plataforma, página 1 de cada una. */
  porPlataforma: /^0(2[5-9]|30)-D-expiring-/,
  etiquetaPagina1: "raw/023",
  etiquetaPagina2: "raw/025–030",
};

async function ensayoDeExpiring(): Promise<void> {
  await ensayo(EXPIRING, FIXTURES, {
    // Ni altas, ni anuncios, ni bajas: una fecha de salida solo cambia algo.
    eventosPermitidos: ["changed"],
    async pasada1(db, _salida, { pagina1, pagina2 }, ahora) {
      const fechas = await verificarFechasDeSalida(db, [pagina1, pagina2]);
      comprobar(
        "📏 expires_at == timestamp del aviso en cada opción nombrada",
        fechas.distintas.length === 0 &&
          fechas.sinOpcion.length === 0 &&
          fechas.coinciden > 0,
        `${String(fechas.coinciden)} coinciden · ${String(fechas.distintas.length)} distintas · ` +
          `${String(fechas.sinOpcion.length)} sin opción` +
          (fechas.distintas.length + fechas.sinOpcion.length === 0
            ? ""
            : ` — ${[...fechas.distintas, ...fechas.sinOpcion].slice(0, 5).join(" · ")}`),
      );
      console.log(
        `    «Últimos días» (salida futura ≤ ${String(DIAS_DE_SALIDA_PROXIMA)} d): ` +
          `${String(await ofertasEnUltimosDias(db, ahora))} ofertas`,
      );
    },
  });
}

async function realDeExpiring(): Promise<void> {
  await real(EXPIRING, {
    async despues(db, _salida, _cuerpos, ahora) {
      console.log(
        `  «Últimos días»    ${String(await ofertasEnUltimosDias(db, ahora))} ofertas con salida futura ≤ ${String(DIAS_DE_SALIDA_PROXIMA)} d`,
      );
    },
  });
}

async function principal(): Promise<void> {
  await despachar(PIPELINE_EXPIRING, TOPE_DE_MEDICION, {
    ensayo: ensayoDeExpiring,
    reproducir: (dir) => reproducir(EXPIRING, dir),
    real: realDeExpiring,
  });
  cerrarComprobaciones();
}

principal().catch(fallar);
