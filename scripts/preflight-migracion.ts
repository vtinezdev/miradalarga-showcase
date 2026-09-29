/**
 * Preflight de la migración de validación.
 *
 * Comprueba todo lo que se puede comprobar **sin escribir nada**, e imprime un
 * resumen deliberadamente pobre: hostname, si la conexión es directa, la rama
 * de destino y cuántas migraciones hay. **Nunca usuario, contraseña ni cadena
 * de conexión.**
 *
 *   pnpm db:preflight:validation              → solo local, sin red
 *   pnpm db:preflight:validation --con-neon   → añade UNA consulta de solo lectura
 *
 * La segunda forma es la única manera de saber cuántas migraciones están
 * **pendientes de verdad**, porque eso depende de lo que ya haya en la rama. No
 * escribe: lee `current_database()`, la versión del servidor y, si existe, la
 * tabla de migraciones aplicadas de Drizzle.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const RAIZ = join(import.meta.dirname, "..");
const DIRECTORIO_MIGRACIONES = join(RAIZ, "drizzle");

interface EntradaDeJournal {
  readonly idx: number;
  readonly tag: string;
}

function migracionesDeclaradas(): readonly EntradaDeJournal[] {
  const journal: unknown = JSON.parse(
    readFileSync(join(DIRECTORIO_MIGRACIONES, "meta", "_journal.json"), "utf8"),
  );
  return (journal as { entries: EntradaDeJournal[] }).entries;
}

function ficherosSql(): readonly string[] {
  return readdirSync(DIRECTORIO_MIGRACIONES)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

async function aplicadasEnNeon(url: string): Promise<number | null> {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(url);

  const existe = (await sql`
    SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS existe
  `) as unknown as readonly { existe: boolean }[];

  if (existe[0]?.existe !== true) return 0;

  const filas = (await sql`
    SELECT count(*)::int AS total FROM drizzle.__drizzle_migrations
  `) as unknown as readonly { total: number }[];

  return filas[0]?.total ?? 0;
}

async function principal(): Promise<void> {
  const conNeon = process.argv.includes("--con-neon");

  // Import dinámico a propósito: el módulo corre sus guardas **al cargarse**,
  // igual que se las corre a drizzle-kit. Importándolo aquí dentro, un fallo de
  // guarda llega al `catch` de abajo y se imprime como un mensaje legible en
  // vez de como un volcado de pila.
  // Solo lectura (o sin COMMIT): admite también la rama del seed, para validar
  // que sus migraciones dejan el esquema v1 exacto (ADR 0009 §9).
  const { RAMAS_DE_VALIDACION, verificarDestino } =
    await import("../drizzle.migrate.config.ts");
  const destino = verificarDestino(process.env, RAMAS_DE_VALIDACION);

  const declaradas = migracionesDeclaradas();
  const sql = ficherosSql();

  // 0002: checkpoint (ADR 0006) · 0003: anuncios de disponibilidad (ADR 0007)
  // · 0004: `external_titles.imdb_id` no vacío.
  const esperadas = ["0000", "0001", "0002", "0003", "0004"];
  for (const prefijo of esperadas) {
    if (!sql.some((f) => f.startsWith(prefijo))) {
      throw new Error(`Falta la migración ${prefijo}_*.sql`);
    }
    if (!declaradas.some((e) => e.tag.startsWith(prefijo))) {
      throw new Error(`El journal no registra la migración ${prefijo}`);
    }
  }
  if (declaradas.length !== sql.length) {
    throw new Error(
      `Descuadre: ${sql.length} ficheros .sql y ${declaradas.length} entradas en el journal.`,
    );
  }

  console.log("PREFLIGHT DE MIGRACIÓN — rama de validación\n");
  console.log(`  hostname            ${destino.hostname}`);
  console.log(`  conexión directa    sí (sin "-pooler")`);
  console.log(`  MIGRATION_TARGET    ${destino.rama}`);
  console.log(`  migraciones locales ${declaradas.length}`);
  for (const entrada of declaradas) {
    console.log(`      ${String(entrada.idx).padStart(4, "0")}  ${entrada.tag}`);
  }

  if (!conNeon) {
    console.log(`  pendientes          ${declaradas.length} (supuesto: rama vacía)`);
    console.log(
      `\n  Sin contacto con Neon. Para confirmarlo con UNA consulta de solo lectura:` +
        `\n      pnpm db:preflight:validation --con-neon`,
    );
    return;
  }

  const aplicadas = await aplicadasEnNeon(destino.url);
  const pendientes = declaradas.length - (aplicadas ?? 0);
  console.log(`  aplicadas en la rama ${aplicadas ?? "?"}`);
  console.log(`  pendientes          ${pendientes}`);
  if (pendientes !== declaradas.length) {
    console.log(
      `\n  ⚠️  La rama NO está vacía: ya tiene ${aplicadas ?? "?"} migración(es) aplicada(s).`,
    );
  }
}

principal().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
