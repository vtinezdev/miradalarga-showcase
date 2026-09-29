/**
 * Auditoría antes y después de una ejecución de `deltas`.
 *
 * ⚠️ **Solo `SELECT`.** Nada aquí escribe: se puede lanzar contra la rama de
 * validación en cualquier momento sin dejar rastro. Las comprobaciones que
 * deciden algo son **funciones puras** (`verificarCuadre`), para poder
 * probarlas sin base de datos.
 */
import type { EjecutorSql } from "../../ops/contratos.ts";
import type { CuotaDelProveedor } from "../../ops/cuota-proveedor.ts";

/**
 * Las 15 tablas del modelo v1 (ADR 0007 añadió los anuncios). Se recorre la
 * lista, **nunca el total de `public`**: `spike_ping` sigue en la rama y no es
 * del modelo.
 *
 * ⚠️ Exige la migración 0003 aplicada: sin ella, el recuento de
 * `external_availability_announcements` falla en la primera auditoría.
 */
export const TABLAS_DEL_MODELO = [
  "derived_ranking_definitions",
  "derived_ranking_entries",
  "external_availability",
  "external_availability_announcements",
  "external_availability_events",
  "external_availability_options",
  "external_genres",
  "external_list_captures",
  "external_list_positions",
  "external_platform_capabilities",
  "external_platforms",
  "external_title_genres",
  "external_title_images",
  "external_titles",
  "ops_sync_runs",
] as const;

/** Las tablas cuyo vacío es la precondición de la primera ejecución. */
export const TABLAS_DE_CATALOGO = [
  "external_titles",
  "external_availability",
  "external_availability_options",
  "external_availability_events",
] as const;

export async function contarTablas(
  ejecutor: EjecutorSql,
): Promise<Record<string, number>> {
  const salida: Record<string, number> = {};
  for (const tabla of TABLAS_DEL_MODELO) {
    const filas = await ejecutor.ejecutar<{ total: number }>(
      `SELECT count(*)::int AS total FROM ${tabla}`,
    );
    salida[tabla] = filas[0]?.total ?? -1;
  }
  return salida;
}

/** Qué tablas cambiaron de recuento entre dos fotos. */
export function diferenciaDeRecuentos(
  antes: Readonly<Record<string, number>>,
  despues: Readonly<Record<string, number>>,
): Record<string, number> {
  const salida: Record<string, number> = {};
  for (const tabla of Object.keys({ ...antes, ...despues })) {
    const d = (despues[tabla] ?? 0) - (antes[tabla] ?? 0);
    if (d !== 0) salida[tabla] = d;
  }
  return salida;
}

export interface LibroDelCiclo {
  readonly total: number;
  readonly delPipeline: number;
  readonly vivasDelPipeline: number;
}

/** El libro interno del ciclo, con la misma aritmética que `reservar()`. */
export async function leerLibroDelCiclo(
  ejecutorOps: EjecutorSql,
  ciclo: { readonly inicio: Date; readonly fin: Date },
  pipeline: string,
): Promise<LibroDelCiclo> {
  const filas = await ejecutorOps.ejecutar<{
    total: number;
    del_pipeline: number;
    vivas: number;
  }>(
    `SELECT coalesce(sum(requests_made), 0)::int AS total,
            coalesce(sum(requests_made) FILTER (WHERE pipeline = $3), 0)::int AS del_pipeline,
            count(*) FILTER (WHERE pipeline = $3 AND status = 'running')::int AS vivas
       FROM ops_sync_runs
      WHERE started_at >= $1 AND started_at < $2`,
    [ciclo.inicio, ciclo.fin, pipeline],
  );
  const f = filas[0];
  return {
    total: f?.total ?? 0,
    delPipeline: f?.del_pipeline ?? 0,
    vivasDelPipeline: f?.vivas ?? 0,
  };
}

export interface EventosAuditados {
  readonly porTipo: Readonly<Record<string, number>>;
  /** Eventos cuyo `before` es idéntico a su `after`: jamás deberían existir. */
  readonly sinCambio: number;
  readonly buckets: readonly string[];
  readonly claves: readonly {
    readonly tipo: string;
    readonly imdbId: string;
    readonly plataforma: string;
    readonly tipoOferta: string;
    readonly addon: string | null;
  }[];
}

/** Los eventos con `id > desdeId`, con la oferta que los emitió. */
export async function auditarEventos(
  ejecutor: EjecutorSql,
  desdeId: number,
): Promise<EventosAuditados> {
  const filas = await ejecutor.ejecutar<{
    event_type: string;
    sin_cambio: boolean;
    bucket: Date | string;
    imdb_id: string;
    platform_id: string;
    offer_type: string;
    addon: string | null;
  }>(
    `SELECT e.event_type, (e.before = e.after) AS sin_cambio,
            e.dedupe_bucket_at AS bucket,
            t.imdb_id, a.platform_id, a.offer_type, a.addon
       FROM external_availability_events e
       JOIN external_availability a ON a.id = e.availability_id
       JOIN external_titles t ON t.id = a.title_id
      WHERE e.id > $1
      ORDER BY e.id`,
    [desdeId],
  );

  const porTipo: Record<string, number> = {};
  const buckets = new Set<string>();
  let sinCambio = 0;
  for (const f of filas) {
    porTipo[f.event_type] = (porTipo[f.event_type] ?? 0) + 1;
    if (f.sin_cambio) sinCambio++;
    buckets.add(new Date(f.bucket).toISOString());
  }
  return {
    porTipo,
    sinCambio,
    buckets: [...buckets],
    claves: filas.map((f) => ({
      tipo: f.event_type,
      imdbId: f.imdb_id,
      plataforma: f.platform_id,
      tipoOferta: f.offer_type,
      addon: f.addon,
    })),
  };
}

export async function maximoIdDeEventos(ejecutor: EjecutorSql): Promise<number> {
  const filas = await ejecutor.ejecutar<{ maximo: number }>(
    "SELECT coalesce(max(id), 0)::bigint::int AS maximo FROM external_availability_events",
  );
  return filas[0]?.maximo ?? 0;
}

/** Opciones duplicadas por su clave natural. El `UNIQUE` lo impide: se verifica igual. */
export async function contarOpcionesDuplicadas(ejecutor: EjecutorSql): Promise<number> {
  const filas = await ejecutor.ejecutar<{ total: number }>(
    `SELECT count(*)::int AS total FROM (
       SELECT 1 FROM external_availability_options
        GROUP BY availability_id, link, quality HAVING count(*) > 1) d`,
  );
  return filas[0]?.total ?? -1;
}

// ── El cuadre de requests: función pura ─────────────────────────────────────

export interface Comprobacion {
  readonly nombre: string;
  readonly ok: boolean;
  readonly detalle: string;
}

/**
 * Cinco contadores de la misma cuota, que tienen que coincidir.
 *
 * `requests_made` es la verdad del libro interno. Las reservas las cuenta el
 * job; el Δ del libro, la base; y el Δ de `x-quota-used`, **el proveedor**.
 * Este último se compara solo si hubo al menos una lectura y ninguna otra
 * ejecución usó la clave a la vez; si no, se dice que no es comparable, no se
 * da por bueno.
 */
export function verificarCuadre(entrada: {
  readonly requestsMade: number;
  readonly reservasConcedidas: number;
  readonly deltaDelLibro: number;
  readonly respuestas: number;
  readonly cuota: readonly CuotaDelProveedor[];
}): readonly Comprobacion[] {
  const { requestsMade, reservasConcedidas, deltaDelLibro, respuestas, cuota } =
    entrada;
  const salida: Comprobacion[] = [
    {
      nombre: "requests_made == reservas concedidas",
      ok: requestsMade === reservasConcedidas,
      detalle: `${String(requestsMade)} frente a ${String(reservasConcedidas)}`,
    },
    {
      nombre: "Δ del libro del ciclo == requests_made",
      ok: deltaDelLibro === requestsMade,
      detalle: `${String(deltaDelLibro)} frente a ${String(requestsMade)}`,
    },
    {
      // Una reserva sin respuesta es una caída entre reservar y recibir: se
      // tolera UNA, en la dirección segura (sobrecontar).
      nombre: "respuestas <= reservas <= respuestas + 1",
      ok: respuestas <= reservasConcedidas && reservasConcedidas <= respuestas + 1,
      detalle: `${String(respuestas)} respuestas · ${String(reservasConcedidas)} reservas`,
    },
  ];

  const primera = cuota[0];
  const ultima = cuota[cuota.length - 1];
  if (primera === undefined || ultima === undefined) {
    salida.push({
      nombre: "Δ x-quota-used del proveedor == requests_made",
      ok: false,
      detalle: "SIN DATOS: ninguna respuesta trajo las cabeceras de cuota",
    });
  } else {
    // La primera lectura ya incluye su propia request: +1.
    const deltaProveedor = ultima.usada - primera.usada + 1;
    salida.push({
      nombre: "Δ x-quota-used del proveedor == respuestas con cabecera",
      ok: deltaProveedor === cuota.length,
      detalle:
        `x-quota-used ${String(primera.usada)} → ${String(ultima.usada)} ` +
        `(Δ ${String(deltaProveedor)}) frente a ${String(cuota.length)} lecturas`,
    });
  }
  return salida;
}
