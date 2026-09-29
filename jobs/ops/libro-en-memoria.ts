/**
 * `ops_sync_runs` **en memoria**. Solo para el ensayo, la reproducción y los
 * tests: **nunca para una ejecución que gaste API**.
 *
 * Existe porque el ensayo contra Neon no puede escribir en el `ops_sync_runs`
 * real: una fila suya se sumaría al libro del ciclo sin haber gastado nada, y
 * un evento colgado de ella la haría imborrable (FK `RESTRICT`). Con esto,
 * `ejecutarJob` y `reservar()` corren de verdad —lock, reserva, corte, cierre—
 * sin tocar ninguna base de datos.
 *
 * Reconoce las sentencias de `jobs/ops/` por su texto, igual que los dobles de
 * los tests. Si una cambia, el doble deja de reconocerla y el test que lo usa
 * lo dice.
 */
import type { EjecutorSql, MuestraDeError } from "./contratos.ts";

export interface FilaEnMemoria {
  readonly id: number;
  readonly pipeline: string;
  requestsMade: number;
  status: string;
  errorCount: number;
  errorSamples: readonly MuestraDeError[];
  rowsAffected: Readonly<Record<string, number>> | null;
  /** Ya parseado, como lo devolvería el driver. `null` si no lleva. */
  checkpoint: unknown;
  /**
   * `finished_at`: el `now()` del cierre, tomado del reloj del libro. `null`
   * mientras sigue viva.
   */
  finishedAt: Date | null;
}

export interface LibroEnMemoria {
  readonly ejecutor: EjecutorSql;
  readonly filas: readonly FilaEnMemoria[];
  /**
   * Consumo previo del ciclo, para simular un libro que no empieza en cero.
   * `muestras` simula lo que dejó en `error_samples`: un corte del proveedor
   * ya registrado, por ejemplo.
   */
  sembrar(
    pipeline: string,
    requests: number,
    muestras?: readonly MuestraDeError[],
  ): void;
  /**
   * Una fila con historia —un checkpoint, una huérfana en `running`— tal y
   * como la habría dejado otra ejecución. Devuelve su `id`.
   */
  sembrarFila(fila: {
    readonly pipeline: string;
    readonly status: string;
    readonly requestsMade?: number;
    readonly checkpoint?: unknown;
    /** Por defecto, el reloj del libro si no está en `running`; `null` si lo está. */
    readonly finishedAt?: Date | null;
  }): number;
}

/**
 * @param opciones.reloj el `now()` del servidor, para `finished_at`. Por
 * defecto `new Date()`: con `vi.setSystemTime` los tests lo controlan.
 */
export function crearLibroEnMemoria(
  opciones: { readonly reloj?: () => Date } = {},
): LibroEnMemoria {
  const reloj = opciones.reloj ?? (() => new Date());
  const filas: FilaEnMemoria[] = [];
  let siguienteId = 1;

  const ejecutar = <T>(
    texto: string,
    valores: readonly unknown[] = [],
  ): Promise<readonly T[]> => {
    const t = texto.trim();
    const responder = (r: unknown[]) => Promise.resolve(r as readonly T[]);

    if (t.includes("pg_try_advisory_lock")) return responder([{ tomado: true }]);
    if (t.startsWith("INSERT INTO ops_sync_runs")) {
      const fila: FilaEnMemoria = {
        id: siguienteId++,
        pipeline: String(valores[0]),
        requestsMade: 0,
        status: "running",
        errorCount: 0,
        errorSamples: [],
        rowsAffected: null,
        // `abrirEjecucion` lo pasa serializado, como texto para `::jsonb`.
        checkpoint: typeof valores[4] === "string" ? JSON.parse(valores[4]) : null,
        finishedAt: null,
      };
      filas.push(fila);
      return responder([{ id: fila.id }]);
    }
    if (t.includes("checkpoint -> 'pendiente' = 'null'::jsonb")) {
      // `leerRecorridoDeReferencia` (`upcoming/vigencia.ts`): el último
      // `succeeded`, completo y sin errores de ese pipeline.
      const ultima = filas
        .filter(
          (f) =>
            f.pipeline === String(valores[0]) &&
            f.status === "succeeded" &&
            f.errorCount === 0 &&
            typeof f.checkpoint === "object" &&
            f.checkpoint !== null &&
            (f.checkpoint as { pendiente?: unknown }).pendiente === null,
        )
        .sort((a, b) => b.id - a.id)[0];
      return responder(ultima === undefined ? [] : [{ id: ultima.id }]);
    }
    if (t.includes("checkpoint ->> 'pendiente' IS NULL")) {
      // `exigirBootstrapCompleto` (`pipelines/arranque.ts`): el primer deltas
      // `succeeded` sin página pendiente, por id ascendente.
      const primera = filas
        .filter((f) => {
          const c = f.checkpoint as { pendiente?: unknown } | null;
          return (
            f.pipeline === "deltas" &&
            f.status === "succeeded" &&
            c !== null &&
            (c.pendiente === null || c.pendiente === undefined)
          );
        })
        .sort((a, b) => a.id - b.id)[0];
      return responder(
        primera === undefined
          ? []
          : [
              {
                id: primera.id,
                status: primera.status,
                finished_at: primera.finishedAt,
                checkpoint: primera.checkpoint,
              },
            ],
      );
    }
    if (t.includes("checkpoint ->> 'capturaId' = $1")) {
      // `filasDeLaCaptura` (`seed/captura.ts`): las filas de una captura, por id.
      const capturaId = String(valores[0]);
      return responder(
        filas
          .filter((f) => {
            const c = f.checkpoint as { fase?: unknown; capturaId?: unknown } | null;
            return (
              f.pipeline === "seed" &&
              c?.fase === "captura" &&
              c.capturaId === capturaId
            );
          })
          .sort((a, b) => a.id - b.id)
          .map((f) => ({ id: f.id, requests_made: f.requestsMade })),
      );
    }
    if (t.includes("checkpoint ->> 'fase' = 'carga'")) {
      // `leerAnclaDelSeed` (`seed/ancla.ts`): la última carga confirmada.
      const ultima = filas
        .filter((f) => {
          const c = f.checkpoint as { fase?: unknown; estado?: unknown } | null;
          return f.pipeline === "seed" && c?.fase === "carga" && c.estado === "cargada";
        })
        .sort((a, b) => b.id - a.id)[0];
      return responder(
        ultima === undefined
          ? []
          : [{ id: ultima.id, status: ultima.status, checkpoint: ultima.checkpoint }],
      );
    }
    if (t.includes("checkpoint IS NOT NULL")) {
      // `leerUltimoCheckpoint`: el de id más alto de ese pipeline.
      const ultima = filas
        .filter((f) => f.pipeline === String(valores[0]) && f.checkpoint !== null)
        .sort((a, b) => b.id - a.id)[0];
      return responder(
        ultima === undefined
          ? []
          : [{ id: ultima.id, status: ultima.status, checkpoint: ultima.checkpoint }],
      );
    }
    if (t.includes("SET checkpoint = $2::jsonb")) {
      // `escribirCheckpoint`: solo sobre una fila viva, como el SQL real.
      const fila = filas.find(
        (f) => f.id === Number(valores[0]) && f.status === "running",
      );
      if (fila === undefined) return responder([]);
      fila.checkpoint = JSON.parse(String(valores[1]));
      return responder([{ id: fila.id }]);
    }
    if (t.includes("AND status = 'running' AND finished_at IS NULL")) {
      // `reconciliarHuerfanas`: toda `running` del pipeline pasa a `failed`.
      // El checkpoint NO se toca: la huérfana conserva el último confirmado.
      const huerfanas = filas.filter(
        (f) => f.pipeline === String(valores[0]) && f.status === "running",
      );
      const muestra = JSON.parse(String(valores[1])) as MuestraDeError[];
      for (const f of huerfanas) {
        f.status = "failed";
        f.finishedAt = reloj();
        f.errorCount += 1;
        f.errorSamples = [...f.errorSamples, ...muestra];
      }
      return responder(
        huerfanas.map((f) => ({ id: f.id, requests_made: f.requestsMade })),
      );
    }
    if (t.includes("jsonb_array_elements")) {
      // `buscarCorteVigente`: las muestras que contienen las claves pedidas,
      // de la fila más reciente a la más antigua. El libro en memoria es un
      // solo ciclo, así que el filtro por `started_at` no aplica.
      const buscadas = JSON.parse(String(valores[1])) as Record<string, unknown>;
      const contiene = (m: MuestraDeError) =>
        Object.entries(buscadas).every(([k, v]) => m[k] === v);
      const salida = [...filas]
        .sort((a, b) => b.id - a.id)
        .flatMap((f) =>
          f.errorSamples
            .filter(contiene)
            .map((muestra) => ({ id: f.id, pipeline: f.pipeline, muestra })),
        );
      return responder(salida);
    }
    if (t.includes("coalesce(sum(requests_made)")) {
      const pipeline = String(valores[2]);
      const id = Number(valores[3]);
      const suma = (f: (x: FilaEnMemoria) => boolean) =>
        filas.filter(f).reduce((n, x) => n + x.requestsMade, 0);
      return responder([
        {
          total: suma(() => true),
          del_pipeline: suma((x) => x.pipeline === pipeline),
          de_esta: suma((x) => x.id === id),
        },
      ]);
    }
    if (t.includes("SET requests_made = requests_made +")) {
      const fila = filas.find((x) => x.id === Number(valores[1]));
      if (fila !== undefined) fila.requestsMade += Number(valores[0]);
      return responder([]);
    }
    if (/SET status\s+=\s+\$2/.test(t)) {
      const fila = filas.find((x) => x.id === Number(valores[0]));
      if (fila !== undefined) {
        fila.status = String(valores[1]);
        fila.finishedAt = reloj();
        // `cerrarEjecucion` pasa los dos jsonb ya serializados, como texto.
        const filasJson = valores[2];
        fila.rowsAffected =
          typeof filasJson === "string"
            ? (JSON.parse(filasJson) as Record<string, number>)
            : null;
        fila.errorCount = Number(valores[5]);
        const muestras = valores[6];
        fila.errorSamples =
          typeof muestras === "string"
            ? (JSON.parse(muestras) as MuestraDeError[])
            : [];
      }
      return responder([]);
    }
    // BEGIN, COMMIT, ROLLBACK, locks de ciclo, unlock: sin efecto.
    return responder([]);
  };

  return {
    ejecutor: { ejecutar },
    filas,
    sembrar(pipeline, requests, muestras = []) {
      filas.push({
        id: siguienteId++,
        pipeline,
        requestsMade: requests,
        status: muestras.length === 0 ? "succeeded" : "budget_stopped",
        errorCount: muestras.length,
        errorSamples: [...muestras],
        rowsAffected: null,
        checkpoint: null,
        finishedAt: reloj(),
      });
    },
    sembrarFila(fila) {
      const id = siguienteId++;
      filas.push({
        id,
        pipeline: fila.pipeline,
        requestsMade: fila.requestsMade ?? 0,
        status: fila.status,
        errorCount: 0,
        errorSamples: [],
        rowsAffected: null,
        checkpoint: fila.checkpoint ?? null,
        finishedAt:
          fila.finishedAt !== undefined
            ? fila.finishedAt
            : fila.status === "running"
              ? null
              : reloj(),
      });
      return id;
    },
  };
}
