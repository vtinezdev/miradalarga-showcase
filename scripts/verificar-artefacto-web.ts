/**
 * **El artefacto de la web no lleva lo que la web no necesita** (docs/SECURITY.md).
 * Corre detrás de `vinext build` (`pnpm build`) y falla el build si:
 *
 *   1. `dist/server/.dev.vars` declara una variable **fuera de la lista de la
 *      web** (`CATALOGO_FUENTE`, `DATABASE_URL`, `REVALIDATE_SECRET`,
 *      `NEXT_PUBLIC_*`). Es el fichero que wrangler serializa para `pnpm
 *      preview`; 📏 llegó a llevar `STREAMING_AVAILABILITY_API_KEY`.
 *   2. `dist/client` —lo que se sirve a cualquiera— contiene el driver de la
 *      base, una cadena de conexión o el nombre de una credencial.
 *   3. **El valor** de alguna credencial de los jobs presente en los `.env*` de
 *      la raíz o en el entorno del proceso aparece en cualquier fichero de
 *      `dist/`. Se compara en memoria: **nunca se imprime un valor**, solo el
 *      nombre de la variable y el fichero.
 *
 * Además **avisa** (sin fallar) si un `.env*` de la raíz declara credenciales
 * de los jobs: vinext los carga en el `process.env` del build y de `pnpm dev`
 * (compatibilidad con Next), aunque ya no lleguen al Worker.
 *
 * Salida: 0 limpio · 1 alguna violación.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Lo único que el runtime de la web puede recibir. */
export const VARIABLES_DE_LA_WEB = [
  "CATALOGO_FUENTE",
  "DATABASE_URL",
  "REVALIDATE_SECRET",
];
const PREFIJO_PUBLICO = "NEXT_PUBLIC_";

/** Credenciales de los jobs: nunca en el entorno ni en el artefacto de la web. */
export const CREDENCIALES_DE_JOBS = [
  "STREAMING_AVAILABILITY_API_KEY",
  "DATABASE_URL_DIRECT",
  "PRODUCTION_DATABASE_URL_DIRECT",
];

/** Lo que nunca puede aparecer en el bundle del navegador. */
export const PROHIBIDO_EN_CLIENTE = [
  "@neondatabase/serverless",
  "drizzle-orm/neon-http",
  "DATABASE_URL",
  "STREAMING_AVAILABILITY_API_KEY",
  "CATALOGO_FUENTE",
  "postgresql://",
  "postgres://",
];

/** Los nombres de un fichero `NOMBRE=valor` (`.dev.vars`, `.env`). Solo nombres. */
export function nombresDeVariables(texto: string): string[] {
  return texto
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
    .map((l) =>
      l
        .replace(/^export\s+/, "")
        .split("=")[0]!
        .trim(),
    )
    .filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
}

function valoresDeVariables(texto: string): Map<string, string> {
  const mapa = new Map<string, string>();
  for (const linea of texto.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const l = linea.trim().replace(/^export\s+/, "");
    const igual = l.indexOf("=");
    if (l.startsWith("#") || igual <= 0) continue;
    const valor = l
      .slice(igual + 1)
      .trim()
      .replace(/^(['"`])(.*)\1$/, "$2");
    mapa.set(l.slice(0, igual).trim(), valor);
  }
  return mapa;
}

export function esVariableDeLaWeb(nombre: string): boolean {
  return VARIABLES_DE_LA_WEB.includes(nombre) || nombre.startsWith(PREFIJO_PUBLICO);
}

function ficheros(directorio: string): string[] {
  if (!existsSync(directorio)) return [];
  const salida: string[] = [];
  for (const entrada of readdirSync(directorio, { withFileTypes: true })) {
    const ruta = join(directorio, entrada.name);
    if (entrada.isDirectory()) salida.push(...ficheros(ruta));
    else if (statSync(ruta).size < 20_000_000) salida.push(ruta);
  }
  return salida;
}

export interface Informe {
  violaciones: string[];
  avisos: string[];
}

/**
 * La verificación, sobre una raíz dada (los tests la ejercitan en un
 * directorio temporal). `entorno` son las variables del proceso.
 */
export function verificarArtefacto(
  raiz: string,
  entorno: Readonly<Record<string, string | undefined>> = {},
): Informe {
  const violaciones: string[] = [];
  const avisos: string[] = [];
  const dist = join(raiz, "dist");
  const rel = (f: string) => relative(raiz, f).split("\\").join("/");

  if (!existsSync(dist)) {
    return { violaciones: ["No existe dist/: ejecuta el build antes."], avisos };
  }

  // 1 · Variables serializadas para el Worker. El cliente no lleva ninguna.
  if (existsSync(join(dist, "client", ".dev.vars"))) {
    violaciones.push("dist/client/.dev.vars existe: el cliente nunca lleva variables.");
  }
  const devVars = join(dist, "server", ".dev.vars");
  if (existsSync(devVars)) {
    const ajenas = nombresDeVariables(readFileSync(devVars, "utf8")).filter(
      (n) => !esVariableDeLaWeb(n),
    );
    if (ajenas.length > 0) {
      violaciones.push(
        `${rel(devVars)} declara variables que la web no usa: ${ajenas.join(", ")}.`,
      );
    }
  }

  // 2 · Marcadores prohibidos en el bundle del navegador.
  for (const f of ficheros(join(dist, "client"))) {
    const texto = readFileSync(f, "latin1");
    const encontrados = PROHIBIDO_EN_CLIENTE.filter((m) => texto.includes(m));
    if (encontrados.length > 0) {
      violaciones.push(`${rel(f)} (cliente) contiene: ${encontrados.join(", ")}.`);
    }
  }

  // 3 · El valor de una credencial de los jobs, en cualquier parte de dist/.
  const secretos = new Map<string, string>();
  const envs = readdirSync(raiz).filter(
    (n) => /^\.env(\..+)?$/.test(n) && n !== ".env.example",
  );
  for (const nombre of envs) {
    const valores = valoresDeVariables(readFileSync(join(raiz, nombre), "utf8"));
    const presentes = CREDENCIALES_DE_JOBS.filter((c) => valores.has(c));
    if (presentes.length > 0) {
      avisos.push(
        `${nombre} declara ${presentes.join(", ")}: vinext lo carga en el proceso del build y de \`pnpm dev\`. Muévelas a .ops-env/ (los jobs ya las leen de allí).`,
      );
    }
    for (const c of presentes) {
      const v = valores.get(c);
      if (v && v.length >= 8) secretos.set(`${c} (${nombre})`, v);
    }
  }
  for (const c of CREDENCIALES_DE_JOBS) {
    const v = entorno[c];
    if (v && v.length >= 8) secretos.set(`${c} (entorno)`, v);
  }
  if (secretos.size > 0) {
    for (const f of ficheros(dist)) {
      const texto = readFileSync(f, "latin1");
      for (const [nombre, valor] of secretos) {
        if (texto.includes(valor))
          violaciones.push(`${rel(f)} contiene el valor de ${nombre}.`);
      }
    }
  }

  return { violaciones, avisos };
}

function principal(): number {
  const { violaciones, avisos } = verificarArtefacto(process.cwd(), process.env);
  for (const a of avisos) console.warn(`⚠️  ${a}`);
  if (violaciones.length > 0) {
    console.error("\n❌ Artefacto de la web con lo que no debe llevar:");
    for (const v of violaciones) console.error(`   · ${v}`);
    return 1;
  }
  console.log(
    "✅ Artefacto de la web: sin credenciales de los jobs, sin driver ni cadenas de conexión en el cliente.",
  );
  return 0;
}

if (process.argv[1]?.endsWith("verificar-artefacto-web.ts")) {
  process.exitCode = principal();
}
