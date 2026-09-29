/**
 * `pnpm db:migrate:production` — aplica `0000`–`0004` a **`production`**
 * (ADR 0010). **Escribe en `production`**: exige las guardas de
 * `destino-production.ts` y la autorización en código `migrar` hasta la
 * última migración del journal. Hoy esa autorización **no existe**.
 *
 * `pnpm db:migrate:production --en-seed-real` — **el mismo procedimiento**
 * contra `seed-real-v1-test`, derivada de `production` y en su mismo estado.
 * Es el ensayo del camino de `production` y, a la vez, la migración de la rama
 * limpia del seed real. Guardas de validación, solo esa rama.
 *
 * Pasos (`migracion-destino.ts`): guardas → migraciones locales exactas →
 * lectura del destino → decisión (virgen · exacta · negada) → migrador de
 * drizzle, todas en una transacción → relectura: exactamente `0000`–`0004`,
 * mismos hashes, las 15 tablas.
 *
 * Salida: `0` migrado o ya exacto · `1` negado o fallo. Después, siempre:
 * `db:validate:schema` y `db:validate:behavior` del mismo destino.
 */
import { sanearTexto } from "../jobs/ops/diagnostico.ts";
import type { SesionDeMigracion } from "./migracion-destino.ts";
import {
  abrirSesion,
  decidirMigracion,
  describirDecision,
  leerEstadoParaMigrar,
  migracionesLocales,
} from "./migracion-destino.ts";
import { destinoDeProduction } from "./production-comun.ts";
import { comprobarMigraciones, guardarInforme } from "./seed-comun.ts";

const EN_SEED_REAL = "--en-seed-real";

async function principal(argumentos: readonly string[]): Promise<number> {
  const enSeedReal = argumentos.includes(EN_SEED_REAL);
  if (argumentos.some((a) => a !== EN_SEED_REAL)) {
    console.error(`Uso: pnpm db:migrate:production [${EN_SEED_REAL}]`);
    return 1;
  }
  // La migración no necesita la credencial de la API.
  delete process.env.STREAMING_AVAILABILITY_API_KEY;
  const locales = migracionesLocales();
  const ultima = locales.at(-1)?.tag ?? "";

  console.log(
    `MIGRACIÓN — ${enSeedReal ? "ENSAYO EN seed-real-v1-test" : "PRODUCTION"}\n`,
  );
  let url: string;
  let destino: string;
  if (enSeedReal) {
    const { RAMA_DEL_SEED_REAL, verificarDestino } =
      await import("../drizzle.migrate.config.ts");
    const d = verificarDestino(process.env, [RAMA_DEL_SEED_REAL]);
    console.log(`  hostname          ${d.hostname}`);
    console.log(`  MIGRATION_TARGET  ${d.rama}`);
    url = d.url;
    destino = d.rama;
  } else {
    const d = destinoDeProduction({ operacion: "migrar", hastaMigracion: ultima });
    url = d.url;
    destino = d.rama;
  }
  console.log(`  migraciones       ${locales.map((m) => m.tag).join(", ")}\n`);

  let sesion: SesionDeMigracion | null = null;
  try {
    sesion = await abrirSesion(url);
    const e = sesion.ejecutor;
    const [info] = await e.ejecutar<{ version: string; base: string }>(
      "SELECT current_setting('server_version') AS version, current_database() AS base",
    );
    console.log(
      `  PostgreSQL        ${info?.version ?? "?"} · base ${info?.base ?? "?"}`,
    );

    const antes = await leerEstadoParaMigrar(e);
    const decision = decidirMigracion(antes, locales);
    console.log(`  antes             ${describirDecision(decision)}`);
    if (decision.tipo === "negada") return 1;

    if (decision.tipo === "aplicar") {
      const t = performance.now();
      await sesion.aplicar();
      console.log(
        `  ✅ aplicadas en una transacción (${String(Math.round(performance.now() - t))} ms)`,
      );
    }

    const despues = await leerEstadoParaMigrar(e);
    const final = decidirMigracion(despues, locales);
    const exactas = await comprobarMigraciones(e);
    const ok = final.tipo === "nada" && exactas.exactas;
    console.log(`  después           ${describirDecision(final)}`);
    console.log(
      `  ${ok ? "✅" : "❌"} exactamente 0000–0004, mismos hashes y created_at, 15 tablas` +
        (exactas.problemas.length > 0 ? ` — ${exactas.problemas.join("; ")}` : ""),
    );
    const ruta = guardarInforme(
      `migracion-${enSeedReal ? "seed-real" : "production"}`,
      {
        destino,
        postgres: info?.version ?? null,
        decisionInicial: decision,
        decisionFinal: final,
        migraciones: exactas,
        tablasAntes: antes.tablasPublicas,
        tablasDespues: despues.tablasPublicas,
        ok,
      },
    );
    console.log(`  informe: ${ruta}`);
    const sufijo = enSeedReal ? "" : ":production";
    console.log(
      `\n  Siguiente (mismo destino): pnpm db:validate:schema${sufijo} && pnpm db:validate:behavior${sufijo}`,
    );
    return ok ? 0 : 1;
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
