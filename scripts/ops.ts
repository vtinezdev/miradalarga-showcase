/**
 * `pnpm ops <perfil> <comando> [argumentos…]` — lanza un comando operativo con
 * un entorno **construido**, no heredado (`scripts/entorno-operativo.ts`).
 *
 *   pnpm ops seed-real  seed:capturar --real <plan> <dir M1>
 *   pnpm ops production db:preflight:production --con-neon
 *   pnpm ops offline    seed:archivar --comprobar <crudo>
 *
 * Los ficheros viven en `.ops-env/` (ignorado por git; nunca `.env`, que el
 * build copia a `dist/`): `historica.env`, `seed-real.env`, `production.env`
 * con sus tres variables cada uno, y `api.env` solo con la credencial. Se leen
 * literalmente; nunca se hace `source`.
 *
 * Antes de lanzar nada: el perfil y el comando están en la lista cerrada, los
 * ficheros existen, **git los ignora**, y cada uno lleva exactamente sus
 * variables. El hijo es `node --import tsx <script>` sin shell, con ese
 * entorno y ningún otro; sus propias guardas siguen mandando.
 *
 * Salida: la del hijo · `1` si el entorno no se puede construir (nada lanzado).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DIRECTORIO_DEL_ENTORNO,
  EntornoInvalido,
  PERFILES,
  argumentosDelScript,
  construirEntorno,
  esPerfil,
  ficherosNecesarios,
} from "./entorno-operativo.ts";
import { RAIZ } from "./seed-referencias.ts";

function ignoradoPorGit(ruta: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--no-index", ruta], {
      cwd: RAIZ,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function principal(argv: readonly string[]): number {
  const [perfil, comando, ...argumentos] = argv;
  if (perfil === undefined || comando === undefined || !esPerfil(perfil)) {
    console.error(
      "Uso: pnpm ops <perfil> <comando> [argumentos…]\n" +
        Object.entries(PERFILES)
          .map(([p, d]) => `  ${p.padEnd(11)} ${Object.keys(d.comandos).join(", ")}`)
          .join("\n"),
    );
    return 1;
  }

  const ficheros: Record<string, string> = {};
  for (const nombre of ficherosNecesarios(perfil, comando, argumentos)) {
    const ruta = join(RAIZ, DIRECTORIO_DEL_ENTORNO, nombre);
    if (!existsSync(ruta)) continue; // construirEntorno dice cuál falta
    if (!ignoradoPorGit(ruta)) {
      throw new EntornoInvalido(
        `${DIRECTORIO_DEL_ENTORNO}/${nombre} no está ignorado por git: no se lee.`,
      );
    }
    ficheros[nombre] = readFileSync(ruta, "utf8");
  }

  const e = construirEntorno({
    perfil,
    comando,
    argumentos,
    heredado: process.env,
    ficheros,
  });

  const scripts = (
    JSON.parse(readFileSync(join(RAIZ, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    }
  ).scripts;
  const linea = Object.hasOwn(scripts, comando) ? scripts[comando] : undefined;
  if (linea === undefined)
    throw new EntornoInvalido(`No existe el script «${comando}».`);
  const script = argumentosDelScript(linea, comando);

  console.log(`ops · perfil ${e.perfil} · ${comando} ${argumentos.join(" ")}`);
  if (e.destino !== null)
    console.log(`  destino    ${e.destino} (${String(e.hostname)})`);
  console.log(`  cargadas   ${e.cargadas.join(", ") || "(ninguna)"}`);
  console.log(`  API        ${e.conApi ? "sí (este comando la usa)" : "no"}`);
  console.log(`  eliminadas ${e.eliminadas.join(", ") || "(ninguna heredada)"}\n`);

  const r = spawnSync(process.execPath, ["--import", "tsx", ...script, ...argumentos], {
    cwd: RAIZ,
    // Solo este entorno: nada de la sesión que no haya pasado por la limpieza.
    env: { ...e.entorno } as NodeJS.ProcessEnv,
    stdio: "inherit",
  });
  if (r.error !== undefined) throw r.error;
  return r.status ?? 1;
}

try {
  process.exitCode = principal(process.argv.slice(2));
} catch (error) {
  console.error(
    `\nops: nada lanzado.\n  ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
