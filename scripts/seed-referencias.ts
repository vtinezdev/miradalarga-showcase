/**
 * Las referencias del Spike que M1 usa, y dos utilidades sin red: la raíz del
 * repositorio y el commit actual. **No alcanza el transporte** (test de
 * contrato): `seed:plan` y `seed:post-captura` son 0 API por construcción.
 *
 *   · la página 1 por defecto de los 12 estratos (`spike-1/raw/003–014`);
 *   · la evidencia de `popularity_alltime` en Netflix (`spike-3/raw/016`, `027`).
 *
 * Solo existen en local (`.gitignore`).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ESTRATOS_DEL_MVP } from "../jobs/pipelines/seed/crudo/formato.ts";
import { sha256 } from "../jobs/pipelines/seed/crudo/huella.ts";

export const RAIZ = resolve(import.meta.dirname, "..");
export const DIRECTORIO_DE_CRUDOS = join(RAIZ, ".seed-runs");

export function commitActual(): string | null {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: RAIZ })
      .toString("utf8")
      .trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export interface FicheroDelSpike {
  readonly estrato: string;
  /** Relativa a la raíz del repositorio, con `/`. */
  readonly ruta: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly status: number | null;
  readonly shows: readonly unknown[];
  readonly cuerpo: unknown;
}

function leerDelSpike(estrato: string, ruta: string): FicheroDelSpike {
  const absoluta = join(RAIZ, ruta);
  if (!existsSync(absoluta))
    throw new Error(`Falta ${ruta} (el crudo de los spikes solo existe en local).`);
  const bytes = new Uint8Array(readFileSync(absoluta));
  const v = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
    meta?: { status?: number };
    body?: { shows?: unknown };
  };
  const shows = v.body?.shows;
  return {
    estrato,
    ruta,
    bytes,
    sha256: sha256(bytes),
    status: v.meta?.status ?? null,
    shows: Array.isArray(shows) ? shows : [],
    cuerpo: v.body ?? null,
  };
}

/** La página 1 por defecto de cada estrato (Spike 1, bloque B). */
export function referenciasDelSpike(): FicheroDelSpike[] {
  return ESTRATOS_DEL_MVP.map((e, i) =>
    leerDelSpike(
      e.estrato,
      `spike-1/raw/${String(i + 3).padStart(3, "0")}-B-${e.estrato}.json`,
    ),
  );
}

/** La evidencia de `popularity_alltime` en Netflix (Spike 3). */
export function evidenciaDeNetflix(): FicheroDelSpike[] {
  return [
    leerDelSpike("netflix-movie", "spike-3/raw/016-pop-alltime-movie-p1.json"),
    leerDelSpike("netflix-series", "spike-3/raw/027-pop-alltime-series-p1.json"),
  ];
}

/** Todos los ficheros externos de M1, por ruta: lo que `verificarM1` recibe. */
export function externosDeM1(): Map<string, Uint8Array> {
  return new Map(
    [...referenciasDelSpike(), ...evidenciaDeNetflix()].map((f) => [f.ruta, f.bytes]),
  );
}
