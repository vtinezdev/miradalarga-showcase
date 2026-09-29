/**
 * Checkpoint final de la Fase 1: **los datos reales del Spike 1 entran en el
 * modelo v1, y la carga es idempotente.**
 *
 *   pnpm db:validate:import            carga 1 · carga 2 · comparación · limpieza
 *   pnpm db:validate:import --limpiar  solo la limpieza, para recuperar un fallo
 *
 * Esto es un **harness**, no un segundo pipeline: la lectura, la normalización
 * y el upsert viven en `jobs/pipelines/seed/`, que es el embrión del seed de la
 * Fase 2. Si el harness normalizara por su cuenta, no probaría nada sobre la
 * ingesta de verdad.
 *
 * ── Por qué hay COMMIT ─────────────────────────────────────────────────────
 *
 * Los otros validadores nunca confirman. Aquí **hay que confirmar**: demostrar
 * idempotencia exige que la segunda pasada vea el estado que dejó la primera.
 * Dentro de una sola transacción, la segunda pasada leería su propia escritura
 * y el experimento no probaría nada.
 *
 * La contrapartida es honesta y está asumida: **si el proceso muere después de
 * un COMMIT, queda estado de prueba en la rama de validación**. El script lo
 * dice con todas las letras y deja el comando de recuperación. Nunca lo oculta.
 *
 * **Cero llamadas a la API.** Solo `spike-1/raw/` en disco.
 * **Nunca se descarga una imagen:** solo referencias. Copiar a R2 es trabajo
 * del pipeline de imágenes, que todavía no existe.
 */
import { Client, neonConfig } from "@neondatabase/serverless";

import type { EjecutorSql, InformeDeSeed } from "../jobs/pipelines/seed/contratos.ts";
import {
  construirFilas,
  ejecutarSeed,
  leerCorpusSpike1,
  type FilasDeSeed,
} from "../jobs/pipelines/seed/index.ts";
import { PLATAFORMAS_MVP } from "../jobs/pipelines/seed/plataformas.ts";

const RAIZ_SPIKE = "spike-1";

/** Recuentos que el corpus debe producir. Medidos, no supuestos. */
const ESPERADO = {
  external_genres: 21,
  external_platforms: 6,
  external_titles: 764,
  external_title_genres: 1633,
  external_title_images: 13515,
  external_availability: 1837,
  external_availability_options: 2218,
} as const;

const DESCARTES_ESPERADOS = 21;
const OPCIONES_DEL_CORPUS = 2239;

/** Orden inverso de dependencias. Las FK RESTRICT no admiten otro. */
const ORDEN_DE_BORRADO = [
  "external_availability_options",
  "external_availability",
  "external_title_genres",
  "external_title_images",
  "external_titles",
  "external_genres",
  "external_platforms",
] as const;

let fallos = 0;
let pruebas = 0;

function bien(d: string): void {
  pruebas++;
  console.log(`  ✅ ${d}`);
}
function mal(d: string, esperado: string, observado: string): void {
  pruebas++;
  fallos++;
  console.log(`  ❌ ${d} — esperado ${esperado}, observado ${observado}`);
}
function seccion(t: string): void {
  console.log(`\n${t}`);
}
function sanearCredenciales(m: string): string {
  return m
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "<cadena de conexión redactada>")
    .replace(/(['"])[^'"]*\1/g, "'<redactado>'");
}

function avisoDeEstadoResidual(): void {
  console.error(
    "\n⚠️  PUEDE HABER QUEDADO ESTADO DE PRUEBA EN drizzle-schema-v1-test.\n" +
      "    La estrategia confirma cada pasada, así que un fallo posterior a un\n" +
      "    COMMIT deja filas escritas. No se oculta: límpialas con\n" +
      "\n        pnpm db:validate:import --limpiar\n",
  );
}

async function principal(): Promise<void> {
  const soloLimpieza = process.argv.includes("--limpiar");

  // Las mismas guardas que la migración: directa sin -pooler, hostname exacto
  // y MIGRATION_TARGET. `production` es inalcanzable por construcción.
  const { verificarDestino } = await import("../drizzle.migrate.config.ts");
  const destino = verificarDestino();

  if (typeof WebSocket === "undefined") {
    throw new Error("Este Node no expone WebSocket global, y hace falta sesión real.");
  }
  neonConfig.webSocketConstructor = WebSocket;

  console.log("VALIDACIÓN DE IMPORTACIÓN DEL CORPUS DEL SPIKE 1\n");
  console.log(`  hostname          ${destino.hostname}`);
  console.log(`  conexión directa  sí (sin "-pooler")`);
  console.log(`  MIGRATION_TARGET  ${destino.rama}`);
  console.log(`  origen            ${RAIZ_SPIKE}/raw · cero llamadas a la API`);

  // ── Lectura y normalización, todo offline ────────────────────────────────
  seccion("1 · Corpus leído de disco");
  const corpus = leerCorpusSpike1(RAIZ_SPIKE);
  const filas = construirFilas(corpus.titulos);
  const d = corpus.diagnostico;
  console.log(
    `  ${String(d.ficherosLeidos)} ficheros · ${String(d.showsBrutos)} shows brutos ·` +
      ` ${String(d.titulosUnicos)} títulos únicos · ${String(d.opcionesEs)} opciones ES`,
  );
  if (d.showsRechazadosPorSchema > 0) {
    mal(
      "todo show del crudo pasa el schema del proveedor",
      "0 rechazos",
      `${String(d.showsRechazadosPorSchema)} rechazados`,
    );
  } else {
    bien("todo show del crudo pasa el schema del proveedor");
  }

  const cliente = new Client(destino.url);
  cliente.on("error", () => undefined);
  try {
    await cliente.connect();
  } catch (error) {
    const m = error instanceof Error ? error.message : String(error);
    throw new Error(`No se pudo abrir sesión: ${sanearCredenciales(m)}`);
  }

  const ejecutor: EjecutorSql = {
    async ejecutar<T>(texto: string, valores: readonly unknown[] = []) {
      const r: { rows: unknown[] } = await cliente.query(texto, [...valores]);
      return r.rows as readonly T[];
    },
  };

  async function contar(tabla: string): Promise<number> {
    const r = await ejecutor.ejecutar<{ total: number }>(
      `SELECT count(*)::int AS total FROM ${tabla}`,
    );
    return r[0]?.total ?? -1;
  }

  async function contarTodo(): Promise<Record<string, number>> {
    const salida: Record<string, number> = {};
    for (const t of ORDEN_DE_BORRADO) salida[t] = await contar(t);
    return salida;
  }

  /** Borra exactamente lo que este corpus introduce. Nada más. */
  async function limpiar(f: FilasDeSeed): Promise<Record<string, number>> {
    const imdbIds = f.titulos.map((t) => t.imdbId);
    const generoIds = f.generos.map((g) => g.id);
    const plataformaIds = PLATAFORMAS_MVP.map((p) => p.id);
    const borradas: Record<string, number> = {};

    const borrar = async (tabla: string, texto: string, valores: unknown[]) => {
      const r = await ejecutor.ejecutar<{ id: unknown }>(
        `${texto} RETURNING 1 AS id`,
        valores,
      );
      borradas[tabla] = r.length;
    };

    await borrar(
      "external_availability_options",
      `DELETE FROM external_availability_options WHERE availability_id IN (
         SELECT a.id FROM external_availability a
         JOIN external_titles t ON t.id = a.title_id WHERE t.imdb_id = ANY($1))`,
      [imdbIds],
    );
    await borrar(
      "external_availability",
      `DELETE FROM external_availability WHERE title_id IN (
         SELECT id FROM external_titles WHERE imdb_id = ANY($1))`,
      [imdbIds],
    );
    await borrar(
      "external_title_genres",
      `DELETE FROM external_title_genres WHERE title_id IN (
         SELECT id FROM external_titles WHERE imdb_id = ANY($1))`,
      [imdbIds],
    );
    await borrar(
      "external_title_images",
      `DELETE FROM external_title_images WHERE title_id IN (
         SELECT id FROM external_titles WHERE imdb_id = ANY($1))`,
      [imdbIds],
    );
    await borrar(
      "external_titles",
      `DELETE FROM external_titles WHERE imdb_id = ANY($1)`,
      [imdbIds],
    );
    await borrar("external_genres", `DELETE FROM external_genres WHERE id = ANY($1)`, [
      generoIds,
    ]);
    await borrar(
      "external_platforms",
      `DELETE FROM external_platforms WHERE id = ANY($1)`,
      [plataformaIds],
    );
    return borradas;
  }

  if (soloLimpieza) {
    seccion("Limpieza explícita");
    const borradas = await limpiar(filas);
    for (const t of ORDEN_DE_BORRADO)
      console.log(`  ${t.padEnd(32)} ${String(borradas[t] ?? 0)} borradas`);
    const resto = await contarTodo();
    const sucias = Object.entries(resto).filter(([, n]) => n !== 0);
    if (sucias.length === 0) bien("las siete tablas quedan vacías");
    else
      mal(
        "las siete tablas quedan vacías",
        "0 filas",
        sucias.map(([t, n]) => `${t}=${String(n)}`).join(", "),
      );
    await cliente.end();
    console.log(
      fallos === 0 ? "\n✅ Limpieza completada." : "\n❌ La limpieza dejó filas.",
    );
    if (fallos > 0) process.exitCode = 1;
    return;
  }

  let hayEstadoConfirmado = false;

  try {
    // ── Punto de partida ───────────────────────────────────────────────────
    seccion("2 · Estado inicial de la rama");
    const inicial = await contarTodo();
    const noVacias = Object.entries(inicial).filter(([, n]) => n !== 0);
    if (noVacias.length === 0) {
      bien("las siete tablas del modelo están vacías antes de empezar");
    } else {
      mal(
        "las siete tablas están vacías antes de empezar",
        "0 filas",
        noVacias.map(([t, n]) => `${t}=${String(n)}`).join(", "),
      );
    }

    // ── Pasada 1 ───────────────────────────────────────────────────────────
    seccion("3 · Primera carga");
    await ejecutor.ejecutar("BEGIN");
    let informe1: InformeDeSeed;
    try {
      informe1 = await ejecutarSeed(ejecutor, filas);
      await ejecutor.ejecutar("COMMIT");
      hayEstadoConfirmado = true;
    } catch (error) {
      await ejecutor.ejecutar("ROLLBACK");
      throw error;
    }
    imprimirInforme(informe1);

    const tras1 = await contarTodo();
    for (const [tabla, esperado] of Object.entries(ESPERADO)) {
      const obtenido = tras1[tabla] ?? -1;
      if (obtenido === esperado) bien(`${tabla}: ${String(esperado)} filas`);
      else mal(`${tabla}`, `${String(esperado)} filas`, `${String(obtenido)}`);
    }

    // ── Invariantes de contenido ───────────────────────────────────────────
    seccion("4 · Invariantes del modelo sobre los datos cargados");
    await comprobarInvariantes(ejecutor, filas);

    // ── Pasada 2, idéntica ─────────────────────────────────────────────────
    seccion("5 · Segunda carga, byte a byte la misma");
    await ejecutor.ejecutar("BEGIN");
    let informe2: InformeDeSeed;
    try {
      informe2 = await ejecutarSeed(ejecutor, filas);
      await ejecutor.ejecutar("COMMIT");
    } catch (error) {
      await ejecutor.ejecutar("ROLLBACK");
      throw error;
    }
    imprimirInforme(informe2);

    // ── El veredicto ───────────────────────────────────────────────────────
    seccion("6 · Idempotencia");
    const tras2 = await contarTodo();
    const mismosRecuentos = ORDEN_DE_BORRADO.every((t) => tras1[t] === tras2[t]);
    if (mismosRecuentos) bien("los recuentos no cambian tras la segunda carga");
    else
      mal(
        "los recuentos no cambian tras la segunda carga",
        JSON.stringify(tras1),
        JSON.stringify(tras2),
      );

    const insertadasEn2 = informe2.tablas.filter((t) => t.insertadas > 0);
    if (insertadasEn2.length === 0)
      bien("la segunda carga no inserta ni una fila nueva");
    else
      mal(
        "la segunda carga no inserta ni una fila nueva",
        "0 inserciones",
        insertadasEn2.map((t) => `${t.tabla}=${String(t.insertadas)}`).join(", "),
      );

    const idsTituloEstables =
      informe1.idsDeTitulo.size === informe2.idsDeTitulo.size &&
      [...informe1.idsDeTitulo].every(([k, v]) => informe2.idsDeTitulo.get(k) === v);
    if (idsTituloEstables)
      bien(`los ${String(informe1.idsDeTitulo.size)} ids de título no cambian`);
    else mal("los ids de título no cambian", "idénticos", "alguno cambió");

    const idsOfertaEstables =
      informe1.idsDeOferta.size === informe2.idsDeOferta.size &&
      [...informe1.idsDeOferta].every(([k, v]) => informe2.idsDeOferta.get(k) === v);
    if (idsOfertaEstables)
      bien(`los ${String(informe1.idsDeOferta.size)} ids de oferta no cambian`);
    else mal("los ids de oferta no cambian", "idénticos", "alguno cambió");

    // ── Nada se perdió por el camino ───────────────────────────────────────
    seccion("7 · Ninguna opción del corpus desaparece en silencio");
    const cuadra =
      filas.opciones.length + filas.descartes.length === OPCIONES_DEL_CORPUS;
    if (cuadra)
      bien(
        `${String(OPCIONES_DEL_CORPUS)} opciones = ${String(filas.opciones.length)} cargadas + ${String(filas.descartes.length)} descartadas`,
      );
    else
      mal(
        "toda opción está cargada o descartada con motivo",
        `${String(OPCIONES_DEL_CORPUS)}`,
        `${String(filas.opciones.length)} + ${String(filas.descartes.length)}`,
      );

    if (filas.descartes.length === DESCARTES_ESPERADOS)
      bien(
        `${String(DESCARTES_ESPERADOS)} descartes, todos por plataforma fuera del MVP`,
      );
    else
      mal(
        "descartes",
        `${String(DESCARTES_ESPERADOS)}`,
        `${String(filas.descartes.length)}`,
      );

    const porPlataforma = new Map<string, number>();
    for (const x of filas.descartes)
      porPlataforma.set(x.plataforma, (porPlataforma.get(x.plataforma) ?? 0) + 1);
    for (const [p, n] of [...porPlataforma].sort((a, b) => b[1] - a[1])) {
      console.log(`     ℹ️  ${p}: ${String(n)} opciones descartadas`);
    }

    const colapsos = [...informe1.tablas].filter((t) => t.colapsadas > 0);
    if (colapsos.length === 0)
      bien("ninguna clave natural colapsa dos filas distintas");
    else
      mal(
        "ninguna clave natural colapsa dos filas distintas",
        "0 colapsos",
        colapsos.map((t) => `${t.tabla}=${String(t.colapsadas)}`).join(", "),
      );
  } finally {
    // ── Limpieza, siempre ──────────────────────────────────────────────────
    seccion("8 · Limpieza y rastro");
    try {
      const borradas = await limpiar(filas);
      for (const t of ORDEN_DE_BORRADO) {
        console.log(`     ${t.padEnd(32)} ${String(borradas[t] ?? 0)} borradas`);
      }
      const resto = await contarTodo();
      const sucias = Object.entries(resto).filter(([, n]) => n !== 0);
      if (sucias.length === 0) bien("rastro cero: las siete tablas quedan vacías");
      else
        mal(
          "rastro cero",
          "0 filas",
          sucias.map(([t, n]) => `${t}=${String(n)}`).join(", "),
        );
      hayEstadoConfirmado = false;
    } catch (error) {
      const m = error instanceof Error ? error.message : String(error);
      console.error(`  ❌ la limpieza falló: ${sanearCredenciales(m)}`);
      fallos++;
    }
    if (hayEstadoConfirmado) avisoDeEstadoResidual();
    await cliente.end();
  }

  console.log("");
  if (fallos === 0)
    console.log(`✅ ${String(pruebas)} comprobaciones, todas correctas.`);
  else {
    console.log(`❌ ${String(fallos)} de ${String(pruebas)} comprobaciones fallaron.`);
    process.exitCode = 1;
  }
}

function imprimirInforme(informe: InformeDeSeed): void {
  console.log(
    "     tabla                            intentadas  insert.  actual.  ignor.",
  );
  for (const t of informe.tablas) {
    console.log(
      `     ${t.tabla.padEnd(32)} ${String(t.intentadas).padStart(10)} ${String(t.insertadas).padStart(8)} ${String(t.actualizadas).padStart(8)} ${String(t.ignoradas).padStart(7)}`,
    );
  }
}

async function comprobarInvariantes(
  ejecutor: EjecutorSql,
  filas: FilasDeSeed,
): Promise<void> {
  const uno = async (sql: string): Promise<number> => {
    const r = await ejecutor.ejecutar<{ n: number }>(sql);
    return r[0]?.n ?? -1;
  };

  const ceros = await uno(
    `SELECT count(*)::int AS n FROM external_titles WHERE rating = 0`,
  );
  if (ceros === 0)
    bien("ningún título con rating 0: el CHECK y el adaptador coinciden");
  else mal("ningún título con rating 0", "0", String(ceros));

  const fuera = await uno(
    `SELECT count(*)::int AS n FROM external_availability
      WHERE platform_id NOT IN ('netflix','prime','disney','max','apple','skyshowtime')`,
  );
  if (fuera === 0) bien("ninguna oferta apunta a una plataforma fuera del MVP");
  else mal("ninguna oferta fuera del MVP", "0", String(fuera));

  const hbo = await uno(
    `SELECT count(*)::int AS n FROM external_availability WHERE platform_id = 'hbo'`,
  );
  if (hbo === 0)
    bien("la trampa hbo → max está resuelta: no hay ofertas con platform_id 'hbo'");
  else mal("hbo → max", "0 ofertas con 'hbo'", String(hbo));

  const maxSource = await uno(
    `SELECT count(*)::int AS n FROM external_platforms WHERE id = 'max' AND source_id = 'hbo'`,
  );
  if (maxSource === 1) bien("la plataforma 'max' conserva 'hbo' como source_id");
  else mal("max.source_id = 'hbo'", "1 fila", String(maxSource));

  const huerfanas = await uno(
    `SELECT count(*)::int AS n FROM external_availability_options o
       LEFT JOIN external_availability a ON a.id = o.availability_id WHERE a.id IS NULL`,
  );
  if (huerfanas === 0) bien("ninguna opción huérfana");
  else mal("opciones huérfanas", "0", String(huerfanas));

  const placeholders = await uno(
    `SELECT count(*)::int AS n FROM external_title_images WHERE is_placeholder`,
  );
  const esperadoPh = filas.imagenes.filter((i) => i.isPlaceholder).length;
  if (placeholders === esperadoPh)
    bien(`${String(esperadoPh)} imágenes marcadas como placeholder`);
  else mal("placeholders", String(esperadoPh), String(placeholders));

  const sinIdioma = await uno(
    `SELECT count(*)::int AS n FROM external_title_images WHERE language IS NULL`,
  );
  const esperadoSinIdioma = filas.imagenes.filter((i) => i.language === null).length;
  if (sinIdioma === esperadoSinIdioma)
    bien(
      `${String(esperadoSinIdioma)} imágenes con language NULL conviven gracias a NULLS NOT DISTINCT`,
    );
  else mal("imágenes con language NULL", String(esperadoSinIdioma), String(sinIdioma));

  const futuras = await uno(
    `SELECT count(*)::int AS n FROM external_availability_options
      WHERE expires_at > timestamptz '9000-01-01'`,
  );
  if (futuras === 0) bien("ninguna expiración del año 9998 llegó a la base de datos");
  else mal("expiraciones imposibles", "0", String(futuras));

  const addonVacio = await uno(
    `SELECT count(*)::int AS n FROM external_availability WHERE addon = ''`,
  );
  if (addonVacio === 0)
    bien("ningún addon en cadena vacía: o hay id, o hay NULL (ADR 0005)");
  else mal("addon vacío", "0", String(addonVacio));
}

principal().catch((error: unknown) => {
  const crudo = error instanceof Error ? error.message : String(error);
  console.error(`\n${sanearCredenciales(crudo)}\n`);
  avisoDeEstadoResidual();
  process.exitCode = 1;
});
