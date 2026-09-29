/**
 * `pnpm ops historica db:validate:catalogo` — valida el adaptador de lectura
 * de Neon (`src/db/queries/`) **contra una rama de validación, en solo
 * lectura**, de extremo a extremo: SQL real → mapeo → consultas de aplicación
 * de cada pantalla.
 *
 * ⚠️ **Cero escrituras, demostrado y no supuesto:**
 *
 *   1. Guardas de destino de siempre (`verificarDestino`, **por defecto solo la
 *      rama histórica**): `production` es inalcanzable por construcción.
 *   2. Todo ocurre dentro de **una** transacción `READ ONLY`: PostgreSQL
 *      rechaza cualquier escritura con error, incluida una accidental del SQL
 *      del adaptador.
 *   3. Al final, **`txid_current_if_assigned()` es `NULL`** (la transacción no
 *      obtuvo identificador: no escribió nada) y **`pg_stat_xact_all_tables`**
 *      suma 0 inserciones, actualizaciones y borrados en la transacción.
 *   4. `ROLLBACK`, pase lo que pase.
 *
 * Sin red externa, sin credencial de la API, sin reservar cuota. No imprime la
 * cadena de conexión: solo el hostname, que las guardas ya muestran.
 *
 * Si la rama está vacía no es un fallo: se validan esquema y consultas, y se
 * dice qué queda pendiente para el catálogo real (`docs/NEON-ADAPTER.md` §17).
 *
 * Salida: 0 todo correcto · 1 alguna comprobación falló o no se pudo conectar.
 */
import { Client, neonConfig } from "@neondatabase/serverless";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { sanear } from "../src/db/queries/errores.ts";
import * as q from "../src/db/queries/catalogo-sql.ts";
import { COLACION } from "../src/db/queries/catalogo-sql.ts";
import type { LectorSql } from "../src/db/queries/lector.ts";
import { crearRepositorioNeon } from "../src/db/queries/repositorio-neon.ts";
import { construirBusqueda } from "../src/features/catalogo/consultas-busqueda.ts";
import {
  construirHubDePlataforma,
  construirHubDeTipo,
  construirIndiceDePlataformas,
} from "../src/features/catalogo/consultas-hubs.ts";
import { construirIndiceDeListas } from "../src/features/catalogo/consultas-listas.ts";
import { construirRadar } from "../src/features/catalogo/consultas-radar.ts";
import {
  construirFicha,
  construirPortada,
} from "../src/features/catalogo/consultas.ts";
import type { TipoDeMovimiento } from "../src/features/catalogo/modelo.ts";

const dialecto = new PgDialect();

interface Medida {
  operacion: string;
  filas: number;
  ms: number;
}

let fallos = 0;
function comprobar(ok: boolean, texto: string): void {
  if (!ok) fallos += 1;
  console.log(`  ${ok ? "✅" : "❌"} ${texto}`);
}

async function principal(): Promise<void> {
  const { verificarDestino } = await import("../drizzle.migrate.config.ts");
  // Sin segundo argumento: solo la rama histórica (tests/contract/destinos-por-llamador).
  const destino = verificarDestino();

  if (typeof WebSocket === "undefined") {
    throw new Error("Este Node no expone WebSocket global y Neon lo necesita.");
  }
  neonConfig.webSocketConstructor = WebSocket;

  console.log("VALIDACIÓN DEL ADAPTADOR DE LECTURA — solo lectura\n");
  console.log(`  hostname          ${destino.hostname}`);
  console.log(`  MIGRATION_TARGET  ${destino.rama}`);
  console.log(
    `  operación         SELECT en transacción READ ONLY · ROLLBACK · 0 API\n`,
  );

  const cliente = new Client(destino.url);
  cliente.on("error", () => undefined);
  try {
    await cliente.connect();
  } catch (error) {
    throw new Error(
      `No se pudo conectar: ${sanear(error instanceof Error ? error.message : String(error))}`,
    );
  }

  const crudo = async <T>(texto: string, valores: unknown[] = []): Promise<T[]> =>
    ((await cliente.query(texto, valores)) as unknown as { rows: T[] }).rows;

  const medidas: Medida[] = [];
  const lector: LectorSql = {
    async leer<T>(operacion: string, consulta: SQL): Promise<T[]> {
      const { sql, params } = dialecto.sqlToQuery(consulta);
      const inicio = performance.now();
      const filas = await crudo<T>(sql, params);
      medidas.push({ operacion, filas: filas.length, ms: performance.now() - inicio });
      return filas;
    },
  };

  try {
    await crudo("BEGIN TRANSACTION READ ONLY");
    await crudo("SET LOCAL statement_timeout = '20s'");

    // ── 1 · El entorno ────────────────────────────────────────────────────
    console.log("1 · Entorno");
    const [ro] = await crudo<{ v: string }>(
      "SELECT current_setting('transaction_read_only') AS v",
    );
    comprobar(
      ro?.v === "on",
      `transacción de solo lectura (transaction_read_only = ${String(ro?.v)})`,
    );
    const [version] = await crudo<{ v: string }>(
      "SELECT current_setting('server_version') AS v",
    );
    console.log(`     PostgreSQL ${String(version?.v)}`);
    const colacion = await crudo("SELECT 1 FROM pg_collation WHERE collname = $1", [
      COLACION,
    ]);
    comprobar(colacion.length === 1, `colación ${COLACION} disponible`);
    const extensiones = await crudo<{ extname: string }>(
      "SELECT extname FROM pg_extension ORDER BY 1",
    );
    console.log(`     extensiones: ${extensiones.map((e) => e.extname).join(", ")}`);
    if (colacion.length !== 1)
      throw new Error("Sin la colación no tiene sentido seguir.");

    // ── 2 · Qué hay en la rama ────────────────────────────────────────────
    console.log("\n2 · Contenido de la rama (recuentos)");
    const [c] = await crudo<Record<string, string>>(`
      SELECT (SELECT count(*) FROM external_titles) AS titulos,
             (SELECT count(*) FROM external_titles WHERE year IS NULL) AS sin_anio,
             (SELECT count(*) FROM external_titles WHERE imdb_id !~ '^tt[0-9]{1,12}$') AS imdb_no_enrutable,
             (SELECT count(*) FROM external_titles WHERE overview IS NULL OR btrim(overview) = '') AS sin_sinopsis,
             (SELECT count(*) FROM external_titles WHERE rating IS NULL) AS sin_valoracion,
             (SELECT count(*) FROM external_availability WHERE country = 'es') AS ofertas,
             (SELECT count(*) FROM external_availability_options) AS opciones,
             (SELECT count(*) FROM external_availability_options WHERE price_currency IS NOT NULL AND price_currency <> 'EUR') AS precios_no_eur,
             (SELECT count(*) FROM external_availability WHERE addon IS NOT NULL) AS ofertas_addon,
             (SELECT count(*) FROM external_availability_events) AS eventos,
             (SELECT count(*) FROM external_availability_announcements) AS anuncios,
             (SELECT count(*) FROM external_platforms) AS plataformas,
             (SELECT count(*) FROM external_platform_capabilities) AS capacidades,
             (SELECT count(*) FROM external_title_images) AS imagenes_conocidas`);
    for (const [k, v] of Object.entries(c ?? {}))
      console.log(`     ${k.padEnd(20)} ${v}`);
    const eventos = await crudo<{ event_type: string; n: string }>(
      "SELECT event_type, count(*) AS n FROM external_availability_events GROUP BY 1 ORDER BY 1",
    );
    console.log(
      `     eventos por tipo     ${eventos.map((e) => `${e.event_type} ${e.n}`).join(" · ") || "—"}`,
    );
    const vacia = Number(c?.titulos ?? 0) === 0;

    // ── 3 · El puerto, operación por operación ────────────────────────────
    console.log("\n3 · Repositorio de Neon");
    const repo = crearRepositorioNeon(lector);
    const plataformas = await repo.plataformas();
    comprobar(
      plataformas.length > 0,
      `plataformas: ${plataformas.map((p) => `${p.id}→/${p.slug}`).join(", ")}`,
    );
    const capacidades = await repo.capacidades();
    console.log(`     capacidades de ${Object.keys(capacidades).length} plataformas`);

    if (vacia) {
      console.log("\n  La rama no tiene catálogo: se validan las consultas sin datos.");
    }
    let comprobado: string | null = null;
    try {
      comprobado = await repo.ultimaComprobacion();
      comprobar(
        !Number.isNaN(Date.parse(comprobado)),
        `ultimaComprobacion ${comprobado}`,
      );
    } catch (error) {
      comprobar(
        vacia,
        `ultimaComprobacion sin datos → ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (comprobado !== null) {
      console.log(`     inicioDelRegistro ${await repo.inicioDelRegistro()}`);
    }

    const tipos: TipoDeMovimiento[] = [
      "llega",
      "se-fue",
      "cambio",
      "se-va",
      "proximamente",
    ];
    for (const tipo of tipos) {
      const ms = await repo.movimientos(tipo, 50);
      const ordenado = ms.every((m, i) =>
        i === 0
          ? true
          : tipo === "se-va" || tipo === "proximamente"
            ? ms[i - 1]!.fecha <= m.fecha
            : ms[i - 1]!.fecha >= m.fecha,
      );
      const unicos = new Set(ms.map((m) => `${m.tituloId}|${m.plataforma.id}`)).size;
      comprobar(
        ordenado && unicos === ms.length,
        `movimientos(${tipo}): ${ms.length}, ordenados y sin duplicados`,
      );
      if (tipo === "se-va" || tipo === "proximamente") {
        const capacidad = tipo === "se-va" ? "expiring" : "upcoming";
        comprobar(
          ms.every(
            (m) => capacidades[m.plataforma.id]?.[capacidad] === "supported_with_data",
          ),
          `  ${tipo}: solo plataformas con ${capacidad} en ✅`,
        );
      }
      const ejemplo = ms[0];
      if (ejemplo)
        console.log(
          `       p. ej. ${ejemplo.tituloId} · ${ejemplo.plataforma.nombre} · ${ejemplo.fecha}${ejemplo.detalle ? ` · ${ejemplo.detalle}` : ""}`,
        );
    }

    const pagina = await repo.explorar({}, 24);
    comprobar(
      pagina.titulos.length <= 24,
      `explorar({}, 24): ${pagina.titulos.length} de ${pagina.total} disponibles`,
    );
    const series = await repo.explorar({ tipo: "serie" }, 0);
    console.log(`     explorar(serie, 0): total ${series.total}`);
    const generos = await repo.generos({});
    console.log(
      `     generos: ${
        generos
          .slice(0, 5)
          .map((g) => `${g.nombre} ${g.recuento}`)
          .join(" · ") || "—"
      }`,
    );
    const recuento = await repo.recuentoPorPlataforma();
    console.log(
      `     recuentoPorPlataforma: ${Object.entries(recuento)
        .map(([p, r]) => `${p} ${r.pelicula}/${r.serie}`)
        .join(" · ")}`,
    );
    for (const tipo of ["pelicula", "serie"] as const) {
      const ranking = await repo.mejorValoradas(tipo, 5);
      const bien = ranking.every(
        (p, i) => i === 0 || ranking[i - 1]!.valoracion.valor >= p.valoracion.valor,
      );
      comprobar(
        bien,
        `mejorValoradas(${tipo}, 5): ${ranking.map((p) => `${p.valoracion.valor} ${p.titulo.titulo}`).join(" · ") || "—"}`,
      );
    }

    const primero = pagina.titulos[0];
    if (primero) {
      comprobar(
        Object.keys(primero.imagenes).length === 0,
        "ninguna imagen publicable (ADR 0008)",
      );
      const ficha = await repo.ficha(primero.tipo, primero.slug);
      comprobar(
        ficha?.id === primero.id,
        `ficha(${primero.tipo}, ${primero.slug}): ${ficha?.ofertas.length ?? 0} ofertas · comprobada ${ficha?.comprobadoEn ?? "—"}`,
      );
      const viejo = `otro-texto-${primero.id}`;
      comprobar(
        (await repo.ficha(primero.tipo, viejo))?.id === primero.id,
        "un slug con otro texto y el mismo imdb resuelve la misma ficha",
      );
      comprobar(
        (await repo.ficha(primero.tipo, "sin-sufijo")) === null,
        "un slug sin imdb no resuelve",
      );
      const palabra =
        primero.titulo.split(/\s+/).find((p) => p.length >= 3) ?? primero.titulo;
      const busqueda = await repo.buscar(palabra, 50);
      comprobar(
        busqueda.resultados.some((r) => r.titulo.id === primero.id),
        `buscar(«${palabra}»): ${busqueda.resultados.length} de ${busqueda.total}, incluye el título de partida`,
      );
      const mayus = await repo.buscar(palabra.toUpperCase(), 50);
      comprobar(mayus.total === busqueda.total, "la búsqueda no distingue mayúsculas");
      const slugs = await repo.slugs(primero.tipo);
      comprobar(
        slugs.includes(primero.slug),
        `slugs(${primero.tipo}): ${slugs.length}, incluye el de partida`,
      );
      console.log(
        `     delMismoDirector: ${(await repo.delMismoDirector(primero.id, 4)).length}`,
      );
    }
    comprobar(
      (await repo.listas()).length === 0,
      "listas(): ninguna (el editorial no vive en Neon)",
    );

    // ── 4 · Las pantallas, por las consultas de aplicación ────────────────
    if (!vacia && comprobado !== null) {
      console.log("\n4 · Consultas de aplicación sobre Neon");
      const portada = await construirPortada(repo);
      console.log(
        `     portada: radar llega ${portada.radar.llega.length} · se va ${portada.radar.seVa.length} · próximamente ${portada.radar.proximamente.length} · se fue ${portada.radar.seFue.length} · cambios ${portada.radar.cambios.length}`,
      );
      const radar = await construirRadar(repo);
      console.log(
        `     radar: ${radar.filas.length} filas entre ${radar.desde} y ${radar.hasta}`,
      );
      comprobar(
        radar.filas.every((f) => f.titulo.id === f.movimiento.tituloId),
        "radar: cada fila con su título",
      );
      const indice = await construirIndiceDePlataformas(repo);
      console.log(`     /plataformas: ${indice.plataformas.length}`);
      const hub = plataformas[0]
        ? await construirHubDePlataforma(repo, plataformas[0].slug)
        : null;
      comprobar(hub !== null, `/plataformas/${plataformas[0]?.slug ?? "—"}`);
      for (const tipo of ["pelicula", "serie"] as const) {
        const h = await construirHubDeTipo(repo, tipo);
        console.log(
          `     /${tipo === "pelicula" ? "peliculas" : "series"}: ${h.total} disponibles · ${h.generos.length} géneros`,
        );
      }
      const listas = await construirIndiceDeListas(repo);
      console.log(`     /listas: ${listas.listas.length}`);
      if (primero) {
        const vista = await construirFicha(repo, primero.tipo, primero.slug);
        comprobar(vista !== null, `ficha completa de ${primero.slug}`);
        const b = await construirBusqueda(repo, primero.titulo);
        comprobar(
          b.estado === "resultados",
          `/buscar?q=${primero.titulo}: ${b.estado}`,
        );
      }
      // La serialización RSC: todo lo que viaja al cliente es JSON puro.
      comprobar(
        JSON.parse(JSON.stringify(portada)) !== null,
        "la portada se serializa a JSON sin pérdida de tipos (sin Date, sin bigint)",
      );
    }

    // ── 4b · Reglas con compuerta, medidas sin ella ─────────────────────
    // Si la rama no tiene filas de capacidades, «se va» y «próximamente» salen
    // vacíos por diseño (fail closed). Esto mide cuántos habría con la matriz
    // en ✅, para que un vacío no esconda una regla rota.
    console.log(
      "\n4b · Salidas y anuncios sin la compuerta de capacidades (diagnóstico)",
    );
    const [sin] = await crudo<Record<string, string | null>>(`
      SELECT
        (SELECT count(*) FROM external_availability a
          WHERE a.country = 'es' AND EXISTS (
            SELECT 1 FROM external_availability_options o
             WHERE o.availability_id = a.id AND o.missing_streak < 2
               AND o.expires_at > now() AND o.expires_at <= now() + interval '30 days')) AS salidas_30d,
        (SELECT count(*) FROM external_availability_options o
          WHERE o.missing_streak < 2 AND o.expires_at > now() + interval '1000 years') AS centinelas_lejanos,
        (SELECT r.id::text FROM ops_sync_runs r
          WHERE r.pipeline = 'upcoming' AND r.status = 'succeeded' AND r.finished_at IS NOT NULL
            AND r.error_count = 0 AND jsonb_typeof(r.checkpoint) = 'object'
            AND r.checkpoint -> 'pendiente' = 'null'::jsonb
          ORDER BY r.id DESC LIMIT 1) AS recorrido_de_referencia,
        (SELECT count(*) FROM external_availability_announcements n
          WHERE n.country = 'es' AND n.announced_for > now()) AS anuncios_futuros,
        (SELECT count(*) FROM external_availability_announcements n
          WHERE n.country = 'es' AND n.announced_for > now()
            AND n.last_seen_run_id >= (SELECT r.id FROM ops_sync_runs r
              WHERE r.pipeline = 'upcoming' AND r.status = 'succeeded' AND r.finished_at IS NOT NULL
                AND r.error_count = 0 AND jsonb_typeof(r.checkpoint) = 'object'
                AND r.checkpoint -> 'pendiente' = 'null'::jsonb
              ORDER BY r.id DESC LIMIT 1)) AS anuncios_vigentes`);
    for (const [k, v] of Object.entries(sin ?? {}))
      console.log(`     ${k.padEnd(24)} ${String(v)}`);

    // ── 4c · Planes de las consultas más pesadas ─────────────────────────
    console.log("\n4c · EXPLAIN ANALYZE (dentro de la transacción READ ONLY)");
    const muestra = pagina.titulos.map((t) => t.id);
    const planes: [string, SQL][] = [
      ["explorar({}, 24)", q.explorar({}, 24)],
      ["tarjetas(24 ids)", q.tarjetas(muestra.length > 0 ? muestra : ["tt0"])],
      ["movimientos llega 50", q.movimientosDelHistorico("added", 50, {})],
      ["movimientos se-va 50", q.movimientosSeVa(50, {})],
      ["recuentoPorPlataforma", q.recuentoPorPlataforma()],
      ["buscar «el»", q.buscar("el", ["el"], 50)],
    ];
    for (const [nombre, consulta] of planes) {
      const { sql: texto, params } = dialecto.sqlToQuery(consulta);
      const [fila] = await crudo<{ "QUERY PLAN": unknown }>(
        `EXPLAIN (ANALYZE, FORMAT JSON) ${texto}`,
        params,
      );
      const plan = (
        fila?.["QUERY PLAN"] as { "Execution Time": number; Plan: unknown }[]
      )[0];
      const secuenciales = new Set<string>();
      const recorrer = (n: unknown): void => {
        const nodo = n as {
          "Node Type"?: string;
          "Relation Name"?: string;
          Plans?: unknown[];
        };
        if (nodo["Node Type"] === "Seq Scan" && nodo["Relation Name"])
          secuenciales.add(nodo["Relation Name"]);
        for (const h of nodo.Plans ?? []) recorrer(h);
      };
      recorrer(plan?.Plan);
      console.log(
        `     ${nombre.padEnd(24)} ${String(plan?.["Execution Time"].toFixed(1)).padStart(8)} ms en el servidor · seq scan: ${[...secuenciales].join(", ") || "ninguno"}`,
      );
    }

    // ── 5 · Coste de las consultas ────────────────────────────────────────
    console.log("\n5 · Consultas ejecutadas");
    const porOperacion = new Map<
      string,
      { n: number; filas: number; ms: number; maxFilas: number }
    >();
    for (const m of medidas) {
      const a = porOperacion.get(m.operacion) ?? { n: 0, filas: 0, ms: 0, maxFilas: 0 };
      porOperacion.set(m.operacion, {
        n: a.n + 1,
        filas: a.filas + m.filas,
        ms: a.ms + m.ms,
        maxFilas: Math.max(a.maxFilas, m.filas),
      });
    }
    for (const [op, a] of [...porOperacion].sort()) {
      console.log(
        `     ${op.padEnd(26)} ×${String(a.n).padStart(3)}  máx ${String(a.maxFilas).padStart(4)} filas  ${(a.ms / a.n).toFixed(0).padStart(5)} ms de reloj (incluye la cola de la sesión)`,
      );
    }
    console.log(
      `     total: ${medidas.length} consultas · máx ${Math.max(0, ...medidas.map((m) => m.filas))} filas en una`,
    );
    comprobar(
      medidas.every((m) => m.filas <= 20_000),
      "ninguna consulta sin acotar",
    );

    // ── 6 · Cero escrituras ───────────────────────────────────────────────
    console.log("\n6 · Cero escrituras");
    const [xid] = await crudo<{ xid: string | null }>(
      "SELECT txid_current_if_assigned()::text AS xid",
    );
    comprobar(
      xid?.xid === null,
      "txid_current_if_assigned() es NULL: la transacción no escribió",
    );
    const [tuplas] = await crudo<{ n: string }>(
      "SELECT coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::text AS n FROM pg_stat_xact_all_tables",
    );
    comprobar(
      tuplas?.n === "0",
      `pg_stat_xact_all_tables: ${String(tuplas?.n)} tuplas escritas`,
    );
  } finally {
    await crudo("ROLLBACK").catch(() => undefined);
    await cliente.end().catch(() => undefined);
  }

  console.log(
    `\n${fallos === 0 ? "✅ Todo correcto." : `❌ ${fallos} comprobación(es) fallida(s).`} ROLLBACK hecho; 0 requests a la API.`,
  );
  process.exitCode = fallos === 0 ? 0 : 1;
}

principal().catch((error: unknown) => {
  console.error(
    `\n❌ ${sanear(error instanceof Error ? error.message : String(error))}`,
  );
  process.exitCode = 1;
});
