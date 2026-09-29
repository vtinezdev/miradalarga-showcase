/**
 * Lo común a los scripts que alcanzan **`production`** (ADR 0010).
 *
 *   · **Guardas de entorno** (`destino-production.ts`), antes de abrir ningún
 *     socket, con sus propias variables y sin variables de validación.
 *   · **Autorización en código** (`AUTORIZACIONES_DE_PRODUCTION`) para todo lo
 *     que escribe —también lo que acaba en `ROLLBACK`—, atada a la migración o
 *     a la huella del crudo. Las lecturas no la piden.
 *   · **La compuerta del crudo**: recibo de aceptación de la rama del seed real
 *     y M4 **recalculado** desde los crudos del primer `deltas`. Un crudo
 *     refutado por M4 no pasa.
 *
 * Nunca se imprime la cadena de conexión. **`production` no se escribe desde
 * aquí**: estos son los cerrojos que lo impiden hasta que se autorice.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type { DestinoDeProduction } from "../destino-production.ts";
import { verificarDestinoDeProduction } from "../destino-production.ts";
import type { ObjetoAutorizado } from "../jobs/ops/autorizacion-de-production.ts";
import { exigirAutorizacionDeProduction } from "../jobs/ops/autorizacion-de-production.ts";
import type {
  EstadoDeLaCompuerta,
  M4Guardado,
  ReciboDeAceptacion,
} from "../jobs/pipelines/seed/compuerta-production.ts";
import { evaluarCompuertaDeProduction } from "../jobs/pipelines/seed/compuerta-production.ts";
import type { CrudoVerificado } from "../jobs/pipelines/seed/crudo/verificar.ts";
import { esCrudoDeEnsayo } from "../jobs/pipelines/seed/ensayo.ts";
import { m4DesdeDisco } from "./m4-desde-disco.ts";
import { RAIZ } from "./seed-referencias.ts";

/** La bandera que convierte un script del seed en su versión de `production`. */
export const BANDERA_PRODUCTION = "--production";

/**
 * **La única rama cuya aceptación vale para `production`**: la del seed real
 * (ADR 0009 §9). Literal a propósito: este módulo no puede importar
 * `drizzle.migrate.config.ts`, cuyas guardas de validación abortan en una
 * sesión de `production`. Un test exige que coincida con `RAMA_DEL_SEED_REAL`.
 */
export const RAMA_DE_ACEPTACION = "seed-real-v1-test";

/** Quita `--production` de los argumentos y dice si estaba. */
export function separarBandera(argumentos: readonly string[]): {
  readonly production: boolean;
  readonly resto: readonly string[];
} {
  return {
    production: argumentos.includes(BANDERA_PRODUCTION),
    resto: argumentos.filter((a) => a !== BANDERA_PRODUCTION),
  };
}

/**
 * Las guardas de entorno de `production` y, si se pide, la autorización en
 * código. Imprime solo el hostname y el destino.
 */
export function destinoDeProduction(
  objeto: ObjetoAutorizado | null = null,
): DestinoDeProduction {
  const destino = verificarDestinoDeProduction(process.env);
  if (objeto !== null) exigirAutorizacionDeProduction(objeto);
  if (typeof WebSocket === "undefined") {
    throw new Error("Este Node no expone WebSocket global y Neon lo necesita.");
  }
  console.log(`  hostname          ${destino.hostname}`);
  console.log(`  PRODUCTION_TARGET ${destino.rama}`);
  console.log(
    `  autorización      ${objeto === null ? "no requerida (solo lectura)" : `${objeto.operacion} ✅`}`,
  );
  return destino;
}

// ── Recibo de aceptación ─────────────────────────────────────────────────────

/** `.seed-runs/<capturaId>.aceptacion.json`, al lado del crudo. */
export function rutaDelReciboDeAceptacion(directorioDelCrudo: string): string {
  const d = resolve(directorioDelCrudo);
  return join(dirname(d), `${basename(d)}.aceptacion.json`);
}

export function escribirReciboDeAceptacion(
  directorioDelCrudo: string,
  recibo: ReciboDeAceptacion,
): string {
  const ruta = rutaDelReciboDeAceptacion(directorioDelCrudo);
  writeFileSync(ruta, `${JSON.stringify(recibo, null, 2)}\n`, "utf8");
  return ruta;
}

function leerJson<T>(ruta: string): T | null {
  return existsSync(ruta) ? (JSON.parse(readFileSync(ruta, "utf8")) as T) : null;
}

export function leerReciboDeAceptacion(
  directorioDelCrudo: string,
): ReciboDeAceptacion | null {
  return leerJson<ReciboDeAceptacion>(rutaDelReciboDeAceptacion(directorioDelCrudo));
}

/** `.seed-runs/<capturaId>.m4.json`, el que escribe `seed:m4`. */
export function rutaDelM4(directorioDelCrudo: string): string {
  const d = resolve(directorioDelCrudo);
  return join(dirname(d), `${basename(d)}.m4.json`);
}

// ── La compuerta ─────────────────────────────────────────────────────────────

/**
 * Lee el recibo y el informe de M4, **recalcula M4** desde los crudos de
 * `.deltas-runs/` que el informe nombra y evalúa la compuerta. Nunca lanza por
 * un fichero ausente o ilegible: lo cuenta como problema (fail closed).
 */
export function compuertaDesdeDisco(
  directorioDelCrudo: string,
  crudo: CrudoVerificado,
  raizDeDeltas: string = join(RAIZ, ".deltas-runs"),
): EstadoDeLaCompuerta & { readonly m4Recalculado: unknown } {
  const problemasDeLectura: string[] = [];
  let aceptacion: ReciboDeAceptacion | null = null;
  let m4Guardado: M4Guardado | null = null;
  try {
    aceptacion = leerJson<ReciboDeAceptacion>(
      rutaDelReciboDeAceptacion(directorioDelCrudo),
    );
  } catch {
    problemasDeLectura.push("recibo de aceptación ilegible");
  }
  try {
    m4Guardado = leerJson<M4Guardado>(rutaDelM4(directorioDelCrudo));
  } catch {
    problemasDeLectura.push("informe de M4 ilegible");
  }
  let m4Recalculado: ReturnType<typeof m4DesdeDisco>["informe"] | null = null;
  if (m4Guardado !== null && Array.isArray(m4Guardado.deltas)) {
    try {
      m4Recalculado = m4DesdeDisco(
        directorioDelCrudo,
        (m4Guardado.deltas as readonly unknown[]).map((d) =>
          join(raizDeDeltas, basename(String(d))),
        ),
      ).informe;
    } catch (error) {
      problemasDeLectura.push(
        `recálculo de M4: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  let estado: EstadoDeLaCompuerta;
  try {
    estado = evaluarCompuertaDeProduction({
      crudo: {
        huella: crudo.huella,
        huellaCanonica: crudo.huellaCanonica,
        capturaId: crudo.plan.capturaId,
        ancla: crudo.ancla,
        esEnsayo: esCrudoDeEnsayo(crudo),
      },
      ramaDeAceptacion: RAMA_DE_ACEPTACION,
      aceptacion,
      m4Guardado,
      m4Recalculado,
    });
  } catch (error) {
    // Un recibo o informe con otra forma: se niega, nunca se da por bueno.
    estado = {
      ok: false,
      problemas: [
        `recibo o informe mal formado: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  const problemas = [...problemasDeLectura, ...estado.problemas];
  return {
    ok: problemas.length === 0,
    problemas,
    m4Recalculado:
      m4Recalculado === null
        ? null
        : {
            resultado: m4Recalculado.resultado,
            muestras: m4Recalculado.muestras,
            retrasoMaximoObservadoSegundos:
              m4Recalculado.retrasoMaximoObservadoSegundos,
          },
  };
}

/** Imprime la compuerta y lanza si no pasa. */
export function exigirCompuerta(
  directorioDelCrudo: string,
  crudo: CrudoVerificado,
): void {
  const c = compuertaDesdeDisco(directorioDelCrudo, crudo);
  console.log(`  compuerta         ${c.ok ? "✅ abierta" : "⛔ cerrada"}`);
  for (const p of c.problemas) console.log(`    ✗ ${p}`);
  if (!c.ok) {
    throw new Error(
      "La compuerta de production está cerrada para este crudo: no se carga (ADR 0010).",
    );
  }
}
