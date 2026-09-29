/**
 * Dobles para probar el pipeline de deltas **sin base de datos y sin red**.
 *
 * El ejecutor falso no simula PostgreSQL: reconstruye lo justo para que
 * `upsert()` funcione —devuelve una fila por tupla, con las columnas que el
 * `RETURNING` pidió— y registra cada sentencia para poder afirmar sobre ellas.
 *
 * ⚠️ **Limitación deliberada:** todo `INSERT` devuelve un `id` nuevo, también
 * cuando en PostgreSQL habría habido conflicto y el `ON CONFLICT DO UPDATE`
 * habría devuelto el de la fila existente. Ningún test debe depender del `id`
 * que sale de aquí para una fila que ya existía: para eso está el estado
 * anterior, que sí lleva los identificadores de verdad.
 */
import type { EjecutorSql } from "../../jobs/pipelines/deltas/contratos.ts";
import type { Transporte } from "../../jobs/ops/transporte.ts";

export interface Sentencia {
  readonly texto: string;
  readonly valores: readonly unknown[];
}

export interface EjecutorFalso {
  readonly ejecutor: EjecutorSql;
  readonly sentencias: readonly Sentencia[];
  /** Las sentencias cuyo texto contiene un fragmento. */
  buscar(fragmento: string): readonly Sentencia[];
}

/** El nombre de la tabla y su lista de columnas. `\s*` porque el SQL va en varias líneas. */
const CABECERA = /^INSERT INTO (\w+)\s*\(([^)]*)\)/;

/**
 * @param estadoAnterior filas que devuelve la consulta del estado anterior.
 */
export function crearEjecutorFalso(
  estadoAnterior: readonly Record<string, unknown>[] = [],
): EjecutorFalso {
  const sentencias: Sentencia[] = [];
  let siguienteId = 1000;

  const ejecutar = <T>(
    texto: string,
    valores: readonly unknown[] = [],
  ): Promise<readonly T[]> => {
    sentencias.push({ texto, valores });

    if (texto.includes("FROM external_availability a")) {
      return Promise.resolve(estadoAnterior as readonly T[]);
    }

    const cabecera = CABECERA.exec(texto.trim());
    if (cabecera === null) return Promise.resolve([]);

    const columnas = (cabecera[2] ?? "")
      .split(",")
      .map((c) => c.trim().replace(/"/g, ""));
    if (columnas.length === 0) return Promise.resolve([]);

    // `upsert()` empuja los valores de todas las tuplas en un solo array, en
    // orden: se recuperan troceando por el número de columnas.
    const filas: Record<string, unknown>[] = [];
    for (let i = 0; i + columnas.length <= valores.length; i += columnas.length) {
      const fila: Record<string, unknown> = { insertada: true, id: siguienteId++ };
      columnas.forEach((columna, j) => {
        fila[columna] = valores[i + j];
      });
      filas.push(fila);
    }
    return Promise.resolve(filas as readonly T[]);
  };

  return {
    ejecutor: { ejecutar },
    sentencias,
    buscar: (fragmento) => sentencias.filter((s) => s.texto.includes(fragmento)),
  };
}

/** Las filas que un `INSERT` llevaba dentro, reconstruidas columna a columna. */
export function filasInsertadas(
  sentencias: readonly Sentencia[],
  tabla: string,
): readonly Record<string, unknown>[] {
  const salida: Record<string, unknown>[] = [];

  for (const sentencia of sentencias) {
    const cabecera = CABECERA.exec(sentencia.texto.trim());
    if (cabecera?.[1] !== tabla) continue;

    const columnas = (cabecera[2] ?? "")
      .split(",")
      .map((c) => c.trim().replace(/"/g, ""));
    const valores = sentencia.valores;
    for (let i = 0; i + columnas.length <= valores.length; i += columnas.length) {
      const fila: Record<string, unknown> = {};
      columnas.forEach((columna, j) => {
        fila[columna] = valores[i + j];
      });
      salida.push(fila);
    }
  }
  return salida;
}

// ── Construcción de respuestas de /changes ──────────────────────────────────

export interface OpcionCruda {
  readonly service: string;
  readonly type: string;
  readonly link: string;
  readonly quality?: string;
  readonly price?: { amount: string; currency: string };
  readonly addon?: string;
  readonly availableSince?: number;
  readonly expiresOn?: number;
  /** Por defecto, `["spa"]`, en este orden. */
  readonly audios?: readonly string[];
  /** Por defecto, `["spa"]`, en este orden. */
  readonly subtitulos?: readonly string[];
  readonly videoLink?: string;
}

export function showCrudo(entrada: {
  readonly id: string;
  readonly imdbId: string;
  readonly opciones?: readonly OpcionCruda[];
}): Record<string, unknown> {
  return {
    itemType: "show",
    showType: "movie",
    id: entrada.id,
    imdbId: entrada.imdbId,
    tmdbId: `movie/${entrada.id}`,
    title: `Título ${entrada.id}`,
    rating: 70,
    releaseYear: 2024,
    genres: [{ id: "drama", name: "Drama" }],
    streamingOptions: {
      es: (entrada.opciones ?? []).map((o) => ({
        service: { id: o.service, name: o.service },
        type: o.type,
        link: o.link,
        ...(o.quality === undefined ? {} : { quality: o.quality }),
        ...(o.price === undefined ? {} : { price: o.price }),
        ...(o.addon === undefined ? {} : { addon: { id: o.addon, name: o.addon } }),
        audios: (o.audios ?? ["spa"]).map((language) => ({ language })),
        subtitles: (o.subtitulos ?? ["spa"]).map((language) => ({
          locale: { language },
        })),
        ...(o.videoLink === undefined ? {} : { videoLink: o.videoLink }),
        ...(o.availableSince === undefined ? {} : { availableSince: o.availableSince }),
        ...(o.expiresOn === undefined ? {} : { expiresOn: o.expiresOn }),
      })),
    },
  };
}

export interface CambioCrudo {
  readonly changeType: string;
  readonly showId: string;
  readonly service: string;
  readonly type: string;
  readonly link?: string;
  readonly addon?: string;
  readonly timestamp: number;
}

export function respuestaCruda(entrada: {
  readonly cambios: readonly CambioCrudo[];
  readonly shows: readonly Record<string, unknown>[];
  readonly hasMore?: boolean;
  readonly nextCursor?: string;
}): Record<string, unknown> {
  const shows: Record<string, unknown> = {};
  for (const show of entrada.shows) shows[String(show.id)] = show;

  // La forma del CUERPO HTTP: todo en la raiz. El `{meta, body}` es el formato
  // de `spike-1/raw/`, no el del proveedor.
  return {
    changes: entrada.cambios.map((c) => ({
      changeType: c.changeType,
      itemType: "show",
      showId: c.showId,
      showType: "movie",
      service: { id: c.service, name: c.service },
      streamingOptionType: c.type,
      ...(c.addon === undefined ? {} : { addon: { id: c.addon, name: c.addon } }),
      ...(c.link === undefined ? {} : { link: c.link }),
      timestamp: c.timestamp,
    })),
    shows,
    hasMore: entrada.hasMore ?? false,
    ...(entrada.nextCursor === undefined ? {} : { nextCursor: entrada.nextCursor }),
  };
}

export interface TransporteFalso {
  readonly transporte: Transporte;
  readonly urls: readonly string[];
  readonly cuotasPedidas: () => number;
}

/** Devuelve una respuesta por llamada, en orden. Cuenta las reservas de cuota. */
export function crearTransporteFalso(
  respuestas: readonly Record<string, unknown>[],
): TransporteFalso {
  const urls: string[] = [];
  let cuotas = 0;

  const transporte: Transporte = (url) => {
    // El transporte real reserva cuota antes de cada llamada; aquí se cuenta
    // lo mismo: una por petición, nunca una por aviso.
    cuotas++;
    urls.push(url);
    const cuerpo = respuestas[urls.length - 1] ?? { changes: [], shows: {} };
    return Promise.resolve(
      new Response(JSON.stringify(cuerpo), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };

  return { transporte, urls, cuotasPedidas: () => cuotas };
}
