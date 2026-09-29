/**
 * El diagnóstico de un fallo de ejecución.
 *
 * Nace de un defecto real: la primera ejecución del harness de `/changes`
 * terminó `failed` con `requests_made = 0` y **el informe no dijo por qué**.
 * `ejecutarJob` devuelve un resultado en vez de lanzar, así que el motivo se
 * quedó dentro de `error_samples` y nadie lo miró.
 *
 * Lo que estos tests protegen: que el motivo salga siempre, y que salga
 * **sin credenciales**.
 */
import { describe, expect, it } from "vitest";

import type { MetricasDeEjecucion } from "../../jobs/ops/contratos.ts";
import { describirFallo, sanearTexto } from "../../jobs/ops/diagnostico.ts";
import { ejecutarJob, leerPresupuesto } from "../../jobs/ops/index.ts";

function metricas(parcial: Partial<MetricasDeEjecucion> = {}): MetricasDeEjecucion {
  return {
    rowsAffected: null,
    multiLinkOffers: 0,
    farFutureExpiries: 0,
    errorCount: 0,
    errorSamples: [],
    ...parcial,
  };
}

const texto = (lineas: readonly string[]): string => lineas.join("\n");

describe("el fallo previo a la primera request se nombra", () => {
  it("lo dice con la frase exacta cuando no hubo ninguna llamada", () => {
    const lineas = describirFallo({
      estado: "failed",
      runId: 19,
      requestsReservadas: 0,
      metricas: metricas({ errorCount: 1 }),
    });
    expect(texto(lineas)).toContain(
      "Fallo previo a la primera request; cuota consumida: 0",
    );
  });

  it("NO lo dice si alguna llamada llegó a completarse", () => {
    const lineas = describirFallo({
      estado: "failed",
      runId: 19,
      requestsReservadas: 2,
      metricas: metricas({ errorCount: 1 }),
    });
    expect(texto(lineas)).not.toContain("previo a la primera request");
  });

  it("siempre identifica la fila, el estado y el recuento de errores", () => {
    const salida = texto(
      describirFallo({
        estado: "failed",
        runId: 19,
        requestsReservadas: 0,
        metricas: metricas({ errorCount: 3 }),
      }),
    );
    expect(salida).toContain("ops_sync_runs id 19");
    expect(salida).toContain("failed");
    expect(salida).toContain("errores contados  3");
  });
});

describe("las muestras de error se imprimen enteras", () => {
  it("saca motivo, nombre y mensaje de una excepción", () => {
    const salida = texto(
      describirFallo({
        estado: "failed",
        runId: 19,
        requestsReservadas: 0,
        metricas: metricas({
          errorCount: 1,
          errorSamples: [
            {
              motivo: "excepcion",
              nombre: "TypeError",
              mensaje: "fetch failed",
            },
          ],
        }),
      }),
    );
    expect(salida).toContain("motivo: excepcion");
    expect(salida).toContain("nombre: TypeError");
    expect(salida).toContain("mensaje: fetch failed");
  });

  it("dice explícitamente cuando no hay ninguna muestra", () => {
    const salida = texto(
      describirFallo({
        estado: "failed",
        runId: 19,
        requestsReservadas: 0,
        metricas: metricas({ errorCount: 0 }),
      }),
    );
    expect(salida).toContain("Sin muestras de error");
  });

  it("delata que la muestra está truncada comparándola con el total", () => {
    const salida = texto(
      describirFallo({
        estado: "failed",
        runId: 19,
        requestsReservadas: 0,
        metricas: metricas({
          errorCount: 57,
          errorSamples: [{ motivo: "excepcion" }],
        }),
      }),
    );
    expect(salida).toContain("Muestras (1 de 57");
  });
});

describe("nada de lo que se imprime lleva credenciales", () => {
  it("redacta una cadena de conexión completa", () => {
    const sucio = "connect ECONNREFUSED postgresql://usuario:clave@host.neon.tech/db";
    expect(sanearTexto(sucio)).not.toContain("clave");
    expect(sanearTexto(sucio)).toContain("<conexión redactada>");
  });

  it("redacta la cabecera del proveedor", () => {
    const sucio = 'headers: { "X-API-Key": "abc123secreta" }';
    expect(sanearTexto(sucio)).not.toContain("abc123secreta");
  });

  it("redacta un parámetro sensible de una URL sin tocar el resto", () => {
    const sucio = "https://api.test/v4/changes?country=es&api_key=sup3rsecreto&x=1";
    const limpio = sanearTexto(sucio);
    expect(limpio).not.toContain("sup3rsecreto");
    expect(limpio).toContain("country=es");
    expect(limpio).toContain("api_key=<redactado>");
  });

  it("tapa cualquier tirada larga que huela a token, y dice su longitud", () => {
    // Conservar la longitud distingue «faltaba la clave» de «era otra clave».
    const token = "a".repeat(40);
    const limpio = sanearTexto(`Authorization ${token}`);
    expect(limpio).not.toContain(token);
    expect(limpio).toContain("<token de 40 caracteres>");
  });

  it("sanea también dentro de las muestras, no solo en el mensaje suelto", () => {
    const salida = texto(
      describirFallo({
        estado: "failed",
        runId: 19,
        requestsReservadas: 0,
        metricas: metricas({
          errorCount: 1,
          errorSamples: [
            {
              motivo: "excepcion",
              mensaje: "no se pudo conectar a postgresql://u:p@host/db",
              contexto: { url: "https://api.test/changes?key=secretovisible" },
            },
          ],
        }),
      }),
    );
    expect(salida).not.toContain("secretovisible");
    expect(salida).not.toContain("u:p@host");
  });

  it("deja intacto un mensaje que no tiene nada que ocultar", () => {
    const limpio = "La consulta de consumo no devolvió ninguna fila.";
    expect(sanearTexto(limpio)).toBe(limpio);
  });
});

describe("una ejecución que revienta acaba en failed con la cuota intacta", () => {
  /** `ops_sync_runs` en memoria: lo justo para que `ejecutarJob` corra. */
  function ejecutorEnMemoria() {
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
          return Promise.resolve([{ id: 19 }] as unknown as readonly T[]);
        }
        if (t.includes("coalesce(sum(requests_made)")) {
          return Promise.resolve([
            { total: consumidas, del_pipeline: consumidas, de_esta: consumidas },
          ] as unknown as readonly T[]);
        }
        if (t.includes("SET requests_made = requests_made +")) {
          consumidas += Number(valores[0] ?? 1);
        }
        return Promise.resolve([] as readonly T[]);
      },
      consumidas: () => consumidas,
    };
  }

  it("reproduce el caso real: revienta ANTES de reservar y deja cuota 0", async () => {
    const bd = ejecutorEnMemoria();
    const presupuesto = leerPresupuesto({
      STREAMING_API_MONTHLY_PIPELINE_BUDGETS: "changes_validation=5",
      STREAMING_API_PER_RUN_CAPS: "changes_validation=5",
    });

    const resultado = await ejecutarJob(
      bd,
      { pipeline: "changes_validation", presupuesto },
      () => {
        // Lo que le pasó al harness: algo revienta antes de la primera
        // llamada, así que `pedirCuota()` no llega a ejecutarse nunca.
        throw new TypeError("Invalid URL");
      },
    );

    expect(resultado.ejecutado && resultado.estado).toBe("failed");
    expect(bd.consumidas()).toBe(0);

    // Y el diagnóstico lo cuenta, que es justo lo que faltaba.
    const salida = texto(
      describirFallo({
        estado: "failed",
        runId: resultado.ejecutado ? resultado.runId : 0,
        requestsReservadas: 0,
        metricas: resultado.ejecutado ? resultado.metricas : metricas(),
      }),
    );
    expect(salida).toContain("Fallo previo a la primera request; cuota consumida: 0");
    expect(salida).toContain("nombre: TypeError");
    expect(salida).toContain("mensaje: Invalid URL");
  });
});

describe("la cuota que se informa es la RESERVADA, no la procesada", () => {
  /** Reproduce la avería real: la request sale, paga, y el parser revienta. */
  async function ejecucionQueReservaYRevienta() {
    let consumidas = 0;
    const bd = {
      ejecutar<T>(
        texto: string,
        valores: readonly unknown[] = [],
      ): Promise<readonly T[]> {
        const t = texto.trim();
        if (t.includes("pg_try_advisory_lock")) {
          return Promise.resolve([{ tomado: true }] as unknown as readonly T[]);
        }
        if (t.startsWith("INSERT INTO ops_sync_runs")) {
          return Promise.resolve([{ id: 19 }] as unknown as readonly T[]);
        }
        if (t.includes("coalesce(sum(requests_made)")) {
          return Promise.resolve([
            { total: consumidas, del_pipeline: consumidas, de_esta: consumidas },
          ] as unknown as readonly T[]);
        }
        if (t.includes("SET requests_made = requests_made +")) {
          consumidas += Number(valores[0] ?? 1);
        }
        return Promise.resolve([] as readonly T[]);
      },
    };

    let reservadas = 0;
    const resultado = await ejecutarJob(
      bd,
      {
        pipeline: "changes_validation",
        presupuesto: leerPresupuesto({
          STREAMING_API_MONTHLY_PIPELINE_BUDGETS: "changes_validation=5",
          STREAMING_API_PER_RUN_CAPS: "changes_validation=5",
        }),
      },
      async (contexto) => {
        // 1 · La request sale y reserva su cuota.
        await contexto.pedirCuota();
        reservadas++;
        // 2 · Y el parser revienta al leer la respuesta, como pasó de verdad.
        throw new Error("ZodError: expected object, received undefined (path: body)");
      },
    );

    return { resultado, reservadas, consumidasEnBd: consumidas };
  }

  it("la ejecución acaba `failed` con requests_made = 1", async () => {
    const { resultado, consumidasEnBd } = await ejecucionQueReservaYRevienta();
    expect(resultado.ejecutado && resultado.estado).toBe("failed");
    expect(consumidasEnBd).toBe(1);
  });

  it("el informe dice 1, NUNCA 0: la cuota se gasta al reservar", async () => {
    const { resultado, reservadas, consumidasEnBd } =
      await ejecucionQueReservaYRevienta();

    // La contabilidad del informe coincide con la de la base de datos.
    expect(reservadas).toBe(consumidasEnBd);
    expect(reservadas).toBe(1);

    const salida = texto(
      describirFallo({
        estado: "failed",
        runId: resultado.ejecutado ? resultado.runId : 0,
        requestsReservadas: reservadas,
        metricas: resultado.ejecutado ? resultado.metricas : metricas(),
      }),
    );

    expect(salida).toContain(
      "La request llegó a reservarse antes del fallo; cuota consumida: 1",
    );
    expect(salida).not.toContain("cuota consumida: 0");
    expect(salida).not.toContain("previo a la primera request");
    // Y el motivo real sale, que era lo que faltaba.
    expect(salida).toContain("ZodError");
  });
});
