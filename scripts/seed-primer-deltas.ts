/**
 * `pnpm seed:primer-deltas --real` — **el primer `deltas` de la rama del seed
 * real**, desde el ancla: `[S, ahora]` (ADR 0009 §7). **Gasta cuota** del
 * presupuesto aprobado de `deltas` (tope 4, techo 124), en el libro de esa rama.
 *
 * `pnpm production:primer-deltas <crudo>` — **el mismo, en `production`**
 * (ADR 0010): guardas de `destino-production.ts`, autorización en código
 * `primer_deltas` atada a la huella del crudo, y el ancla de `production`
 * tiene que ser la de **ese** crudo. Gasta del presupuesto de `deltas` en el
 * libro de `production`.
 *
 * No añade lógica: es `ejecutarDeltasProgramado` —el mismo runner que `pnpm job
 * deltas`— con **una sola diferencia**, el destino (`destinosAdmitidos`), que
 * está en el régimen estricto, así que sin checkpoint propio la ventana sale
 * del ancla del seed. Sin ancla → `sin_seed`; pasado `S + 72 h` →
 * `ancla_caducada`; los dos con 0 requests. Si corta por tope, se relanza:
 * reanuda desde su checkpoint, **dentro de `S + 72 h`**.
 *
 * ⚖️ **Solo para el bootstrap.** Antes de abrir las conexiones del job, una
 * lectura (`READ ONLY`) exige que exista el ancla y que el bootstrap siga
 * incompleto: con el primer `deltas` ya completo, este script no gasta nada
 * (el mantenimiento es `pnpm job deltas`).
 *
 * El presupuesto es el del código: aquí no se admite ningún override.
 * El crudo de `/changes` queda en `.deltas-runs/<sello>-primer-deltas[-production]/`:
 * el de validación es la entrada de `seed:m4`.
 *
 * Salida: la de `pnpm job deltas` (0 · 1 · 2).
 */
import { join, resolve } from "node:path";

import { DESTINO_PRODUCTION } from "../destino-production.ts";
import { exigirAutorizacionDeProduction } from "../jobs/ops/autorizacion-de-production.ts";
import { conectar } from "../jobs/ops/conexion.ts";
import { sanearTexto } from "../jobs/ops/diagnostico.ts";
import { evaluarBootstrap } from "../jobs/pipelines/deltas/checkpoint.ts";
import { ejecutarDeltasProgramado } from "../jobs/pipelines/deltas/programado.ts";
import type { DestinoVerificado } from "../jobs/pipelines/programado.ts";
import { leerAnclaDelSeed } from "../jobs/pipelines/seed/ancla.ts";
import { esCrudoDeEnsayo } from "../jobs/pipelines/seed/ensayo.ts";
import { destinoDeProduction, separarBandera } from "./production-comun.ts";
import { credencialSinOverrides } from "./seed-api-comun.ts";
import { crudoCargable } from "./seed-comun.ts";

/**
 * Solo lectura: el ancla existe (y es la de esa huella, si se da) y el
 * bootstrap sigue incompleto. Lanza si no.
 */
async function exigirBootstrapPendiente(
  url: string,
  huellaEsperada: string | null,
): Promise<void> {
  const conexion = await conectar(url);
  try {
    const e = conexion.ejecutor;
    await e.ejecutar("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      const ancla = await leerAnclaDelSeed(e);
      if (ancla === null) {
        throw new Error(
          "El destino no tiene ancla del seed: no hay primer deltas posible.",
        );
      }
      if (huellaEsperada !== null && ancla.checkpoint.huella !== huellaEsperada) {
        throw new Error("El ancla del destino es de otro crudo: no se ejecuta.");
      }
      const bootstrap = await evaluarBootstrap(e);
      if (bootstrap.completo) {
        throw new Error(
          `El bootstrap ya está completo (fila ${String(bootstrap.runId)}): el mantenimiento es pnpm job deltas.`,
        );
      }
      console.log(
        `  ancla             S = ${ancla.ancla.toISOString()} (fila ${String(ancla.runId)})`,
      );
      console.log(`  bootstrap         pendiente (${bootstrap.causa})`);
    } finally {
      await e.ejecutar("ROLLBACK");
    }
  } finally {
    await conexion.cerrar();
  }
}

async function principal(todos: readonly string[]): Promise<number> {
  const { production, resto } = separarBandera(todos);
  const valido = production
    ? resto.length === 1 && resto[0] !== undefined && resto[0].trim() !== ""
    : resto.length === 1 && resto[0] === "--real";
  if (!valido) {
    console.error(
      "Uso: pnpm seed:primer-deltas --real\n     pnpm production:primer-deltas <directorio del crudo>",
    );
    return 1;
  }
  credencialSinOverrides();

  let destino: DestinoVerificado;
  let admitidos: readonly string[];
  let huella: string | null = null;
  if (production) {
    console.log("PRODUCTION:PRIMER-DELTAS — gasta cuota de deltas (tope 4)\n");
    const d = destinoDeProduction();
    const crudo = crudoCargable(resolve(resto[0] ?? ""));
    if (esCrudoDeEnsayo(crudo))
      throw new Error("Un crudo de ensayo nunca va a production.");
    exigirAutorizacionDeProduction({
      operacion: "primer_deltas",
      huellaDelCrudo: crudo.huella,
    });
    console.log(`  autorización      primer_deltas ${crudo.huella} ✅`);
    destino = d;
    admitidos = [DESTINO_PRODUCTION];
    huella = crudo.huella;
  } else {
    const { RAMA_DEL_SEED_REAL, verificarDestino } =
      await import("../drizzle.migrate.config.ts");
    destino = verificarDestino(process.env, [RAMA_DEL_SEED_REAL]);
    admitidos = [RAMA_DEL_SEED_REAL];
  }
  await exigirBootstrapPendiente(destino.url, huella);

  const sello = new Date().toISOString().replace(/[:.]/g, "-");
  const directorio = join(
    ".deltas-runs",
    `${sello}-primer-deltas${production ? "-production" : ""}`,
  );
  const { veredicto, resumen } = await ejecutarDeltasProgramado({
    entorno: process.env,
    destino,
    conectar,
    destinosAdmitidos: admitidos,
    ...(production ? { variableDelHost: "NEON_PRODUCTION_HOST" as const } : {}),
    directorioDeRegistros: directorio,
  });
  for (const linea of resumen) console.log(linea);
  console.log(`crudo de /changes: ${directorio}`);
  return veredicto.codigo;
}

principal(process.argv.slice(2)).then(
  (codigo) => {
    process.exitCode = codigo;
  },
  (error: unknown) => {
    console.error(sanearTexto(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  },
);
