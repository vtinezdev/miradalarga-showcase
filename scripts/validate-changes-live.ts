/**
 * **PRIMERA VALIDACIÓN REAL DE `/changes`. GASTA CUOTA.**
 *
 *   pnpm api:validate:changes --simulacro   cero requests, sin Neon, sin red
 *   pnpm api:validate:changes               hasta 5 requests reales
 *
 * Valida **solo** las cinco premisas que la auditoría del corpus no pudo
 * cerrar, porque las 64 respuestas del Spike 1 se quedaron todas en la página
 * 1. Lo que ya está medido no se vuelve a pagar.
 *
 * ── Los cerrojos ────────────────────────────────────────────────────────────
 *
 *   · **5 requests como máximo absoluto**, y no por disciplina: el tope viaja
 *     como `topePorEjecucion`, así que quien corta es `reservar()`. La sexta
 *     reserva lanza `PresupuestoAgotado` y `ejecutarJob` cierra la fila como
 *     **`budget_stopped`**, nunca `failed`.
 *   · **Toda llamada pasa por `jobs/ops/transporte.ts`**, que reserva antes de
 *     salir. ESLint impide que este fichero llame a `fetch` por su cuenta.
 *   · **Los topes del repositorio no se tocan.** `TECHO_MENSUAL_POR_DEFECTO` y
 *     `TOPE_POR_EJECUCION_POR_DEFECTO` siguen cerrados a 0; la configuración
 *     de esta prueba se inyecta y vive solo dentro de este proceso.
 *   · **Pipeline técnico propio, `changes_validation`.** El gasto queda
 *     auditado y cuenta para el techo global, pero no toca el presupuesto de
 *     `deltas`, `expiring` ni `upcoming`.
 *   · **Solo `drizzle-schema-v1-test`**, por las mismas guardas que la
 *     migración. `production` es inalcanzable por construcción.
 *
 * ── Lo que este harness NO hace ─────────────────────────────────────────────
 *
 * **No escribe catálogo ni histórico.** Ni títulos, ni ofertas, ni opciones,
 * ni eventos. Pide, valida con Zod, mide e informa. Lo único que escribe es su
 * propia fila de `ops_sync_runs`, que es obligatoria: sin ella no habría
 * contabilidad de la cuota que esta prueba gasta.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Client, neonConfig } from "@neondatabase/serverless";

import { respuestaCambiosProveedor } from "../jobs/adapters/streaming-availability/schema.ts";
import type { EjecutorSql, Presupuesto } from "../jobs/ops/contratos.ts";
import { PresupuestoAgotado, esPipelineTecnico } from "../jobs/ops/contratos.ts";
import { describirFallo, sanearTexto } from "../jobs/ops/diagnostico.ts";
import { ejecutarJob, leerPresupuesto } from "../jobs/ops/index.ts";
import type { FuenteDeCuota, Transporte } from "../jobs/ops/transporte.ts";
import {
  congelacionDelDestino,
  explicarCongelacion,
} from "../jobs/pipelines/arranque.ts";
import { crearTransporte } from "../jobs/ops/transporte.ts";
import {
  BASE_POR_DEFECTO,
  construirUrl,
  ventanaHaciaDelante,
} from "../jobs/pipelines/deltas/origen.ts";
import {
  MAXIMO_DE_REQUESTS,
  analizarPagina,
  evaluarPremisas,
  siguientePaso,
} from "../jobs/pipelines/deltas/validacion.ts";
import type { ObservacionDePagina } from "../jobs/pipelines/deltas/validacion.ts";

/**
 * El pipeline al que se imputa la cuota.
 *
 * ⚖️ **Un pipeline técnico propio, y no `deltas`.** Esta prueba pide
 * `expiring` y `upcoming`, así que cargarla a `deltas` falsearía el consumo de
 * tres pipelines productivos a la vez y se comería un techo mensual que no es
 * suyo. Con nombre propio, las 5 requests quedan auditadas en `ops_sync_runs`,
 * cuentan para el techo global de 900 y no contaminan a nadie.
 */
const PIPELINE = "changes_validation" as const;
const MARCA = "validate-changes-live";

/** 📄 La ventana de `/changes` es de 31 días; `expiring`/`upcoming` miran adelante. */
const DIAS_DE_VENTANA = 31;

/**
 * La única premisa que el corpus del Spike 1 puede cerrar por sí solo: el
 * `timestamp` de un aviso `expiring` contra el `expiresOn` del snapshot. Las
 * otras cuatro hablan de **cómo responde la API**, y ningún fixture puede
 * responder por ella.
 */
const PREMISA_OFFLINE = 5;

/**
 * Una sola implementación de saneo, la de `jobs/ops/diagnostico.ts`.
 *
 * Había dos, y la de aquí era la floja: no tapaba la cabecera cuando venía
 * entrecomillada, que es justo como la imprime un error de JavaScript. Dos
 * versiones de algo así divergen, y la que filtra es siempre la peor de las
 * dos.
 */
const sanearCredenciales = sanearTexto;

function envolver(cliente: Client): EjecutorSql {
  return {
    async ejecutar<T>(texto: string, valores: readonly unknown[] = []) {
      const r: { rows: unknown[] } = await cliente.query(texto, [...valores]);
      return r.rows as readonly T[];
    },
  };
}

// ── Modo simulacro: ni red ni Neon ──────────────────────────────────────────

/**
 * `ops_sync_runs` en memoria. Lo justo para que `ejecutarJob` y `reservar()`
 * corran de verdad —incluido el corte— sin tocar ninguna base de datos.
 */
function ejecutorEnMemoria(): EjecutorSql {
  let consumidas = 0;
  return {
    ejecutar<T>(
      texto: string,
      valores: readonly unknown[] = [],
    ): Promise<readonly T[]> {
      const t = texto.trim();
      if (t.includes("pg_try_advisory_lock")) {
        return Promise.resolve([{ tomado: true }] as unknown as readonly T[]);
      }
      if (t.startsWith("INSERT INTO ops_sync_runs")) {
        return Promise.resolve([{ id: 1 }] as unknown as readonly T[]);
      }
      if (t.includes("coalesce(sum(requests_made)")) {
        return Promise.resolve([
          { total: consumidas, del_pipeline: consumidas, de_esta: consumidas },
        ] as unknown as readonly T[]);
      }
      if (t.includes("SET requests_made = requests_made +")) {
        consumidas += Number(valores[0] ?? 1);
        return Promise.resolve([] as readonly T[]);
      }
      return Promise.resolve([] as readonly T[]);
    },
  };
}

const FIXTURES: Readonly<Record<string, string>> = {
  expiring: "023-C-changes-expiring.json",
  upcoming: "024-C-changes-upcoming.json",
  new: "018-C-changes-new-sinventana.json",
  removed: "020-C-changes-removed-sinventana.json",
  updated: "022-C-changes-updated-sinventana.json",
};

interface CuerpoDeCambios {
  changes: { showId: string }[];
  shows: Record<string, unknown>;
  hasMore?: boolean;
  nextCursor?: string;
}

/**
 * Sirve el crudo del Spike 1 para la página 1 y una **página derivada** para
 * las siguientes.
 *
 * ⚠️ Las páginas ≥ 2 del simulacro son **sintéticas**: se construyen cortando
 * el propio fixture, porque el Spike 1 nunca pasó de la primera. Sirven para
 * ejercitar el circuito y el formato del informe, y **no prueban absolutamente
 * nada sobre la API**. El informe lo dice en cada línea.
 */
function transporteDeSimulacro(fuente: FuenteDeCuota): Transporte {
  const raiz = join(import.meta.dirname, "..", "spike-1", "raw");

  return async (url: string): Promise<Response> => {
    // Mismo orden que `crearTransporte`: primero la cuota, luego la respuesta.
    await fuente.pedirCuota();

    const parametros = new URL(url).searchParams;
    const tipo = parametros.get("change_type") ?? "expiring";
    const fichero = FIXTURES[tipo];
    if (fichero === undefined) throw new Error(`Sin fixture para ${tipo}.`);

    const crudo = JSON.parse(readFileSync(join(raiz, fichero), "utf8")) as {
      body: CuerpoDeCambios;
    };
    const cuerpo = crudo.body;

    if (parametros.get("cursor") === null) {
      // Se sirve la forma del CUERPO HTTP, que es lo que devuelve la API. El
      // `body` del fichero ya se desenvolvio al leerlo.
      return new Response(
        JSON.stringify({ ...cuerpo, hasMore: true, nextCursor: "simulado:1" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    // Página derivada: la segunda mitad de los avisos, con solo sus shows.
    const mitad = Math.floor(cuerpo.changes.length / 2);
    const changes = cuerpo.changes.slice(mitad);
    const referenciados = new Set(changes.map((c) => c.showId));
    const shows: Record<string, unknown> = {};
    for (const [clave, valor] of Object.entries(cuerpo.shows)) {
      if (referenciados.has(clave)) shows[clave] = valor;
    }

    return new Response(JSON.stringify({ changes, shows, hasMore: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

// ── El informe ──────────────────────────────────────────────────────────────

function imprimirObservaciones(
  observadas: readonly ObservacionDePagina[],
  simulacro: boolean,
): void {
  console.log("\nPETICIONES");
  console.log(
    "  #  change_type  pág  result  hasMore  cursor recibido       changes  shows  sin resolver",
  );
  observadas.forEach((o, i) => {
    const cursor = (o.cursorRecibido ?? "—").slice(0, 20).padEnd(20);
    const sintetica = simulacro && o.pagina > 1 ? "  ← SINTÉTICA" : "";
    console.log(
      `  ${String(i + 1).padStart(2)}  ${o.tipo.padEnd(11)}  ${String(o.pagina).padStart(3)}  ` +
        `${String(o.resultCount).padStart(6)}  ${String(o.hasMore).padEnd(7)}  ${cursor}  ` +
        `${String(o.numeroDeCambios).padStart(7)}  ${String(o.numeroDeShows).padStart(5)}  ` +
        `${String(o.showIdsSinResolver.length).padStart(12)}${sintetica}`,
    );
    if (o.showIdsSinResolver.length > 0) {
      console.log(`      ⚠️  sin show: ${o.showIdsSinResolver.slice(0, 8).join(", ")}`);
    }
    if (o.showIdsSobrantes.length > 0) {
      console.log(
        `      shows sin aviso que los referencie: ${String(o.showIdsSobrantes.length)}`,
      );
    }
  });

  const contrastes = observadas.flatMap((o) => o.contrastes);
  const descartados = observadas.reduce((n, o) => n + o.contrastablesDescartados, 0);
  console.log("\nCONTRASTE expiring: timestamp del aviso vs expiresOn del snapshot");
  if (contrastes.length === 0) {
    console.log(
      `  ningún par contrastable · ${String(descartados)} avisos sin expiresOn en su opción`,
    );
  } else {
    for (const c of contrastes.slice(0, 10)) {
      const marca = c.coinciden ? "=" : "≠";
      console.log(
        `  ${c.showId.padEnd(10)} ${String(c.timestampDelAviso)} ${marca} ${String(
          c.expiresOnDelSnapshot,
        )}  (Δ ${String(c.diferenciaSegundos)} s)`,
      );
    }
    if (contrastes.length > 10) {
      console.log(`  … y ${String(contrastes.length - 10)} más`);
    }
    const iguales = contrastes.filter((c) => c.coinciden).length;
    console.log(
      `  ${String(iguales)}/${String(contrastes.length)} coinciden al segundo · ` +
        `${String(descartados)} no contrastables`,
    );
  }
}

// ── Principal ───────────────────────────────────────────────────────────────

async function principal(): Promise<void> {
  const simulacro = process.argv.includes("--simulacro");

  console.log(
    simulacro
      ? "SIMULACRO DE LA VALIDACIÓN DE /changes — CERO REQUESTS, SIN NEON\n" +
          "  ⚠️  Las páginas >= 2 son SINTÉTICAS: el Spike 1 nunca pasó de la 1.\n" +
          "      Esto verifica el circuito y el informe. NO es evidencia sobre la API.\n"
      : "VALIDACIÓN REAL DE /changes — GASTA CUOTA\n",
  );

  // La configuración de cuota se INYECTA: los topes del repositorio siguen a 0.
  const presupuesto: Presupuesto = leerPresupuesto({
    ...process.env,
    STREAMING_API_MONTHLY_PIPELINE_BUDGETS: `${PIPELINE}=${String(MAXIMO_DE_REQUESTS)}`,
    STREAMING_API_PER_RUN_CAPS: `${PIPELINE}=${String(MAXIMO_DE_REQUESTS)}`,
  });

  let ejecutor: EjecutorSql;
  let cliente: Client | null = null;
  let apiKey = "simulacro";
  let base = BASE_POR_DEFECTO;

  if (simulacro) {
    ejecutor = ejecutorEnMemoria();
  } else {
    const bruta = process.env.STREAMING_AVAILABILITY_API_KEY?.trim();
    if (bruta === undefined || bruta === "") {
      throw new Error(
        "Falta STREAMING_AVAILABILITY_API_KEY en la sesión. Sin credencial no se llama a nadie.",
      );
    }
    apiKey = bruta;
    base = process.env.STREAMING_API_BASE_URL?.trim() ?? BASE_POR_DEFECTO;

    // Las mismas guardas que la migración: directa sin -pooler, hostname
    // exacto y MIGRATION_TARGET. `production` es inalcanzable.
    const { verificarDestino } = await import("../drizzle.migrate.config.ts");
    const destino = verificarDestino();
    // Ciclo de la captura del seed: la rama histórica no gasta (ADR 0009 §9.3).
    const congelada = congelacionDelDestino(
      destino.rama,
      new Date(),
      presupuesto.diaDeCiclo,
    );
    if (congelada !== null)
      throw new Error(explicarCongelacion(destino.rama, congelada));

    if (typeof WebSocket === "undefined") {
      throw new Error("Este Node no expone WebSocket global y Neon lo necesita.");
    }
    neonConfig.webSocketConstructor = WebSocket;

    console.log(`  hostname          ${destino.hostname}`);
    console.log(`  MIGRATION_TARGET  ${destino.rama}`);
    console.log(`  API               ${new URL(base).hostname}`);

    cliente = new Client(destino.url);
    cliente.on("error", () => undefined);
    try {
      await cliente.connect();
    } catch (error) {
      const m = error instanceof Error ? error.message : String(error);
      throw new Error(`No se pudo conectar: ${sanearCredenciales(m)}`);
    }
    ejecutor = envolver(cliente);
  }

  // Autocomprobación: este harness solo puede correr bajo un pipeline técnico.
  // Repuntarlo a uno productivo falsearía su contabilidad, y eso no puede
  // depender de que nadie lo haga por descuido.
  if (!esPipelineTecnico(PIPELINE)) {
    throw new Error(
      `"${PIPELINE}" no es un pipeline técnico. Un harness de validación no puede
` + `  imputar su gasto a un pipeline productivo: contaminaría su presupuesto.`,
    );
  }

  console.log(`  pipeline          ${PIPELINE} (técnico, manual)`);
  console.log(`  tope de ESTA ejecución  ${String(MAXIMO_DE_REQUESTS)} requests`);
  console.log(`  escribe catálogo  NO · solo su fila de ops_sync_runs`);

  const observadas: ObservacionDePagina[] = [];
  let reservadas = 0;
  let fallosDuros = 0;

  try {
    const resultado = await ejecutarJob(
      ejecutor,
      { pipeline: PIPELINE, presupuesto, commitSha: MARCA },
      async (contexto) => {
        // La cuota se gasta al RESERVAR, no al entender la respuesta. Contarla
        // aqui —envolviendo `pedirCuota`— es lo unico que hace que el informe
        // coincida con `ops_sync_runs.requests_made` aunque el parser reviente
        // despues.
        const fuente: FuenteDeCuota = {
          pipeline: contexto.pipeline,
          pedirCuota: async () => {
            await contexto.pedirCuota();
            reservadas++;
          },
        };
        const transporte = simulacro
          ? transporteDeSimulacro(fuente)
          : crearTransporte(fuente);
        const ventana = ventanaHaciaDelante(new Date(), DIAS_DE_VENTANA);

        for (;;) {
          const paso = siguientePaso(observadas);
          if (paso === null) break;

          const url = construirUrl({
            base,
            tipo: paso.tipo,
            cursor: paso.cursor,
            ventana,
            idioma: "es",
          });

          // `PresupuestoAgotado` NO se captura: tiene que subir para que
          // `ejecutarJob` cierre la fila como `budget_stopped`. Capturarlo
          // convertiría un corte de cuota en una ejecución correcta.
          const respuesta = await transporte(url, {
            headers: { "X-API-Key": apiKey, Accept: "application/json" },
          });

          if (!respuesta.ok) {
            const cuerpo = await respuesta.text();
            fallosDuros++;
            console.error(
              `\n❌ ${paso.tipo} pág. ${String(paso.pagina)} → HTTP ${String(respuesta.status)}\n` +
                `   ${cuerpo.slice(0, 300)}`,
            );
            // Un 400 aquí es probablemente `include_unknown_dates`: se para,
            // no se sigue gastando cuota a ciegas.
            return;
          }

          const crudo: unknown = await respuesta.json();
          const analizada = respuestaCambiosProveedor.parse(crudo);
          observadas.push(analizarPagina(paso, analizada));
        }
      },
    );

    if (!resultado.ejecutado) {
      console.error(
        "\nYa hay una ejecución viva de este pipeline. No se ha pedido nada.",
      );
      process.exitCode = 1;
      return;
    }

    imprimirObservaciones(observadas, simulacro);

    console.log("\nPREMISAS");
    const veredictos = evaluarPremisas(observadas);

    // ⚠️ En simulacro, cuatro de las cinco premisas NO están validadas: las
    //    páginas >= 2 son sintéticas y el 200 lo firma un fixture, no la API.
    //    Presentarlas con un ✅ sería justo el error que este proyecto
    //    persigue —convertir un silencio en una afirmación—, así que se marcan
    //    como simuladas. La 5 es la excepción: se contrasta contra el corpus
    //    REAL del Spike 1, y ahí sí hay medición.
    for (const v of veredictos) {
      if (!simulacro) {
        const icono =
          v.estado === "ok"
            ? "✅"
            : v.estado === "parcial"
              ? "📐 MÍNIMO MEDIDO — total no agotado ·"
              : v.estado === "fallo"
                ? "❌"
                : "❓ SIN DATOS";
        console.log(`  ${icono} ${String(v.numero)}. ${v.premisa}`);
        console.log(`      ${v.detalle}`);
        continue;
      }

      console.log(`  ${String(v.numero)}. ${v.premisa}`);
      if (v.numero === PREMISA_OFFLINE && v.estado === "ok") {
        console.log("     ✅ VALIDADA OFFLINE CON CORPUS REAL");
        // El recuento incluye los pares de la página sintética, que repiten
        // los de la 1. La medición independiente son los 25 de la página
        // real, y queda registrada en tests/contract/.
        console.log(
          "     (el recuento repite pares al venir la pág. 2 del mismo fixture:",
        );
        console.log("      la medición independiente son los 25 de la pág. 1)");
      } else if (v.estado === "fallo") {
        console.log("     ❌ FALLO DEL CIRCUITO DEL HARNESS");
      } else {
        console.log("     🧪 SIMULADA — pendiente de API real");
      }
      console.log(`     ${v.detalle}`);
    }

    // ⚠️ Un `failed` NO puede pasar en silencio. `ejecutarJob` devuelve un
    //    resultado en vez de lanzar, así que el motivo vive en las métricas y
    //    se queda dentro de la fila si nadie lo imprime. Eso fue exactamente
    //    lo que ocurrió en la primera ejecución real.
    if (resultado.estado === "failed") {
      console.error("");
      for (const linea of describirFallo({
        estado: resultado.estado,
        runId: resultado.runId,
        requestsReservadas: reservadas,
        metricas: resultado.metricas,
      })) {
        console.error(linea);
      }
    }

    console.log("\nCUOTA");
    console.log(
      `  requests consumidas  ${String(reservadas)} / ${String(MAXIMO_DE_REQUESTS)}` +
        (simulacro ? "  (simuladas: ninguna salió a la red)" : ""),
    );
    // Se imprimen las dos porque pueden diferir, y esa diferencia ES el
    // sintoma: una request pagada cuya respuesta no se pudo procesar.
    console.log(`  páginas procesadas   ${String(observadas.length)}`);
    if (reservadas !== observadas.length) {
      console.log(
        `  ⚠️  ${String(reservadas - observadas.length)} request(s) gastadas sin poder procesarse`,
      );
    }
    console.log(`  ops_sync_runs        id ${String(resultado.runId)}`);
    console.log(`  estado               ${resultado.estado}`);

    if (resultado.estado === "budget_stopped") {
      // El techo mensual de un pipeline cuenta TODAS sus filas del ciclo, no
      // solo esta ejecución. Si una anterior ya gastó parte, el corte llega
      // antes: es la aritmética funcionando, no una avería.
      const corte = resultado.metricas.errorSamples.find(
        (m) => typeof m.techo === "number",
      );
      const consumido = corte?.consumido;
      const techo = corte?.techo;

      console.log(
        "\n⚠️  CORTE DE CUOTA — ESPERADO, no es una avería.\n" +
          `    El techo de "${PIPELINE}" se cuenta por CICLO, sumando todas sus\n` +
          "    ejecuciones. Una ejecución anterior que ya gastó parte del ciclo\n" +
          "    adelanta el corte de esta.\n" +
          (typeof consumido === "number" && typeof techo === "number"
            ? `    Denegada con ${String(consumido)} consumidas del ciclo frente a un techo de ${String(techo)}.\n`
            : "") +
          `    Esta ejecución reservó ${String(reservadas)}.\n` +
          "    Lo observado es válido; lo que quedó sin mirar sigue SIN MEDIR.",
      );
    }

    const fallidas = veredictos.filter((v) => v.estado === "fallo");
    const sinDatos = veredictos.filter((v) => v.estado === "sin_datos");

    // Una ejecución que revienta no es un resultado «incompleto»: es un fallo,
    // y tiene que salir con 1. Antes caía en la rama de «sin datos» y el
    // proceso terminaba en 0, que es como se perdió el primer diagnóstico.
    if (resultado.estado === "failed") {
      console.error(
        "\n❌ La ejecución terminó como `failed`. El diagnóstico está arriba.",
      );
      process.exitCode = 1;
      return;
    }

    if (fallidas.length > 0 || fallosDuros > 0) {
      console.error(
        simulacro
          ? `\n❌ ${String(fallidas.length)} fallo(s) en el circuito del harness. ` +
              "En simulacro nada de esto habla de la API: apunta al propio harness."
          : `\n❌ ${String(fallidas.length)} premisa(s) falsada(s)` +
              (fallosDuros > 0 ? ` y ${String(fallosDuros)} error(es) HTTP` : "") +
              ". El diseño del pipeline necesita revisión antes de seguir.",
      );
      process.exitCode = 1;
      return;
    }

    if (simulacro) {
      const offline = veredictos.filter(
        (v) => v.numero === PREMISA_OFFLINE && v.estado === "ok",
      ).length;
      console.log(
        `\n✅ Circuito del harness correcto. ${String(offline)} premisa validada ` +
          `offline; ${String(veredictos.length - offline)} pendientes de validación real.`,
      );
      return;
    }

    // El resumen distingue lo cerrado de lo que solo tiene un suelo medido.
    // Fundirlos en «las cinco se sostienen» presentaría un mínimo como total.
    const plenas = veredictos.filter((v) => v.estado === "ok");
    const parciales = veredictos.filter((v) => v.estado === "parcial");

    console.log(`\n✅ ${String(plenas.length)} premisa(s) plenamente validada(s).`);
    for (const v of parciales) {
      console.log(
        `📐 ${v.premisa}: MÍNIMO MEDIDO, total NO agotado — sigue sin medirse.`,
      );
    }
    if (sinDatos.length > 0) {
      console.log(
        `⚠️  ${String(sinDatos.length)} premisa(s) SIN DATOS: no es un fallo, ` +
          "pero tampoco un aprobado.",
      );
    }
  } finally {
    if (cliente !== null) await cliente.end().catch(() => undefined);
  }
}

principal().catch((error: unknown) => {
  if (error instanceof PresupuestoAgotado) {
    // No debería llegar aquí: `ejecutarJob` lo captura y cierra la fila.
    console.error(`\nCorte de cuota fuera del job: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const m = error instanceof Error ? error.message : String(error);
  console.error(`\n${sanearCredenciales(m)}`);
  process.exitCode = 1;
});
