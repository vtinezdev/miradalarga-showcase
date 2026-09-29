/**
 * Cómo compara `db:validate:checkpoint` lo que escribió con lo que lee de
 * Neon. **Funciones puras**, sin conexión: se importan desde el validador y
 * desde los tests.
 *
 * ── El falso negativo que esto corrige (2026-09-23) ─────────────────────────
 *
 * `ops_sync_runs.id` es `bigint`, y el driver de Neon —como `pg`— devuelve
 * `int8` como **texto**: un `INSERT … RETURNING id` da `"33"`. En cambio
 * `leerUltimoCheckpoint` lo normaliza a `33`. Comparados con `===`, la misma
 * fila parecía otra: 21/22 con el mecanismo funcionando.
 *
 * `jobs/ops` ya normaliza sus ids en la frontera (`idDeEjecucion`). Este
 * comparador sigue haciendo falta porque el validador inserta filas con SQL
 * propio y recibe el id crudo del driver.
 *
 * Por eso aquí nada se compara «tal cual»:
 *
 *   · un `runId` se normaliza a su valor entero, venga como número o texto;
 *   · un checkpoint se **valida con el schema v1** y se compara campo a campo,
 *     por su significado —nunca con `JSON.stringify` ni por el orden de las
 *     claves, que `jsonb` reordena a su manera—.
 */
import type { CheckpointDeDeltas } from "../jobs/pipelines/deltas/checkpoint.ts";
import { checkpointV1 } from "../jobs/pipelines/deltas/checkpoint.ts";

/** Un id de `ops_sync_runs`, ya normalizado. `null` si no es un entero. */
export function idNormalizado(valor: unknown): bigint | null {
  if (typeof valor === "bigint") return valor;
  if (typeof valor === "number" && Number.isSafeInteger(valor)) return BigInt(valor);
  if (typeof valor === "string" && /^\d+$/.test(valor.trim()))
    return BigInt(valor.trim());
  return null;
}

/** ¿Son la misma fila? Da igual que el driver la devuelva como número o texto. */
export function mismoRunId(a: unknown, b: unknown): boolean {
  const x = idNormalizado(a);
  const y = idNormalizado(b);
  return x !== null && y !== null && x === y;
}

/** Para el informe: el valor y su tipo, que es justo lo que ocultaba el fallo. */
export function describirId(valor: unknown): string {
  return `${JSON.stringify(valor)} (${typeof valor})`;
}

export interface ComparacionDeCheckpoints {
  readonly iguales: boolean;
  /** Una línea por campo que difiere, o por lado que no es un v1 válido. */
  readonly diferencias: readonly string[];
  readonly esperado: CheckpointDeDeltas | null;
  readonly observado: CheckpointDeDeltas | null;
}

function validar(
  lado: string,
  valor: unknown,
  diferencias: string[],
): CheckpointDeDeltas | null {
  const r = checkpointV1.safeParse(valor);
  if (r.success) return r.data;
  const problemas = r.error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`)
    .join("; ");
  diferencias.push(`${lado} no es un checkpoint v1 válido — ${problemas}`);
  return null;
}

/** El mismo instante, aunque el texto difiera en la precisión de los ms. */
function mismoInstante(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return Date.parse(a) === Date.parse(b);
}

/**
 * Compara dos checkpoints **por sus campos semánticos**, tras validarlos con
 * el schema v1. El orden de `tipos` sí importa —es el orden de recorrido—; el
 * orden de las claves del objeto, no.
 */
export function compararCheckpoints(
  esperado: unknown,
  observado: unknown,
): ComparacionDeCheckpoints {
  const diferencias: string[] = [];
  const e = validar("esperado", esperado, diferencias);
  const o = validar("observado", observado, diferencias);
  if (e === null || o === null) {
    return { iguales: false, diferencias, esperado: e, observado: o };
  }

  const campo = (nombre: string, a: unknown, b: unknown, iguales: boolean): void => {
    if (!iguales) {
      diferencias.push(
        `${nombre}: esperado ${JSON.stringify(a)}, observado ${JSON.stringify(b)}`,
      );
    }
  };

  campo("v", e.v, o.v, e.v === o.v);
  campo(
    "ventana.from",
    e.ventana.from,
    o.ventana.from,
    e.ventana.from === o.ventana.from,
  );
  campo("ventana.to", e.ventana.to, o.ventana.to, e.ventana.to === o.ventana.to);
  campo(
    "tipos",
    e.tipos,
    o.tipos,
    e.tipos.length === o.tipos.length && e.tipos.every((t, i) => t === o.tipos[i]),
  );
  if (e.pendiente === null || o.pendiente === null) {
    campo("pendiente", e.pendiente, o.pendiente, e.pendiente === o.pendiente);
  } else {
    campo(
      "pendiente.changeType",
      e.pendiente.changeType,
      o.pendiente.changeType,
      e.pendiente.changeType === o.pendiente.changeType,
    );
    campo(
      "pendiente.cursorDeEntrada",
      e.pendiente.cursorDeEntrada,
      o.pendiente.cursorDeEntrada,
      e.pendiente.cursorDeEntrada === o.pendiente.cursorDeEntrada,
    );
  }
  campo(
    "paginasConfirmadas",
    e.paginasConfirmadas,
    o.paginasConfirmadas,
    e.paginasConfirmadas === o.paginasConfirmadas,
  );
  campo(
    "ultimoTimestampConfirmado",
    e.ultimoTimestampConfirmado,
    o.ultimoTimestampConfirmado,
    mismoInstante(e.ultimoTimestampConfirmado, o.ultimoTimestampConfirmado),
  );
  campo("reanudaDe", e.reanudaDe, o.reanudaDe, e.reanudaDe === o.reanudaDe);

  return { iguales: diferencias.length === 0, diferencias, esperado: e, observado: o };
}
