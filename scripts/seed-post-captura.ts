/**
 * `pnpm seed:post-captura <crudo>` (pasos 1–5) y
 * `pnpm seed:post-captura <crudo> --primer-deltas` (pasos 6–8) — el flujo
 * posterior a la captura en la rama del seed real (ADR 0009 §9), **paso a paso
 * y parando en el primero que falle**. Separados porque la carga solo se
 * repite sobre un destino sin escritores: una vez corrido `deltas`, volver a
 * cargar se niega (`catalogo_ya_mantenido`).
 *
 *   1. `seed:verificar`           crudo íntegro y cargable (0 API, sin base)
 *   2. `seed:archivar --comprobar` dos copias verificadas, una fuera del equipo
 *   3. `seed:cargar --ensayo`      la carga entera en `ROLLBACK` (0 API)
 *   4. `seed:cargar --real`        una transacción; el ancla, su última sentencia (0 API)
 *   5. `seed:validar`              huella canónica PostgreSQL == crudo; ancla; bootstrap pendiente
 *   ── `--primer-deltas` (**gasta cuota** de `deltas`, tope 4) ──
 *   6. `seed:primer-deltas --real` `[S, ahora]`; si corta por tope, se relanza
 *                                  —reanuda su checkpoint— hasta 3 veces
 *   7. `seed:validar:primer-deltas` `from === S`, continuidad, **bootstrap
 *                                  completo** y `expiring`/`upcoming`/`updated` ya arrancan
 *   8. `seed:m4`                   el margen de 1 h: refutado bloquea `production`
 *
 * Cada paso es el script de siempre, en su propio proceso, con el entorno de
 * esta sesión: las guardas de cada uno siguen mandando. Todo antes de `S + 72 h`.
 *
 * Salida: `0` todo bien · el código del paso que falló, si falla alguno.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { RAIZ } from "./seed-referencias.ts";

const MAXIMO_DE_PRIMEROS_DELTAS = 3;

function paso(titulo: string, script: string, args: readonly string[]): number {
  console.log(`\n━━ ${titulo} ━━ ${script} ${args.join(" ")}`);
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", join(RAIZ, "scripts", script), ...args],
    {
      stdio: "inherit",
      env: process.env,
      cwd: RAIZ,
    },
  );
  return r.status ?? 1;
}

function directoriosDePrimerDeltas(): Set<string> {
  const base = join(RAIZ, ".deltas-runs");
  if (!existsSync(base)) return new Set();
  return new Set(
    readdirSync(base)
      .filter(
        (d) => d.endsWith("-primer-deltas") && statSync(join(base, d)).isDirectory(),
      )
      .map((d) => join(base, d)),
  );
}

function principal(argumentos: readonly string[]): number {
  const crudo = argumentos[0];
  if (argumentos.some((x) => x.trim() === "")) {
    console.error("Una ruta vacía resolvería al directorio actual: se niega.");
    return 1;
  }
  const primerDeltas = argumentos[1] === "--primer-deltas";
  if (
    crudo === undefined ||
    argumentos.length > 2 ||
    (argumentos.length === 2 && !primerDeltas)
  ) {
    console.error("Uso: pnpm seed:post-captura <crudo> [--primer-deltas]");
    return 1;
  }
  const dir = resolve(crudo);
  if (!primerDeltas) {
    const pasos: [string, string, string[]][] = [
      ["1 · verificar", "seed-verificar.ts", [dir]],
      ["2 · copias", "seed-archivar.ts", ["--comprobar", dir]],
      ["3 · carga en ensayo", "seed-cargar.ts", ["--ensayo", dir]],
      ["4 · carga real", "seed-cargar.ts", ["--real", dir]],
      ["5 · validar carga", "seed-validar.ts", [dir]],
    ];
    for (const [t, s, a] of pasos) {
      const c = paso(t, s, a);
      if (c !== 0) {
        console.log(`\n❌ Parado en «${t}» (exit ${String(c)}).`);
        return c;
      }
    }
    console.log(
      "\n✅ Cargado y validado. Siguiente, con autorización (gasta cuota de deltas) y antes de S + 72 h:\n" +
        `   pnpm seed:post-captura ${crudo} --primer-deltas`,
    );
    return 0;
  }

  // Antes de gastar nada: el crudo sigue íntegro.
  const verificado = paso("verificar", "seed-verificar.ts", [dir]);
  if (verificado !== 0) return verificado;
  let validacion = 1;
  for (let i = 1; i <= MAXIMO_DE_PRIMEROS_DELTAS; i++) {
    const c = paso(`6 · primer deltas (${String(i)})`, "seed-primer-deltas.ts", [
      "--real",
    ]);
    if (c !== 0) {
      console.log(`\n❌ El primer deltas terminó con exit ${String(c)}.`);
      return c;
    }
    validacion = paso("7 · validar primer deltas", "seed-validar.ts", [
      "--primer-deltas",
      dir,
    ]);
    if (validacion !== 4) break; // 4 = continuidad bien, bootstrap aún incompleto
  }
  if (validacion !== 0) {
    console.log(
      `\n❌ El primer deltas no completó el bootstrap (exit ${String(validacion)}).`,
    );
    return validacion;
  }
  // Todos los primeros deltas de esta rama posteriores a la captura: también los
  // de una invocación anterior que cortó por tope.
  const T1 = Date.parse(
    (
      JSON.parse(readFileSync(join(dir, "manifiesto.json"), "utf8")) as {
        cierre: { T1: string };
      }
    ).cierre.T1,
  );
  const nuevos = [...directoriosDePrimerDeltas()]
    .filter((d) => statSync(d).mtimeMs >= T1)
    .sort();
  const m4 = paso("8 · M4", "seed-m4.ts", [dir, ...nuevos]);
  if (m4 !== 0) {
    console.log(
      "\n⛔ M4 REFUTA el margen de 1 h: este crudo NO va a production con este ancla.",
    );
    return m4;
  }
  console.log(
    "\n✅ Bootstrap de la rama del seed real completo: carga, primer deltas desde S y M4. " +
      "expiring, upcoming y updated ya pueden arrancar en ella.\n" +
      "   Recibo de aceptación y M4 al lado del crudo: la compuerta de production ya puede leerlos.\n" +
      "   Siguiente, con autorización y antes de S + 72 h: el bloque de production (docs/OPERATIONS.md).",
  );
  return 0;
}

process.exitCode = principal(process.argv.slice(2));
