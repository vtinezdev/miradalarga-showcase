/**
 * `pnpm seed:crudo-de-ensayo` — genera un **crudo de ensayo** v1 en
 * `.seed-runs/ensayo-spike1-<sello>/` (`jobs/pipelines/seed/ensayo.ts`).
 *
 * **0 API y sin base de datos.** Reenvía por el motor de captura de verdad los
 * cuerpos reales de la página 1 de los 12 estratos del Spike 1
 * (`spike-1/raw/003–014`), con un libro de cuota en memoria. Después lo
 * verifica con `seed:verificar` y escribe al lado, **fuera del crudo** —que no
 * admite ficheros de más—, `<capturaId>.origen.json`: de qué ficheros sale,
 * con sus sha256, y qué partes del crudo no son una observación real.
 *
 * ⚠️ El ancla vence a las 72 h de generarlo: se genera justo antes de cargar.
 *
 * Salida: `0` crudo generado, verificado y cargable · `1` cualquier otra cosa.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { crearLibroEnMemoria } from "../jobs/ops/libro-en-memoria.ts";
import { ejecutarCaptura } from "../jobs/pipelines/seed/captura.ts";
import { crearAlmacenEnDisco } from "../jobs/pipelines/seed/crudo/almacen.ts";
import { leerDirectorioDelCrudo } from "../jobs/pipelines/seed/crudo/disco.ts";
import { ESTRATOS_DEL_MVP } from "../jobs/pipelines/seed/crudo/formato.ts";
import { sha256 } from "../jobs/pipelines/seed/crudo/huella.ts";
import {
  describirVerificacion,
  verificarCrudo,
} from "../jobs/pipelines/seed/crudo/verificar.ts";
import {
  DESTINO_DEL_ENSAYO,
  M1_SINTETICA,
  PREFIJO_DE_ENSAYO,
  fuenteDeReplay,
  planDeEnsayo,
  presupuestoDelEnsayo,
} from "../jobs/pipelines/seed/ensayo.ts";

const RAIZ = resolve(import.meta.dirname, "..");
const RAW_DEL_SPIKE = join(RAIZ, "spike-1", "raw");
const DIRECTORIO_DE_CRUDOS = join(RAIZ, ".seed-runs");

interface FicheroDelSpike {
  readonly meta?: {
    readonly slug?: string;
    readonly path?: string;
    readonly query?: Readonly<Record<string, string>>;
    readonly ts_utc?: string;
  };
  readonly body?: unknown;
}

/** `003-B-netflix-movie.json` … `014-B-skyshowtime-series.json`, por estrato. */
function leerCuerposDelSpike(): {
  cuerpos: Map<string, Uint8Array>;
  origen: Record<string, unknown>[];
} {
  const cuerpos = new Map<string, Uint8Array>();
  const origen: Record<string, unknown>[] = [];
  ESTRATOS_DEL_MVP.forEach((estrato, i) => {
    const nombre = `${String(i + 3).padStart(3, "0")}-B-${estrato.estrato}.json`;
    const ruta = join(RAW_DEL_SPIKE, nombre);
    if (!existsSync(ruta)) {
      throw new Error(`Falta ${nombre} en spike-1/raw/ (solo existe en local).`);
    }
    const bytesOriginales = readFileSync(ruta);
    const fichero = JSON.parse(bytesOriginales.toString("utf8")) as FicheroDelSpike;
    const q = fichero.meta?.query ?? {};
    // Que el fichero es el del estrato, y no otro con un nombre parecido.
    if (
      fichero.meta?.slug !== `B-${estrato.estrato}` ||
      fichero.meta.path !== "/shows/search/filters" ||
      q.country !== "es" ||
      q.catalogs !== estrato.catalogo ||
      q.show_type !== estrato.showType ||
      q.cursor !== undefined
    ) {
      throw new Error(`${nombre} no es la página 1 de ${estrato.estrato}.`);
    }
    // Sin envoltorio: el crudo guarda el cuerpo de la respuesta, no el del Spike.
    const cuerpo = new TextEncoder().encode(JSON.stringify(fichero.body));
    cuerpos.set(estrato.estrato, cuerpo);
    origen.push({
      estrato: estrato.estrato,
      fichero: `spike-1/raw/${nombre}`,
      sha256DelFichero: sha256(new Uint8Array(bytesOriginales)),
      sha256DelCuerpo: sha256(cuerpo),
      observadoEn: fichero.meta.ts_utc ?? null,
      queryOriginal: q,
    });
  });
  return { cuerpos, origen };
}

function commitActual(): string | null {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: RAIZ })
      .toString("utf8")
      .trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

async function principal(): Promise<number> {
  const { cuerpos, origen } = leerCuerposDelSpike();
  const inicio = new Date();
  const capturaId = `${PREFIJO_DE_ENSAYO}spike1-${inicio.toISOString().replace(/[:.]/g, "-")}`;
  const directorio = join(DIRECTORIO_DE_CRUDOS, capturaId);
  if (existsSync(directorio)) throw new Error(`Ya existe ${directorio}.`);

  const commit = commitActual();
  const plan = planDeEnsayo({ capturaId, commit, inicio });
  const libro = crearLibroEnMemoria();

  console.log("CRUDO DE ENSAYO DEL SEED — 0 API, sin base de datos\n");
  console.log(`  capturaId  ${capturaId}`);
  console.log(`  origen     spike-1/raw/003–014 (página 1 de los 12 estratos)`);

  const salida = await ejecutarCaptura({
    ejecutorOps: libro.ejecutor,
    presupuesto: presupuestoDelEnsayo(),
    plan,
    fuente: fuenteDeReplay(cuerpos),
    almacen: crearAlmacenEnDisco(directorio),
    // Cuerpos ya pagados, reenviados sin proveedor: no hay cabeceras x-quota-*.
    comprobarCuotaDelProveedor: false,
    reloj: () => new Date(),
    destino: DESTINO_DEL_ENSAYO,
    commitSha: commit,
  });
  const r = salida.resultado;
  if (!r.ejecutado || r.estado !== "succeeded" || salida.manifiesto === null) {
    console.error(
      `\n❌ La captura de ensayo no terminó succeeded: ${JSON.stringify(
        r.ejecutado ? r.metricas.errorSamples : r.motivo,
      )}`,
    );
    return 1;
  }

  const verificacion = verificarCrudo(leerDirectorioDelCrudo(directorio));
  console.log("");
  for (const linea of describirVerificacion(verificacion)) console.log(linea);

  writeFileSync(
    join(DIRECTORIO_DE_CRUDOS, `${capturaId}.origen.json`),
    `${JSON.stringify(
      {
        capturaId,
        generadoEn: inicio.toISOString(),
        commit,
        huellaDelCrudo: verificacion.huellaDelCrudo,
        huellaCanonica: verificacion.huellaCanonica,
        naturaleza: "crudo de ensayo: 0 requests, libro de cuota en memoria",
        real: [
          "los cuerpos de las 12 páginas: respuestas del proveedor del 2026-09-21, sin su envoltorio {meta, body}",
        ],
        noReal: [
          "las queries del manifiesto declaran order_by=popularity_alltime; los cuerpos se pidieron con el orden por defecto",
          "T0, S, reservas y respuestas son instantes del reenvío, no de la observación",
          `la M1 del plan es sintética (fila ${M1_SINTETICA}): no hubo sonda`,
          `la fila de la captura vive en memoria (destino ${DESTINO_DEL_ENSAYO}); sin cabeceras de cuota`,
        ],
        paginas: origen,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  if (!verificacion.ok || verificacion.crudo?.cargable !== true) {
    console.error("\n❌ El crudo de ensayo no es íntegro y cargable.");
    return 1;
  }
  console.log(`\n  directorio ${directorio}`);
  console.log(
    `  ⚠️  El ancla vence el ${verificacion.resumen?.vencimientoDelAncla ?? "?"}.`,
  );
  return 0;
}

principal().then(
  (codigo) => {
    process.exitCode = codigo;
  },
  (error: unknown) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
