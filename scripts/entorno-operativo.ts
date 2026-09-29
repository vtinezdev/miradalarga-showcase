/**
 * **El entorno de un comando operativo, construido y no heredado.**
 *
 * Los comandos que conectan con Neon o gastan cuota leen sus credenciales de
 * `process.env`. Heredarlas de la sesión es frágil: una terminal de ayer con
 * las variables de la rama histórica, una clave de la API que nadie pidió, un
 * `STREAMING_API_*` olvidado. Este módulo construye el entorno del proceso
 * hijo **desde cero** para un perfil y un comando concretos:
 *
 *   1. **Limpia** lo heredado: toda variable de destino (validación y
 *      `production`), la credencial de la API, los overrides `STREAMING_API_*`,
 *      `SPIKE_*`, `DATABASE_URL` y las `PG*` de libpq. Nada de eso pasa.
 *   2. **Lee literalmente** los ficheros del perfil (`.ops-env/<perfil>.env` y,
 *      solo si el comando gasta cuota, `.ops-env/api.env`): `NOMBRE=valor`,
 *      sin comillas, sin `export`, sin expansión de `$`, sin escapes. **Nunca**
 *      `source` de bash: un `$` en una contraseña es un `$`.
 *   3. **Fail closed**: cada fichero admite exactamente sus variables —ni una
 *      más, ni una menos—, el perfil fija la rama (`MIGRATION_TARGET`) o
 *      `production`, y el comando tiene que estar en la lista cerrada de ese
 *      perfil. La credencial de la API solo llega a los comandos que la usan.
 *   4. **Nunca imprime un valor**: los errores citan línea y nombre; el
 *      resumen, nombres y el hostname (que los scripts ya muestran).
 *
 * Módulo **puro**: ni lee disco ni lanza procesos (lo hace `scripts/ops.ts`).
 * Las guardas de cada script (`verificarDestino`,
 * `verificarDestinoDeProduction`, las autorizaciones en código) siguen
 * mandando en el hijo: esto es una capa más, no un sustituto.
 */
import {
  VARIABLES_DE_PRODUCTION,
  VARIABLES_DE_VALIDACION,
  verificarDestinoDeProduction,
} from "../destino-production.ts";

/** La credencial de la API: vive sola en su fichero. */
export const VARIABLE_DE_LA_API = "STREAMING_AVAILABILITY_API_KEY";

/** Directorio de los ficheros, relativo a la raíz. Ignorado por git. */
export const DIRECTORIO_DEL_ENTORNO = ".ops-env";

/** Fichero de la credencial de la API. */
export const FICHERO_DE_LA_API = "api.env";

export type NombreDePerfil = "historica" | "seed-real" | "production" | "offline";

type Familia = "validacion" | "production" | "ninguna";

/** Cómo recibe un comando la credencial de la API. */
type UsoDeLaApi = "nunca" | "siempre" | { readonly conArgumento: string };

interface ComandoPermitido {
  readonly api: UsoDeLaApi;
  /** Argumento que TIENE que llevar (p. ej. `--en-seed-real`). */
  readonly exige?: string;
  /** Argumento que NO puede llevar. */
  readonly prohibe?: string;
}

interface Perfil {
  readonly familia: Familia;
  /** El fichero de destino, o `null` si el perfil no conecta con nada. */
  readonly fichero: string | null;
  /** `MIGRATION_TARGET` exacto (validación). */
  readonly rama?: string;
  readonly comandos: Readonly<Record<string, ComandoPermitido>>;
}

const NUNCA: ComandoPermitido = { api: "nunca" };

/**
 * ⚖️ **Los perfiles y sus comandos: lista cerrada.** Añadir uno es un diff
 * revisable. `seed-bootstrap-v1-test` no tiene perfil: es un ensayo cerrado.
 * `db:migrate:*` tampoco: `production` y `seed-real-v1-test` ya están migradas.
 */
export const PERFILES: Readonly<Record<NombreDePerfil, Perfil>> = {
  historica: {
    familia: "validacion",
    fichero: "historica.env",
    rama: "drizzle-schema-v1-test",
    comandos: {
      "db:preflight:validation": NUNCA,
      "db:validate:schema": NUNCA,
      "db:leer:sync-run": NUNCA,
      // Adaptador de lectura del catálogo: READ ONLY, 0 escrituras demostradas.
      "db:validate:catalogo": NUNCA,
      job: { api: "siempre" },
    },
  },
  "seed-real": {
    familia: "validacion",
    fichero: "seed-real.env",
    rama: "seed-real-v1-test",
    comandos: {
      "db:preflight:production": { api: "nunca", exige: "--en-seed-real" },
      "db:validate:schema": NUNCA,
      "db:leer:sync-run": NUNCA,
      "seed:capturar": { api: "siempre" },
      "seed:cargar": NUNCA,
      "seed:validar": NUNCA,
      "seed:validar:primer-deltas": NUNCA,
      "seed:primer-deltas": { api: "siempre" },
      "seed:post-captura": { api: { conArgumento: "--primer-deltas" } },
    },
  },
  production: {
    familia: "production",
    fichero: "production.env",
    comandos: {
      "db:preflight:production": { api: "nunca", prohibe: "--en-seed-real" },
      "db:validate:schema:production": NUNCA,
      "production:cargar": NUNCA,
      "production:validar": NUNCA,
      "production:huella": NUNCA,
      "production:primer-deltas": { api: "siempre" },
      "production:validar:primer-deltas": NUNCA,
    },
  },
  /** Sin destino ni credencial: para los comandos 0 API y sin base. */
  offline: {
    familia: "ninguna",
    fichero: null,
    comandos: {
      "seed:verificar": NUNCA,
      "seed:archivar": NUNCA,
      "seed:m4": NUNCA,
      "production:compuerta": NUNCA,
    },
  },
};

/** Las variables que cada familia admite en su fichero: exactamente estas. */
const VARIABLES_POR_FAMILIA: Readonly<Record<Familia, readonly string[]>> = {
  validacion: VARIABLES_DE_VALIDACION,
  production: VARIABLES_DE_PRODUCTION,
  ninguna: [],
};

/**
 * ¿Se elimina esta variable heredada? Todo lo que decide destino, credencial o
 * presupuesto. Lo demás (PATH, SystemRoot, npm_*…) pasa.
 */
export function esVariableSensible(nombre: string): boolean {
  const n = nombre.toUpperCase();
  return (
    (VARIABLES_DE_VALIDACION as readonly string[]).includes(n) ||
    (VARIABLES_DE_PRODUCTION as readonly string[]).includes(n) ||
    n === VARIABLE_DE_LA_API ||
    n === "DATABASE_URL" ||
    n.startsWith("STREAMING_API_") ||
    n.startsWith("SPIKE_") ||
    n.startsWith("PG") // libpq: PGHOST, PGPASSWORD, PGDATABASE…
  );
}

export class EntornoInvalido extends Error {
  override readonly name = "EntornoInvalido";
}

const NOMBRE = /^[A-Z][A-Z0-9_]*$/;

/** Marca de orden de bytes: `Out-File` de PowerShell la escribe. */
const BOM = String.fromCharCode(0xfeff);
const SALTO = String.fromCharCode(10);
const RETORNO = String.fromCharCode(13);

/**
 * **Lectura literal** de un fichero `NOMBRE=valor`. Admite líneas vacías y
 * comentarios que empiezan por `#`; nada más. El valor es exactamente lo que
 * sigue al primer `=`. Se niegan comillas, espacios en los bordes, `export`,
 * valores vacíos y nombres repetidos. **Los errores nunca incluyen el valor.**
 */
export function leerFicheroLiteral(
  texto: string,
  fichero: string,
): ReadonlyMap<string, string> {
  const variables = new Map<string, string>();
  const sinBom = texto.startsWith(BOM) ? texto.slice(1) : texto;
  const lineas = sinBom
    .split(SALTO)
    .map((l) => (l.endsWith(RETORNO) ? l.slice(0, -1) : l));
  lineas.forEach((linea, i) => {
    const donde = `${fichero}, línea ${String(i + 1)}`;
    if (linea.trim() === "" || linea.startsWith("#")) return;
    const igual = linea.indexOf("=");
    const nombre = igual === -1 ? "" : linea.slice(0, igual);
    if (!NOMBRE.test(nombre)) {
      throw new EntornoInvalido(
        `${donde}: se espera NOMBRE=valor (mayúsculas, sin espacios ni «export»).`,
      );
    }
    const valor = linea.slice(igual + 1);
    if (valor === "") throw new EntornoInvalido(`${donde}: ${nombre} vacía.`);
    if (valor.trim() !== valor) {
      throw new EntornoInvalido(`${donde}: ${nombre} con espacios en los bordes.`);
    }
    if (/^["'`]/.test(valor)) {
      throw new EntornoInvalido(
        `${donde}: ${nombre} entre comillas. La lectura es literal: sin comillas.`,
      );
    }
    if (variables.has(nombre)) {
      throw new EntornoInvalido(`${donde}: ${nombre} repetida.`);
    }
    variables.set(nombre, valor);
  });
  return variables;
}

/** Exactamente esas variables: ni una más, ni una menos. */
function exigirExactamente(
  leidas: ReadonlyMap<string, string>,
  esperadas: readonly string[],
  fichero: string,
): void {
  const sobran = [...leidas.keys()].filter((k) => !esperadas.includes(k));
  if (sobran.length > 0) {
    throw new EntornoInvalido(
      `${fichero} lleva variables que no le corresponden: ${sobran.join(", ")}. ` +
        "Cada fichero lleva solo las de su destino (fail closed ante mezclas).",
    );
  }
  const faltan = esperadas.filter((k) => !leidas.has(k));
  if (faltan.length > 0) {
    throw new EntornoInvalido(`${fichero}: faltan ${faltan.join(", ")}.`);
  }
}

export interface PeticionDeEntorno {
  readonly perfil: string;
  readonly comando: string;
  readonly argumentos: readonly string[];
  readonly heredado: Readonly<Record<string, string | undefined>>;
  /** Los ficheros ya leídos (texto), por nombre. Solo los que existan. */
  readonly ficheros: Readonly<Record<string, string>>;
}

export interface EntornoConstruido {
  readonly perfil: NombreDePerfil;
  readonly entorno: Readonly<Record<string, string>>;
  /** Nombres (nunca valores) de lo heredado que se ha quitado. */
  readonly eliminadas: readonly string[];
  /** Nombres de lo cargado desde los ficheros. */
  readonly cargadas: readonly string[];
  readonly conApi: boolean;
  /** Hostname del destino, o `null` si el perfil no conecta. */
  readonly hostname: string | null;
  /** Rama nombrada del destino, o `null`. */
  readonly destino: string | null;
}

/** Los ficheros que un comando necesita, en orden. */
export function ficherosNecesarios(
  perfil: NombreDePerfil,
  comando: string,
  argumentos: readonly string[],
): readonly string[] {
  const p = PERFILES[perfil];
  const c = p.comandos[comando];
  const f: string[] = [];
  if (p.fichero !== null) f.push(p.fichero);
  if (c !== undefined && usaLaApi(c, argumentos)) f.push(FICHERO_DE_LA_API);
  return f;
}

function usaLaApi(c: ComandoPermitido, argumentos: readonly string[]): boolean {
  if (c.api === "siempre") return true;
  if (c.api === "nunca") return false;
  return argumentos.includes(c.api.conArgumento);
}

export function esPerfil(nombre: string): nombre is NombreDePerfil {
  return Object.hasOwn(PERFILES, nombre);
}

/**
 * El entorno del hijo. Lanza `EntornoInvalido` ante cualquier duda, **antes**
 * de lanzar nada.
 */
export function construirEntorno(p: PeticionDeEntorno): EntornoConstruido {
  if (!esPerfil(p.perfil)) {
    throw new EntornoInvalido(
      `Perfil desconocido «${p.perfil}». Perfiles: ${Object.keys(PERFILES).join(", ")}.`,
    );
  }
  const perfil = PERFILES[p.perfil];
  const comando = Object.hasOwn(perfil.comandos, p.comando)
    ? perfil.comandos[p.comando]
    : undefined;
  if (comando === undefined) {
    throw new EntornoInvalido(
      `«${p.comando}» no está permitido en el perfil ${p.perfil}. ` +
        `Permitidos: ${Object.keys(perfil.comandos).join(", ")}.`,
    );
  }
  if (comando.exige !== undefined && !p.argumentos.includes(comando.exige)) {
    throw new EntornoInvalido(
      `En el perfil ${p.perfil}, «${p.comando}» exige ${comando.exige}.`,
    );
  }
  if (comando.prohibe !== undefined && p.argumentos.includes(comando.prohibe)) {
    throw new EntornoInvalido(
      `En el perfil ${p.perfil}, «${p.comando}» no admite ${comando.prohibe}.`,
    );
  }

  // 1 ─ Lo heredado, sin nada sensible.
  const entorno: Record<string, string> = {};
  const eliminadas: string[] = [];
  for (const [k, v] of Object.entries(p.heredado)) {
    if (v === undefined) continue;
    if (esVariableSensible(k)) eliminadas.push(k);
    else entorno[k] = v;
  }

  // 2 ─ Los ficheros, literales y exactos.
  const cargadas: string[] = [];
  const conApi = usaLaApi(comando, p.argumentos);
  const leer = (fichero: string, esperadas: readonly string[]): void => {
    const texto = p.ficheros[fichero];
    if (texto === undefined) {
      throw new EntornoInvalido(
        `Falta ${DIRECTORIO_DEL_ENTORNO}/${fichero}, necesario para ${p.comando}.`,
      );
    }
    const leidas = leerFicheroLiteral(texto, fichero);
    exigirExactamente(leidas, esperadas, fichero);
    for (const [k, v] of leidas) {
      entorno[k] = v;
      cargadas.push(k);
    }
  };
  if (perfil.fichero !== null) {
    leer(perfil.fichero, VARIABLES_POR_FAMILIA[perfil.familia]);
  }
  if (conApi) leer(FICHERO_DE_LA_API, [VARIABLE_DE_LA_API]);

  // 3 ─ Coherencia del destino con el perfil. El hijo vuelve a comprobarlo.
  let hostname: string | null = null;
  let destino: string | null = null;
  if (perfil.familia === "validacion") {
    if (entorno.MIGRATION_TARGET !== perfil.rama) {
      throw new EntornoInvalido(
        `${String(perfil.fichero)}: MIGRATION_TARGET no es «${String(perfil.rama)}», ` +
          `la rama del perfil ${p.perfil}.`,
      );
    }
    let url: URL;
    try {
      url = new URL(entorno.DATABASE_URL_DIRECT ?? "");
    } catch {
      throw new EntornoInvalido(
        `${String(perfil.fichero)}: DATABASE_URL_DIRECT no es una URL válida. (No se muestra.)`,
      );
    }
    if (url.hostname.includes("-pooler")) {
      throw new EntornoInvalido(
        `${String(perfil.fichero)}: conexión por el pooler; se exige directa.`,
      );
    }
    if (url.hostname !== entorno.NEON_VALIDATION_HOST) {
      throw new EntornoInvalido(
        `${String(perfil.fichero)}: el hostname de DATABASE_URL_DIRECT no es NEON_VALIDATION_HOST.`,
      );
    }
    hostname = url.hostname;
    destino = perfil.rama ?? null;
  } else if (perfil.familia === "production") {
    try {
      const d = verificarDestinoDeProduction(entorno);
      hostname = d.hostname;
      destino = d.rama;
    } catch (error) {
      // El mensaje de las guardas no lleva la URL; sí puede llevar el hostname.
      throw new EntornoInvalido(error instanceof Error ? error.message : String(error));
    }
  }

  // 4 ─ La credencial no puede estar dentro de lo que se conecta a la base.
  const clave = entorno[VARIABLE_DE_LA_API];
  if (clave !== undefined) {
    for (const k of cargadas) {
      if (k !== VARIABLE_DE_LA_API && (entorno[k] ?? "").includes(clave)) {
        throw new EntornoInvalido(`La credencial de la API aparece dentro de ${k}.`);
      }
    }
  }

  return {
    perfil: p.perfil,
    entorno,
    eliminadas: eliminadas.sort(),
    cargadas,
    conApi,
    hostname,
    destino,
  };
}

/**
 * El comando de `package.json`, como argumentos para `node --import tsx`.
 * Solo scripts `tsx <fichero> [args]`, sin comillas ni operadores de shell.
 */
export function argumentosDelScript(linea: string, comando: string): readonly string[] {
  const partes = linea.trim().split(/\s+/);
  if (partes[0] !== "tsx" || partes.length < 2 || /["'`&|;<>$]/.test(linea)) {
    throw new EntornoInvalido(
      `«${comando}» no es un script «tsx <fichero>» simple; no se lanza desde aquí.`,
    );
  }
  return partes.slice(1);
}
