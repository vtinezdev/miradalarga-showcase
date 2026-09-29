/**
 * Validación de **comportamiento** del esquema v1 contra PostgreSQL real.
 *
 *   pnpm db:validate:behavior
 *
 * `db:validate:schema` comprueba que las piezas **existen**. Esto comprueba que
 * **hacen lo que prometen**: que el `CHECK` del rating rechaza de verdad el `0`
 * del proveedor, que `NULLS NOT DISTINCT` deduplica de verdad cuando la columna
 * va vacía, que los triggers abortan de verdad un `UPDATE` sobre el histórico y
 * que la retención en dos pasos es de verdad ejecutable. Un constraint presente
 * y mal escrito pasa la validación estructural y falla aquí.
 *
 * ── Cero datos persistentes ────────────────────────────────────────────────
 *
 * Una **transacción exterior** que nunca hace `COMMIT`, y un `SAVEPOINT` por
 * prueba. El savepoint no es cosmético: una violación de constraint deja la
 * transacción en estado abortado y **toda sentencia posterior falla** hasta que
 * se vuelve a un punto sano. Sin él, la primera prueba negativa tumbaría el
 * resto.
 *
 * El `ROLLBACK` final está en un `finally`, así que corre aunque una prueba
 * explote. Y si el proceso muriera antes, PostgreSQL revierte igual al caerse
 * la conexión: **no hay camino por el que un dato de prueba sobreviva**. Al
 * terminar se comprueba explícitamente que no quedó rastro.
 *
 * **Sin DDL.** Ni `CREATE`, ni `ALTER`, ni `DROP`, ni `TRUNCATE`. Solo
 * `INSERT`, `UPDATE` y `DELETE` sobre filas propias, dentro de la transacción.
 *
 * Mismas guardas que `drizzle.migrate.config.ts`. Nunca se imprimen credenciales.
 */
import { Client, neonConfig } from "@neondatabase/serverless";
import { destinoDeProduction } from "./production-comun.ts";
import { MIGRACIONES_ESPERADAS } from "./seed-comun.ts";

/** Todo lo que escribe este script lleva esta marca. Nada real se le parece. */
const MARCA = "__schema_v1_validation__";

/** Código SQLSTATE por clase de fallo esperado. */
const VIOLACION_DE_CHECK = "23514";
const VIOLACION_DE_UNICO = "23505";

/**
 * `restrict_violation`.
 *
 * ⚠️ **`ON DELETE RESTRICT` NO emite `23503`.** `foreign_key_violation` es lo
 * que devuelve `NO ACTION`; `RESTRICT` tiene código propio, y comprueba **antes**
 * en vez de al final de la sentencia. Esperar `23503` era un error de la prueba,
 * no del esquema: las FK están bien declaradas.
 *
 * Lo comparte con el trigger de inmutabilidad, que levanta a propósito este
 * mismo `ERRCODE`. Los dos casos se distinguen por el constraint: una violación
 * de FK lo trae, y la del trigger no.
 */
const VIOLACION_DE_RESTRICT = "23001";

/** El `ERRCODE` que levanta `raise_immutable_history()`. El mismo, sin constraint. */
const VIOLACION_DE_INMUTABILIDAD = "23001";

type Id = string | number;

interface ErrorDePostgres {
  readonly code: string | undefined;
  readonly constraint: string | undefined;
  readonly message: string | undefined;
}

const SIN_DATOS: ErrorDePostgres = {
  code: undefined,
  constraint: undefined,
  message: undefined,
};

/**
 * Quita de un mensaje cualquier cosa que pueda ser una credencial.
 *
 * No es paranoia: ante un fallo de autenticación, PostgreSQL responde
 * literalmente `password authentication failed for user 'xxx'`, y eso es el
 * usuario de la base de datos. Se redacta todo lo entrecomillado y cualquier
 * cadena de conexión.
 */
function sanearCredenciales(mensaje: string): string {
  return mensaje
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "<cadena de conexión redactada>")
    .replace(/(['"])[^'"]*\1/g, "'<redactado>'");
}

function comoErrorDePostgres(error: unknown): ErrorDePostgres {
  if (typeof error !== "object" || error === null) return SIN_DATOS;
  const e = error as Record<string, unknown>;
  return {
    code: typeof e.code === "string" ? e.code : undefined,
    constraint: typeof e.constraint === "string" ? e.constraint : undefined,
    message: typeof e.message === "string" ? e.message : undefined,
  };
}

// ── Informe ────────────────────────────────────────────────────────────────

let fallos = 0;
let pruebas = 0;

function bien(descripcion: string): void {
  pruebas++;
  console.log(`  ✅ ${descripcion}`);
}

function mal(descripcion: string, esperado: string, observado: string): void {
  pruebas++;
  fallos++;
  console.log(`  ❌ ${descripcion} — esperado ${esperado}, observado ${observado}`);
}

function seccion(titulo: string): void {
  console.log(`\n${titulo}`);
}

// ── Cuerpo ─────────────────────────────────────────────────────────────────

async function principal(): Promise<void> {
  // Las guardas corren al cargar el módulo, antes de que exista una conexión.
  // Solo lectura (o sin COMMIT): admite también la rama del seed, para validar
  // que sus migraciones dejan el esquema v1 exacto (ADR 0009 §9).
  // Con `--production` (ADR 0010): sus guardas, y la autorización `migrar`,
  // porque este validador escribe dentro de una transacción que nunca confirma.
  let destino: {
    readonly url: string;
    readonly hostname: string;
    readonly rama: string;
  };
  if (process.argv.includes("--production")) {
    destino = destinoDeProduction({
      operacion: "migrar",
      hastaMigracion: MIGRACIONES_ESPERADAS[MIGRACIONES_ESPERADAS.length - 1] ?? "",
    });
  } else {
    const { RAMAS_DE_VALIDACION, verificarDestino } =
      await import("../drizzle.migrate.config.ts");
    destino = verificarDestino(process.env, RAMAS_DE_VALIDACION);
  }

  // El driver de Neon necesita un constructor de WebSocket para abrir una
  // sesión interactiva. Node 24 trae uno global; el driver no lo detecta solo.
  if (typeof WebSocket === "undefined") {
    throw new Error(
      "Este Node no expone WebSocket global, y la sesión interactiva lo necesita.\n" +
        "  Las pruebas de inmutabilidad no pueden hacerse por HTTP: exigen\n" +
        "  BEGIN, SAVEPOINT y ROLLBACK sobre una misma conexión.",
    );
  }
  neonConfig.webSocketConstructor = WebSocket;

  console.log("VALIDACIÓN DE COMPORTAMIENTO DEL ESQUEMA v1\n");
  console.log(`  hostname          ${destino.hostname}`);
  console.log(`  conexión directa  sí (sin "-pooler")`);
  console.log(`  MIGRATION_TARGET  ${destino.rama}`);
  console.log(`  marca de prueba   ${MARCA}`);

  const cliente = new Client(destino.url);
  // Sin este oyente, un fallo del socket sale como «Unhandled error» y un
  // volcado de pila de las tripas de Node. El error real ya se informa por el
  // camino normal, así que aquí solo se absorbe.
  cliente.on("error", () => undefined);

  try {
    await cliente.connect();
  } catch (error) {
    const e = comoErrorDePostgres(error);
    throw new Error(
      "No se pudo abrir sesión con la rama de validación: " +
        (e.message === undefined
          ? "motivo desconocido"
          : sanearCredenciales(e.message)),
    );
  }

  async function ejecutar<T>(
    texto: string,
    valores: readonly unknown[] = [],
  ): Promise<readonly T[]> {
    // El driver tipa las filas como `any[]`; se estrechan aquí una sola vez.
    const resultado: { rows: unknown[] } = await cliente.query(texto, [...valores]);
    return resultado.rows as readonly T[];
  }

  /** Inserta y devuelve el `id` generado. */
  async function insertarDevolviendoId(
    texto: string,
    valores: readonly unknown[] = [],
  ): Promise<Id> {
    const filas = await ejecutar<{ id: Id }>(`${texto} RETURNING id`, valores);
    const id = filas[0]?.id;
    if (id === undefined) throw new Error(`Sin id devuelto:\n${texto}`);
    return id;
  }

  /**
   * Una prueba aislada. Todo lo que escriba se revierte al salir, pase lo que
   * pase — también si la sentencia dejó la transacción abortada.
   */
  async function aislada(cuerpo: () => Promise<void>): Promise<void> {
    await cliente.query("SAVEPOINT prueba");
    try {
      await cuerpo();
    } finally {
      await cliente.query("ROLLBACK TO SAVEPOINT prueba");
      await cliente.query("RELEASE SAVEPOINT prueba");
    }
  }

  async function debeAceptar(
    descripcion: string,
    cuerpo: () => Promise<void>,
  ): Promise<void> {
    await aislada(async () => {
      try {
        await cuerpo();
        bien(descripcion);
      } catch (error) {
        const e = comoErrorDePostgres(error);
        mal(
          descripcion,
          "que PostgreSQL lo acepte",
          `rechazo ${e.code ?? "?"}${e.constraint === undefined ? "" : ` (${e.constraint})`}`,
        );
      }
    });
  }

  async function debeRechazar(
    descripcion: string,
    codigoEsperado: string,
    cuerpo: () => Promise<void>,
    constraintEsperado?: string,
  ): Promise<void> {
    const queEsperabamos =
      constraintEsperado === undefined
        ? `rechazo ${codigoEsperado}`
        : `rechazo ${codigoEsperado} por ${constraintEsperado}`;

    await aislada(async () => {
      try {
        await cuerpo();
        mal(descripcion, queEsperabamos, "que lo aceptó");
      } catch (error) {
        const e = comoErrorDePostgres(error);
        const codigoOk = e.code === codigoEsperado;
        // Los nombres largos los trunca PostgreSQL a 63 bytes, así que se
        // compara por prefijo y no por igualdad.
        const constraintOk =
          constraintEsperado === undefined ||
          (e.constraint !== undefined &&
            (constraintEsperado.startsWith(e.constraint) ||
              e.constraint.startsWith(constraintEsperado)));

        if (codigoOk && constraintOk) bien(descripcion);
        else
          mal(
            descripcion,
            queEsperabamos,
            `rechazo ${e.code ?? "?"}${e.constraint === undefined ? "" : ` por ${e.constraint}`}`,
          );
      }
    });
  }

  // ── Semillas ─────────────────────────────────────────────────────────────

  const crearTitulo = (sufijo: string, rating: number | null = null): Promise<Id> =>
    insertarDevolviendoId(
      `INSERT INTO external_titles
         (type, imdb_id, source, source_id, title, rating, cast_members, directors)
       VALUES ('movie', $1, $2, $3, $4, $5, '{}', '{}')`,
      [`${MARCA}${sufijo}`, MARCA, `${MARCA}${sufijo}`, `${MARCA} título`, rating],
    );

  /**
   * Un título con este `imdb_id` **literal**, sin la marca delante: es lo que
   * se prueba. La marca va en `source`, así que el rastro final lo encuentra.
   */
  const crearTituloConImdb = (imdbId: string, sufijo: string): Promise<Id> =>
    insertarDevolviendoId(
      `INSERT INTO external_titles
         (type, imdb_id, source, source_id, title, cast_members, directors)
       VALUES ('movie', $1, $2, $3, $4, '{}', '{}')`,
      [imdbId, MARCA, `${MARCA}${sufijo}`, `${MARCA} título`],
    );

  const crearPlataforma = (sufijo: string): Promise<Id> =>
    insertarDevolviendoId(
      `INSERT INTO external_platforms
         (id, name, source, source_id, public_slug, is_active)
       VALUES ($1, $2, $3, $4, $5, false)`,
      [
        `${MARCA}${sufijo}`,
        `${MARCA} plataforma`,
        MARCA,
        `${MARCA}${sufijo}`,
        `${MARCA}${sufijo}`,
      ],
    );

  const crearEjecucion = (sufijo: string): Promise<Id> =>
    insertarDevolviendoId(
      `INSERT INTO ops_sync_runs (pipeline, status, started_at)
       VALUES ($1, 'running', now())`,
      [`${MARCA}${sufijo}`],
    );

  const crearOferta = (
    tituloId: Id,
    plataformaId: Id,
    ejecucionId: Id | null = null,
  ): Promise<Id> =>
    insertarDevolviendoId(
      `INSERT INTO external_availability
         (title_id, platform_id, country, offer_type, last_checked_at, sync_run_id)
       VALUES ($1, $2, 'es', 'subscription', now(), $3)`,
      [tituloId, plataformaId, ejecucionId],
    );

  /** Un anuncio (ADR 0007). Por defecto, sin link y visto una sola vez. */
  const crearAnuncio = (
    tituloId: Id,
    plataformaId: Id,
    entrada: {
      readonly anunciadoPara?: string;
      readonly link?: string | null;
      readonly vistoPrimero?: string;
      readonly vistoUltimo?: string;
      readonly ejecucionId?: Id | null;
    } = {},
  ): Promise<Id> =>
    insertarDevolviendoId(
      `INSERT INTO external_availability_announcements
         (title_id, platform_id, country, offer_type, addon, announced_for,
          first_announced_for, link, first_seen_at, last_seen_at, last_seen_run_id)
       VALUES ($1, $2, 'es', 'subscription', NULL, $3::timestamptz, $3::timestamptz,
               $4, $5::timestamptz, $6::timestamptz, $7)`,
      [
        tituloId,
        plataformaId,
        entrada.anunciadoPara ?? "2026-10-15T00:00:00Z",
        entrada.link ?? null,
        entrada.vistoPrimero ?? "2026-09-24T10:00:00Z",
        entrada.vistoUltimo ?? entrada.vistoPrimero ?? "2026-09-24T10:00:00Z",
        entrada.ejecucionId ?? null,
      ],
    );

  const crearCaptura = (plataformaId: Id, ejecucionId: Id | null = null): Promise<Id> =>
    insertarDevolviendoId(
      `INSERT INTO external_list_captures
         (list_kind, platform_id, country, bucket_start_at, captured_at,
          obtained_depth, sync_run_id)
       VALUES ('official_top', $1, 'es', now(), now(), 10, $2)`,
      [plataformaId, ejecucionId],
    );

  // ── Las pruebas ──────────────────────────────────────────────────────────

  try {
    await cliente.query("BEGIN");

    try {
      seccion("1 · CHECK — lo que el adaptador promete, el esquema lo garantiza");

      await debeRechazar(
        "external_titles.rating = 0 se rechaza (el «sin valoración» del proveedor)",
        VIOLACION_DE_CHECK,
        async () => void (await crearTitulo("_rating0", 0)),
        "external_titles_rating_rango",
      );
      await debeAceptar(
        "external_titles.rating = 1 se acepta (mínimo del rango)",
        async () => void (await crearTitulo("_rating1", 1)),
      );
      await debeAceptar(
        "external_titles.rating = 100 se acepta (máximo del rango)",
        async () => void (await crearTitulo("_rating100", 100)),
      );
      await debeRechazar(
        "external_titles.rating = 101 se rechaza",
        VIOLACION_DE_CHECK,
        async () => void (await crearTitulo("_rating101", 101)),
        "external_titles_rating_rango",
      );
      await debeAceptar(
        "external_titles.rating = NULL se acepta (no lo sabemos)",
        async () => void (await crearTitulo("_ratingNull", null)),
      );

      // 📏 `NOT NULL UNIQUE` no impide `''`: el primer show sin identidad
      // entraría, y el segundo colisionaría con él (migración 0004).
      await debeRechazar(
        "external_titles.imdb_id = '' se rechaza (identidad vacía)",
        VIOLACION_DE_CHECK,
        async () => void (await crearTituloConImdb("", "_imdbVacio")),
        "external_titles_imdb_id_no_vacio",
      );
      await debeRechazar(
        "external_titles.imdb_id = '   ' se rechaza (solo espacios)",
        VIOLACION_DE_CHECK,
        async () => void (await crearTituloConImdb("   ", "_imdbEspacios")),
        "external_titles_imdb_id_no_vacio",
      );
      // `btrim()` sin segundo argumento dejaba pasar estos dos: el CHECK exige
      // un carácter fuera de `[[:space:]]`, la misma regla que el `trim()` del
      // adaptador.
      await debeRechazar(
        "external_titles.imdb_id = tabuladores se rechaza",
        VIOLACION_DE_CHECK,
        async () => void (await crearTituloConImdb("\t\t", "_imdbTabs")),
        "external_titles_imdb_id_no_vacio",
      );
      await debeRechazar(
        "external_titles.imdb_id = saltos de línea se rechaza",
        VIOLACION_DE_CHECK,
        async () => void (await crearTituloConImdb("\r\n \n", "_imdbSaltos")),
        "external_titles_imdb_id_no_vacio",
      );
      await debeAceptar(
        "external_titles.imdb_id = ' tt0000000 ' se acepta (el adaptador recorta antes)",
        async () => void (await crearTituloConImdb(" tt0000000 ", "_imdbConBlancos")),
      );
      await debeAceptar(
        "external_titles.imdb_id = 'tt0000000' se acepta (IMDb normal)",
        // `tt0000000` no es ningún título real de IMDb: no puede chocar con
        // el catálogo de la rama por el UNIQUE.
        async () => void (await crearTituloConImdb("tt0000000", "_imdbNormal")),
      );

      await debeRechazar(
        "external_availability_options.missing_streak = -1 se rechaza",
        VIOLACION_DE_CHECK,
        async () => {
          const t = await crearTitulo("_ms");
          const p = await crearPlataforma("_ms");
          const o = await crearOferta(t, p);
          await ejecutar(
            `INSERT INTO external_availability_options
             (availability_id, link, audio_languages, subtitle_languages,
              first_seen_at, last_seen_at, missing_streak)
           VALUES ($1, $2, '{}', '{}', now(), now(), -1)`,
            [o, `${MARCA}/link`],
          );
        },
        "external_availability_options_missing_streak_no_negativo",
      );

      await debeRechazar(
        "precio con importe pero sin moneda se rechaza",
        VIOLACION_DE_CHECK,
        async () => {
          const t = await crearTitulo("_p1");
          const p = await crearPlataforma("_p1");
          const o = await crearOferta(t, p);
          await ejecutar(
            `INSERT INTO external_availability_options
             (availability_id, link, price_amount, price_currency,
              audio_languages, subtitle_languages, first_seen_at, last_seen_at)
           VALUES ($1, $2, 5.99, NULL, '{}', '{}', now(), now())`,
            [o, `${MARCA}/link`],
          );
        },
        "external_availability_options_precio_completo",
      );

      await debeAceptar("precio con importe y moneda se acepta", async () => {
        const t = await crearTitulo("_p2");
        const p = await crearPlataforma("_p2");
        const o = await crearOferta(t, p);
        await ejecutar(
          `INSERT INTO external_availability_options
           (availability_id, link, price_amount, price_currency,
            audio_languages, subtitle_languages, first_seen_at, last_seen_at)
         VALUES ($1, $2, 5.99, 'EUR', '{}', '{}', now(), now())`,
          [o, `${MARCA}/link`],
        );
      });

      await debeRechazar(
        "external_list_captures.requested_depth = 0 se rechaza",
        VIOLACION_DE_CHECK,
        async () => {
          const p = await crearPlataforma("_rd");
          await ejecutar(
            `INSERT INTO external_list_captures
             (list_kind, platform_id, country, bucket_start_at, captured_at,
              requested_depth, obtained_depth)
           VALUES ('official_top', $1, 'es', now(), now(), 0, 0)`,
            [p],
          );
        },
        "external_list_captures_requested_depth_positivo",
      );

      await debeRechazar(
        "external_list_positions.position = 0 se rechaza (un ordinal empieza en 1)",
        VIOLACION_DE_CHECK,
        async () => {
          const t = await crearTitulo("_pos0");
          const p = await crearPlataforma("_pos0");
          const c = await crearCaptura(p);
          await ejecutar(
            `INSERT INTO external_list_positions (capture_id, position, title_id)
           VALUES ($1, 0, $2)`,
            [c, t],
          );
        },
        "external_list_positions_position_positiva",
      );

      await debeRechazar(
        "derived_ranking_entries.position = 0 se rechaza",
        VIOLACION_DE_CHECK,
        async () => {
          const t = await crearTitulo("_rk0");
          await ejecutar(
            `INSERT INTO derived_ranking_definitions
             (id, country, source_signal, formula_version)
           VALUES ($1, 'es', 'rating', 1)`,
            [`${MARCA}_rk0`],
          );
          await ejecutar(
            `INSERT INTO derived_ranking_entries
             (ranking_id, position, title_id, score_breakdown, generated_at)
           VALUES ($1, 0, $2, '{}'::jsonb, now())`,
            [`${MARCA}_rk0`, t],
          );
        },
        "derived_ranking_entries_position_positiva",
      );

      await debeRechazar(
        "ops_sync_runs.error_count = -1 se rechaza",
        VIOLACION_DE_CHECK,
        async () => {
          await ejecutar(
            `INSERT INTO ops_sync_runs (pipeline, status, started_at, error_count)
           VALUES ($1, 'failed', now(), -1)`,
            [`${MARCA}_ec`],
          );
        },
        "ops_sync_runs_error_count_no_negativo",
      );

      // ADR 0006 · migración 0002. Solo existe en una rama que ya la tenga.
      await debeRechazar(
        "ops_sync_runs.checkpoint que no es un objeto se rechaza",
        VIOLACION_DE_CHECK,
        async () => {
          await ejecutar(
            `INSERT INTO ops_sync_runs (pipeline, status, started_at, checkpoint)
           VALUES ($1, 'failed', now(), '["no", "es", "un", "objeto"]'::jsonb)`,
            [`${MARCA}_cp`],
          );
        },
        "ops_sync_runs_checkpoint_objeto",
      );

      await debeRechazar(
        "una captura de popularidad sin ventana se rechaza (coherencia list_kind/window)",
        VIOLACION_DE_CHECK,
        async () => {
          const p = await crearPlataforma("_vc");
          await ejecutar(
            `INSERT INTO external_list_captures
             (list_kind, platform_id, country, bucket_start_at, captured_at, obtained_depth)
           VALUES ('popularity', $1, 'es', now(), now(), 10)`,
            [p],
          );
        },
        "external_list_captures_ventana_coherente",
      );

      await debeRechazar(
        "un anuncio visto por última vez ANTES que por primera se rechaza",
        VIOLACION_DE_CHECK,
        async () => {
          const t = await crearTitulo("_anchk");
          const p = await crearPlataforma("_anchk");
          await crearAnuncio(t, p, {
            vistoPrimero: "2026-09-24T10:00:00Z",
            vistoUltimo: "2026-09-23T10:00:00Z",
          });
        },
        "external_availability_announcements_vistas_ordenadas",
      );

      await debeAceptar(
        "📏 un anuncio SIN link se acepta: Prime anuncia sin él (ADR 0007)",
        async () => {
          const t = await crearTitulo("_ansl");
          const p = await crearPlataforma("_ansl");
          await crearAnuncio(t, p, { link: null });
        },
      );

      seccion("2 · NULLS NOT DISTINCT — dos NULL SÍ colisionan");

      await debeRechazar(
        "dos imágenes con (title, type, width) y language NULL: la segunda se rechaza",
        VIOLACION_DE_UNICO,
        async () => {
          const t = await crearTitulo("_img");
          const insertar = `INSERT INTO external_title_images
             (title_id, type, width, language, observed_url, captured_at, is_placeholder)
           VALUES ($1, 'vertical_poster', 240, NULL, $2, now(), false)`;
          await ejecutar(insertar, [t, `${MARCA}/a.jpg`]);
          await ejecutar(insertar, [t, `${MARCA}/b.jpg`]);
        },
        "external_title_images_key",
      );

      await debeAceptar(
        "las mismas dos imágenes con idiomas distintos SÍ conviven (el único no es excesivo)",
        async () => {
          const t = await crearTitulo("_img2");
          const insertar = `INSERT INTO external_title_images
             (title_id, type, width, language, observed_url, captured_at, is_placeholder)
           VALUES ($1, 'vertical_poster', 240, $2, $3, now(), false)`;
          await ejecutar(insertar, [t, "es", `${MARCA}/es.jpg`]);
          await ejecutar(insertar, [t, "en", `${MARCA}/en.jpg`]);
        },
      );

      await debeRechazar(
        "dos ofertas con la misma clave y addon NULL: la segunda se rechaza",
        VIOLACION_DE_UNICO,
        async () => {
          const t = await crearTitulo("_av");
          const p = await crearPlataforma("_av");
          await crearOferta(t, p);
          await crearOferta(t, p);
        },
        "external_availability_key",
      );

      await debeRechazar(
        "dos opciones con el mismo link y quality NULL: la segunda se rechaza",
        VIOLACION_DE_UNICO,
        async () => {
          const t = await crearTitulo("_op");
          const p = await crearPlataforma("_op");
          const o = await crearOferta(t, p);
          const insertar = `INSERT INTO external_availability_options
             (availability_id, link, quality, audio_languages, subtitle_languages,
              first_seen_at, last_seen_at)
           VALUES ($1, $2, NULL, '{}', '{}', now(), now())`;
          await ejecutar(insertar, [o, `${MARCA}/mismo-link`]);
          await ejecutar(insertar, [o, `${MARCA}/mismo-link`]);
        },
        "external_availability_options_key",
      );

      await debeRechazar(
        "dos capturas con title_type y window NULL en el mismo bucket: la segunda se rechaza",
        VIOLACION_DE_UNICO,
        async () => {
          const p = await crearPlataforma("_cap");
          // ⚠️ `window` va ENTRECOMILLADA: es palabra **reservada** en
          // PostgreSQL, y una reservada sin comillas en una lista de columnas
          // es un error de sintaxis (42601), no un aviso. El propio Drizzle la
          // entrecomilla en las tres veces que aparece en la migración 0000.
          //
          // El instante va como parámetro en vez de como literal con prefijo de
          // tipo: hace falta que las dos filas caigan en el mismo bucket, y un
          // parámetro no depende de cómo se parsee el literal.
          const insertar = `INSERT INTO external_list_captures
             (list_kind, platform_id, country, title_type, "window",
              bucket_start_at, captured_at, obtained_depth)
           VALUES ('official_top', $1, 'es', NULL, NULL,
                   $2::timestamptz, now(), 10)`;
          const bucket = "2026-01-01T00:00:00Z";
          await ejecutar(insertar, [p, bucket]);
          await ejecutar(insertar, [p, bucket]);
        },
        "external_list_captures_key",
      );

      await debeRechazar(
        "dos anuncios de la misma oferta con addon NULL y OTRA fecha: la segunda se rechaza",
        VIOLACION_DE_UNICO,
        async () => {
          const t = await crearTitulo("_an");
          const p = await crearPlataforma("_an");
          await crearAnuncio(t, p, { anunciadoPara: "2026-10-15T00:00:00Z" });
          // Un aplazamiento es la MISMA fila: la fecha no es identidad.
          await crearAnuncio(t, p, { anunciadoPara: "2026-11-01T00:00:00Z" });
        },
        "external_availability_announcements_key",
      );

      seccion("3 · Inmutabilidad — el histórico no se reescribe");

      await debeRechazar(
        "UPDATE sobre external_availability_events lo aborta el trigger",
        VIOLACION_DE_INMUTABILIDAD,
        async () => {
          const t = await crearTitulo("_ev1");
          const p = await crearPlataforma("_ev1");
          const o = await crearOferta(t, p);
          const e = await insertarDevolviendoId(
            `INSERT INTO external_availability_events
             (availability_id, event_type, event_digest, dedupe_bucket_at, detected_at)
           VALUES ($1, 'added', $2, now(), now())`,
            [o, `${MARCA}_digest`],
          );
          await ejecutar(
            `UPDATE external_availability_events SET event_type = 'removed'
                        WHERE id = $1`,
            [e],
          );
        },
      );

      await debeRechazar(
        "DELETE sobre external_availability_events lo aborta el trigger",
        VIOLACION_DE_INMUTABILIDAD,
        async () => {
          const t = await crearTitulo("_ev2");
          const p = await crearPlataforma("_ev2");
          const o = await crearOferta(t, p);
          const e = await insertarDevolviendoId(
            `INSERT INTO external_availability_events
             (availability_id, event_type, event_digest, dedupe_bucket_at, detected_at)
           VALUES ($1, 'added', $2, now(), now())`,
            [o, `${MARCA}_digest`],
          );
          await ejecutar(`DELETE FROM external_availability_events WHERE id = $1`, [e]);
        },
      );

      await debeRechazar(
        "UPDATE sobre external_list_captures lo aborta el trigger",
        VIOLACION_DE_INMUTABILIDAD,
        async () => {
          const p = await crearPlataforma("_cu");
          const c = await crearCaptura(p);
          await ejecutar(
            `UPDATE external_list_captures SET obtained_depth = 99 WHERE id = $1`,
            [c],
          );
        },
      );

      await debeRechazar(
        "UPDATE sobre external_list_positions lo aborta el trigger",
        VIOLACION_DE_INMUTABILIDAD,
        async () => {
          const t = await crearTitulo("_pu");
          const p = await crearPlataforma("_pu");
          const c = await crearCaptura(p);
          await ejecutar(
            `INSERT INTO external_list_positions (capture_id, position, title_id)
           VALUES ($1, 1, $2)`,
            [c, t],
          );
          await ejecutar(
            `UPDATE external_list_positions SET position = 2 WHERE capture_id = $1`,
            [c],
          );
        },
      );

      seccion("4 · Retención en dos pasos");

      await debeRechazar(
        "borrar una captura que aún tiene posiciones se rechaza (FK RESTRICT)",
        VIOLACION_DE_RESTRICT,
        async () => {
          const t = await crearTitulo("_r1");
          const p = await crearPlataforma("_r1");
          const c = await crearCaptura(p);
          await ejecutar(
            `INSERT INTO external_list_positions (capture_id, position, title_id)
           VALUES ($1, 1, $2)`,
            [c, t],
          );
          await ejecutar(`DELETE FROM external_list_captures WHERE id = $1`, [c]);
        },
        "external_list_positions_capture_id_external_list_captures_id_fk",
      );

      await debeAceptar(
        "borrar primero las posiciones y después la captura sí funciona",
        async () => {
          const t = await crearTitulo("_r2");
          const p = await crearPlataforma("_r2");
          const c = await crearCaptura(p);
          await ejecutar(
            `INSERT INTO external_list_positions (capture_id, position, title_id)
           VALUES ($1, 1, $2)`,
            [c, t],
          );
          await ejecutar(`DELETE FROM external_list_positions WHERE capture_id = $1`, [
            c,
          ]);
          const borradas = await ejecutar<{ id: Id }>(
            `DELETE FROM external_list_captures WHERE id = $1 RETURNING id`,
            [c],
          );
          if (borradas.length !== 1) throw new Error("la captura no se borró");
        },
      );

      seccion("5 · Políticas de borrado diferenciales");

      await debeAceptar(
        "availability.sync_run_id → SET NULL: la oferta sobrevive al borrado de la ejecución",
        async () => {
          const t = await crearTitulo("_sn");
          const p = await crearPlataforma("_sn");
          const r = await crearEjecucion("_sn");
          const o = await crearOferta(t, p, r);
          await ejecutar(`DELETE FROM ops_sync_runs WHERE id = $1`, [r]);
          const filas = await ejecutar<{ sync_run_id: Id | null }>(
            `SELECT sync_run_id FROM external_availability WHERE id = $1`,
            [o],
          );
          if (filas.length !== 1) throw new Error("la oferta desapareció");
          if (filas[0]?.sync_run_id !== null) {
            throw new Error(`sync_run_id quedó en ${String(filas[0]?.sync_run_id)}`);
          }
        },
      );

      await debeAceptar(
        "announcements.last_seen_run_id → SET NULL: el anuncio sobrevive a su ejecución",
        async () => {
          const t = await crearTitulo("_ansn");
          const p = await crearPlataforma("_ansn");
          const r = await crearEjecucion("_ansn");
          const a = await crearAnuncio(t, p, { ejecucionId: r });
          await ejecutar(`DELETE FROM ops_sync_runs WHERE id = $1`, [r]);
          const filas = await ejecutar<{ last_seen_run_id: Id | null }>(
            `SELECT last_seen_run_id FROM external_availability_announcements WHERE id = $1`,
            [a],
          );
          if (filas.length !== 1) throw new Error("el anuncio desapareció");
          if (filas[0]?.last_seen_run_id !== null) {
            throw new Error(
              `last_seen_run_id quedó en ${String(filas[0]?.last_seen_run_id)}`,
            );
          }
        },
      );

      await debeRechazar(
        "announcements → titles es RESTRICT: no se borra un título con un anuncio",
        VIOLACION_DE_RESTRICT,
        async () => {
          const t = await crearTitulo("_anres");
          const p = await crearPlataforma("_anres");
          await crearAnuncio(t, p);
          await ejecutar(`DELETE FROM external_titles WHERE id = $1`, [t]);
        },
        "external_availability_announcements_title_id_external_titles_id_fk",
      );

      await debeRechazar(
        "events.sync_run_id → RESTRICT: no se borra la ejecución que produjo histórico",
        VIOLACION_DE_RESTRICT,
        async () => {
          const t = await crearTitulo("_rs");
          const p = await crearPlataforma("_rs");
          const r = await crearEjecucion("_rs");
          const o = await crearOferta(t, p);
          await ejecutar(
            `INSERT INTO external_availability_events
             (availability_id, event_type, event_digest, dedupe_bucket_at,
              detected_at, sync_run_id)
           VALUES ($1, 'added', $2, now(), now(), $3)`,
            [o, `${MARCA}_digest`, r],
          );
          await ejecutar(`DELETE FROM ops_sync_runs WHERE id = $1`, [r]);
        },
        "external_availability_events_sync_run_id_ops_sync_runs_id_fk",
      );

      await debeAceptar(
        "title_images → titles es CASCADE: borrar el título se lleva sus imágenes",
        async () => {
          const t = await crearTitulo("_cas");
          await ejecutar(
            `INSERT INTO external_title_images
             (title_id, type, width, observed_url, captured_at, is_placeholder)
           VALUES ($1, 'vertical_poster', 240, $2, now(), false)`,
            [t, `${MARCA}/c.jpg`],
          );
          await ejecutar(`DELETE FROM external_titles WHERE id = $1`, [t]);
          const quedan = await ejecutar<{ total: number }>(
            `SELECT count(*)::int AS total FROM external_title_images WHERE title_id = $1`,
            [t],
          );
          if (quedan[0]?.total !== 0) {
            throw new Error(`quedaron ${String(quedan[0]?.total)} imágenes huérfanas`);
          }
        },
      );

      await debeRechazar(
        "availability → titles es RESTRICT: no se borra un título con disponibilidad",
        VIOLACION_DE_RESTRICT,
        async () => {
          const t = await crearTitulo("_res");
          const p = await crearPlataforma("_res");
          await crearOferta(t, p);
          await ejecutar(`DELETE FROM external_titles WHERE id = $1`, [t]);
        },
        "external_availability_title_id_external_titles_id_fk",
      );
    } finally {
      // Pase lo que pase: nada de esto se queda.
      await cliente.query("ROLLBACK");
    }

    // ── Comprobación final: ni un rastro ─────────────────────────────────────
    seccion("6 · Rastro dejado por la validación");

    const residuo = await ejecutar<{ tabla: string; total: number }>(
      `SELECT 'external_titles' AS tabla, count(*)::int AS total
       FROM external_titles WHERE imdb_id LIKE $1 OR source = $2
     UNION ALL SELECT 'external_platforms', count(*)::int
       FROM external_platforms WHERE id LIKE $1
     UNION ALL SELECT 'external_genres', count(*)::int
       FROM external_genres WHERE id LIKE $1
     UNION ALL SELECT 'ops_sync_runs', count(*)::int
       FROM ops_sync_runs WHERE pipeline LIKE $1
     UNION ALL SELECT 'derived_ranking_definitions', count(*)::int
       FROM derived_ranking_definitions WHERE id LIKE $1`,
      [`${MARCA}%`, MARCA],
    );

    const sucias = residuo.filter((r) => r.total !== 0);
    if (sucias.length === 0) {
      bien(`ninguna fila con la marca ${MARCA} sobrevivió al ROLLBACK`);
    } else {
      mal(
        "la validación no dejó datos persistentes",
        "0 filas marcadas",
        sucias.map((r) => `${r.tabla}: ${String(r.total)}`).join(", "),
      );
    }
  } finally {
    await cliente.end();
  }

  console.log("");
  if (fallos === 0) {
    console.log(`✅ ${pruebas} pruebas de comportamiento, todas correctas.`);
  } else {
    console.log(`❌ ${fallos} de ${pruebas} pruebas de comportamiento fallaron.`);
    process.exitCode = 1;
  }
}

// El saneado va aquí y no solo en los sitios donde se espera un fallo: un
// error que se escape por cualquier otro camino también puede traer el usuario
// de la base de datos en su mensaje.
principal().catch((error: unknown) => {
  const crudo = error instanceof Error ? error.message : String(error);
  console.error(`\n${sanearCredenciales(crudo)}\n`);
  process.exitCode = 1;
});
