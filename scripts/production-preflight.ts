/**
 * `pnpm db:preflight:production [--con-neon] [--en-seed-real]` — el preflight
 * del bloque de `production` (ADR 0010). **No escribe nada.**
 *
 *   · Sin `--con-neon`: sin red. Guardas de entorno, migraciones locales
 *     exactas y el estado de `AUTORIZACIONES_DE_PRODUCTION`.
 *   · Con `--con-neon`: además, **una transacción `READ ONLY`** en el destino:
 *     versión, tablas, migraciones aplicadas, la decisión de la migración
 *     (virgen · exacta · negada) y, si el modelo ya existe, si el catálogo es
 *     virgen y si hay ancla.
 *   · `--en-seed-real`: lo mismo contra `seed-real-v1-test`, el ensayo.
 *
 * Las lecturas no piden autorización en código; escribir, sí. Nunca imprime la
 * cadena de conexión.
 *
 * Salida: `0` el destino es migrable o ya está exacto · `1` negado o fallo.
 */
import {
  AUTORIZACIONES_DE_PRODUCTION,
  validarAutorizacionesDeProduction,
} from "../jobs/ops/autorizacion-de-production.ts";
import { sanearTexto } from "../jobs/ops/diagnostico.ts";
import { SQL_ESTADO_DEL_DESTINO } from "../jobs/pipelines/seed/carga.ts";
import { leerAnclaDelSeed } from "../jobs/pipelines/seed/ancla.ts";
import type { SesionDeMigracion } from "./migracion-destino.ts";
import {
  abrirSesion,
  decidirMigracion,
  describirDecision,
  leerEstadoParaMigrar,
  migracionesLocales,
} from "./migracion-destino.ts";
import { destinoDeProduction } from "./production-comun.ts";

const CON_NEON = "--con-neon";
const EN_SEED_REAL = "--en-seed-real";

async function principal(argumentos: readonly string[]): Promise<number> {
  if (argumentos.some((a) => a !== CON_NEON && a !== EN_SEED_REAL)) {
    console.error(`Uso: pnpm db:preflight:production [${CON_NEON}] [${EN_SEED_REAL}]`);
    return 1;
  }
  const conNeon = argumentos.includes(CON_NEON);
  const enSeedReal = argumentos.includes(EN_SEED_REAL);
  delete process.env.STREAMING_AVAILABILITY_API_KEY;

  console.log(
    `PREFLIGHT — ${enSeedReal ? "ENSAYO EN seed-real-v1-test" : "PRODUCTION"} · sin escrituras\n`,
  );
  let url: string;
  if (enSeedReal) {
    const { RAMA_DEL_SEED_REAL, verificarDestino } =
      await import("../drizzle.migrate.config.ts");
    const d = verificarDestino(process.env, [RAMA_DEL_SEED_REAL]);
    console.log(`  hostname          ${d.hostname}`);
    console.log(`  MIGRATION_TARGET  ${d.rama}`);
    url = d.url;
  } else {
    url = destinoDeProduction().url;
    console.log(`  variables         solo las de production (ninguna de validación)`);
  }

  const locales = migracionesLocales();
  console.log(
    `  migraciones       ${String(locales.length)} locales, exactamente 0000–0004`,
  );
  for (const m of locales) console.log(`      ${m.tag}  ${m.hash.slice(0, 12)}…`);

  validarAutorizacionesDeProduction(AUTORIZACIONES_DE_PRODUCTION);
  const porOperacion = (op: string) =>
    AUTORIZACIONES_DE_PRODUCTION.filter((a) => a.operacion === op).length;
  console.log(
    `  autorizaciones    migrar ${String(porOperacion("migrar"))} · cargar ${String(porOperacion("cargar"))} · primer_deltas ${String(porOperacion("primer_deltas"))}` +
      (AUTORIZACIONES_DE_PRODUCTION.length === 0
        ? " (ninguna: production no se escribe)"
        : ""),
  );

  if (!conNeon) {
    console.log(
      `\n  Sin contacto con Neon. Con UNA transacción de solo lectura: ${CON_NEON}`,
    );
    return 0;
  }

  let sesion: SesionDeMigracion | null = null;
  try {
    sesion = await abrirSesion(url);
    const e = sesion.ejecutor;
    await e.ejecutar("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      const [info] = await e.ejecutar<{ version: string; base: string; ahora: string }>(
        "SELECT current_setting('server_version') AS version, current_database() AS base, now()::text AS ahora",
      );
      console.log(
        `\n  PostgreSQL        ${info?.version ?? "?"} · base ${info?.base ?? "?"}`,
      );
      console.log(`  now() servidor    ${info?.ahora ?? "?"}`);
      const estado = await leerEstadoParaMigrar(e);
      console.log(
        `  tablas en public  ${estado.tablasPublicas.join(", ") || "(ninguna)"}`,
      );
      console.log(`  migraciones       ${String(estado.aplicadas.length)} aplicadas`);
      const decision = decidirMigracion(estado, locales);
      console.log(`  decisión          ${describirDecision(decision)}`);

      if (decision.tipo === "nada") {
        const [f] = await e.ejecutar<Record<string, unknown>>(SQL_ESTADO_DEL_DESTINO);
        console.log(
          `  catálogo          títulos ${String(f?.titulos)} · ofertas ${String(f?.ofertas)} · eventos ` +
            `${String(f?.eventos)} · anuncios ${String(f?.anuncios)} · filas de escritores ${String(f?.escritores)}`,
        );
        const ancla = await leerAnclaDelSeed(e);
        console.log(
          `  ancla del seed    ${ancla === null ? "ninguna" : `S = ${ancla.ancla.toISOString()} · crudo ${ancla.checkpoint.huella}`}`,
        );
      }
      return decision.tipo === "negada" ? 1 : 0;
    } finally {
      await e.ejecutar("ROLLBACK");
    }
  } finally {
    await sesion?.cerrar();
  }
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
