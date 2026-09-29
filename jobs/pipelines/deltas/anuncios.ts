/**
 * **Un aviso `upcoming` es un anuncio, no disponibilidad** (ADR 0007).
 *
 * Se guarda en `external_availability_announcements`, una fila por oferta
 * anunciada —`(título, plataforma, país, tipo, addon)`—, y **nunca** en
 * `external_availability_options`, que solo guarda lo observado en el
 * catálogo. Un anuncio no sintetiza opciones, no toca las reales y no emite
 * eventos de disponibilidad.
 *
 * ── Qué hace una observación con la fila de su oferta ───────────────────────
 *
 * Todo sale de comparar el `ahora` de la observación con el `last_seen_at` de
 * la fila, igual que `last_checked_at` en las ofertas (`opciones.ts`):
 *
 *   · **sin fila** → se inserta; `first_*` = esta observación.
 *   · `ahora` **anterior** → **fuera de orden**: es más vieja que lo ya
 *     aplicado. No escribe nada.
 *   · `ahora` **igual** → **la misma observación**: otra página de la misma
 *     ejecución (📏 los 9 repetidos de frontera de la fila 50) o una
 *     reproducción. Con los mismos datos, nada. Con **otra fecha**, o con
 *     **otro link no nulo** frente a uno ya conocido, **conflicto**: se
 *     conserva lo ya escrito y se reporta. ⚖️ No hay política para elegir
 *     entre dos fechas simultáneas: 📏 0 de 54 ofertas de la fila 50 las
 *     tenían, y no se inventa una sin haber visto el caso. Un link que llega
 *     donde solo había `NULL` **se completa**: no contradice nada.
 *   · `ahora` **posterior** → observación nueva, y decide el ciclo:
 *       – `announced_for > ahora`: **mismo ciclo**. Se actualiza la fecha —un
 *         aplazamiento es la misma fila—; `first_*` se conservan.
 *       – `announced_for <= ahora`: el anuncio anterior ya venció, y este es
 *         **un ciclo nuevo** —otra temporada, una reposición—: `first_seen_at`
 *         y `first_announced_for` se reinician.
 *
 * ⚖️ **El link (2026-09-24):**
 *
 *   · **Mismo ciclo**: un link no nulo posterior **sustituye** al conocido; un
 *     `NULL` posterior **no lo borra**. `NULL` es «no consta» (invariante 4),
 *     no «ya no hay link»: 📏 Prime anuncia sin él.
 *   · **Ciclo nuevo**: **no se hereda** el link del ciclo anterior —puede ser
 *     el de otra temporada—. Se usa el de la observación, `NULL` incluido.
 *   · Un link nulo **se guarda**: el anuncio existe aunque no sepamos dónde.
 *
 * Una observación aplicada escribe siempre `last_seen_at` y
 * `last_seen_run_id`: de ellos salen las desapariciones
 * (`upcoming/horizonte.ts`).
 */
import type { AvisoCanonico } from "../../adapters/contracts.ts";
import { claveDeOferta } from "../seed/filas.ts";
import { plataformaDesdeFuente } from "../seed/plataformas.ts";
import type {
  ConflictoDeAnuncio,
  EjecutorSql,
  InformeDeAnuncios,
} from "./contratos.ts";
import { PAIS } from "./contratos.ts";

/** Un aviso `upcoming` ya atribuido a un título y a una plataforma del MVP. */
export interface AnuncioObservado {
  /** `claveDeOferta`: la identidad del anuncio. */
  readonly clave: string;
  readonly imdbId: string;
  /** Nuestro `id` (`max`, no `hbo`). */
  readonly plataforma: string;
  readonly tipoOferta: string;
  readonly addon: string | null;
  readonly anunciadoPara: Date;
  /** `null` = no consta. Se guarda así. */
  readonly enlace: string | null;
}

/** Una fila de `external_availability_announcements`. */
export interface AnuncioGuardado {
  /** `null` si todavía no existe en la base: la insertará esta página. */
  readonly id: string | null;
  readonly anunciadoPara: Date;
  readonly primeraFechaAnunciada: Date;
  readonly enlace: string | null;
  readonly vistoPrimeroEn: Date;
  readonly vistoUltimoEn: Date;
  readonly ultimaEjecucion: number | null;
}

export type DecisionDeAnuncio =
  | { readonly tipo: "nuevo"; readonly fila: AnuncioGuardado }
  | {
      readonly tipo: "mismo_ciclo";
      readonly fila: AnuncioGuardado;
      readonly fechaCambiada: boolean;
      /** Llegó un link no nulo distinto del conocido. */
      readonly enlaceCambiado: boolean;
      /** Llegó `NULL` y se conservó el link conocido. */
      readonly enlaceConservado: boolean;
    }
  | { readonly tipo: "enlace_completado"; readonly fila: AnuncioGuardado }
  | { readonly tipo: "nuevo_ciclo"; readonly fila: AnuncioGuardado }
  | { readonly tipo: "misma_observacion" }
  | { readonly tipo: "fuera_de_orden" }
  | { readonly tipo: "conflicto"; readonly conflicto: ConflictoDeAnuncio };

const mismoInstante = (a: Date, b: Date) => a.getTime() === b.getTime();

/**
 * Qué hace **una** observación con la fila de su oferta. Función pura: la
 * cabecera del fichero es su especificación.
 */
export function decidirAnuncio(
  existente: AnuncioGuardado | undefined,
  observado: AnuncioObservado,
  ahora: Date,
  runId: number | null,
): DecisionDeAnuncio {
  const visto = {
    anunciadoPara: observado.anunciadoPara,
    enlace: observado.enlace,
    vistoUltimoEn: ahora,
    ultimaEjecucion: runId,
  };

  if (existente === undefined) {
    return {
      tipo: "nuevo",
      fila: {
        id: null,
        ...visto,
        primeraFechaAnunciada: observado.anunciadoPara,
        vistoPrimeroEn: ahora,
      },
    };
  }

  const ultima = existente.vistoUltimoEn.getTime();
  if (ultima > ahora.getTime()) return { tipo: "fuera_de_orden" };

  const fechaCambiada = !mismoInstante(
    existente.anunciadoPara,
    observado.anunciadoPara,
  );
  // Un `NULL` observado no dice nada del link: ni lo cambia ni lo contradice.
  const enlaceCambiado =
    observado.enlace !== null && observado.enlace !== existente.enlace;
  const enlaceContradice = enlaceCambiado && existente.enlace !== null;

  if (ultima === ahora.getTime()) {
    if (!fechaCambiada && !enlaceCambiado) return { tipo: "misma_observacion" };
    if (!fechaCambiada && !enlaceContradice) {
      // Solo había `NULL`: el link se completa, sin tocar nada más.
      return {
        tipo: "enlace_completado",
        fila: { ...existente, enlace: observado.enlace, ultimaEjecucion: runId },
      };
    }
    return {
      tipo: "conflicto",
      conflicto: {
        clave: observado.clave,
        vigente: {
          anunciadoPara: existente.anunciadoPara.toISOString(),
          enlace: existente.enlace,
        },
        descartado: {
          anunciadoPara: observado.anunciadoPara.toISOString(),
          enlace: observado.enlace,
        },
      },
    };
  }

  if (existente.anunciadoPara.getTime() > ahora.getTime()) {
    return {
      tipo: "mismo_ciclo",
      // Un `NULL` posterior no borra el link conocido.
      fila: { ...existente, ...visto, enlace: observado.enlace ?? existente.enlace },
      fechaCambiada,
      enlaceCambiado,
      enlaceConservado: observado.enlace === null && existente.enlace !== null,
    };
  }
  // Ciclo nuevo: el link del ciclo anterior NO se hereda, tampoco si llega NULL.
  return {
    tipo: "nuevo_ciclo",
    fila: {
      ...existente,
      ...visto,
      primeraFechaAnunciada: observado.anunciadoPara,
      vistoPrimeroEn: ahora,
    },
  };
}

/** Lo que una página tiene que escribir, y lo que se cuenta de ella. */
export interface PlanDeAnuncios {
  /** Por clave, la fila **final** tras todas las observaciones de la página. */
  readonly escrituras: ReadonlyMap<
    string,
    { readonly observado: AnuncioObservado; readonly fila: AnuncioGuardado }
  >;
  readonly informe: InformeDeAnuncios;
}

/** Un informe a cero. */
export function informeDeAnunciosVacio(): InformeDeAnuncios {
  return {
    observados: 0,
    nuevos: 0,
    sinCambios: 0,
    actualizados: 0,
    fechasCambiadas: 0,
    enlacesCambiados: 0,
    nuevosCiclos: 0,
    mismaObservacion: 0,
    enlacesCompletados: 0,
    enlacesConservados: 0,
    fueraDeOrden: 0,
    sinEnlace: 0,
    conflictos: [],
  };
}

/** Suma dos informes: el de la ejecución y el de una página confirmada. */
export function sumarInformesDeAnuncios(
  a: InformeDeAnuncios,
  b: InformeDeAnuncios,
): InformeDeAnuncios {
  return {
    observados: a.observados + b.observados,
    nuevos: a.nuevos + b.nuevos,
    sinCambios: a.sinCambios + b.sinCambios,
    actualizados: a.actualizados + b.actualizados,
    fechasCambiadas: a.fechasCambiadas + b.fechasCambiadas,
    enlacesCambiados: a.enlacesCambiados + b.enlacesCambiados,
    nuevosCiclos: a.nuevosCiclos + b.nuevosCiclos,
    mismaObservacion: a.mismaObservacion + b.mismaObservacion,
    enlacesCompletados: a.enlacesCompletados + b.enlacesCompletados,
    enlacesConservados: a.enlacesConservados + b.enlacesConservados,
    fueraDeOrden: a.fueraDeOrden + b.fueraDeOrden,
    sinEnlace: a.sinEnlace + b.sinEnlace,
    conflictos: [...a.conflictos, ...b.conflictos],
  };
}

/**
 * Las observaciones de una página, **en el orden del proveedor**, contra lo
 * que ya hay en la base. La segunda observación de una clave dentro de la
 * página se decide contra el resultado de la primera: es la misma observación
 * (`ahora` igual), así que repite, completa un link o entra en conflicto;
 * nunca pisa. El resultado no depende del orden en que lleguen un aviso con
 * link y otro sin él.
 */
export function planificarAnuncios(
  existentes: ReadonlyMap<string, AnuncioGuardado>,
  observados: readonly AnuncioObservado[],
  ahora: Date,
  runId: number | null,
): PlanDeAnuncios {
  const actuales = new Map(existentes);
  const escrituras = new Map<
    string,
    { observado: AnuncioObservado; fila: AnuncioGuardado }
  >();
  const i = { ...informeDeAnunciosVacio(), conflictos: [] as ConflictoDeAnuncio[] };

  for (const observado of observados) {
    i.observados++;
    if (observado.enlace === null) i.sinEnlace++;

    const decision = decidirAnuncio(
      actuales.get(observado.clave),
      observado,
      ahora,
      runId,
    );
    switch (decision.tipo) {
      case "fuera_de_orden":
        i.fueraDeOrden++;
        continue;
      case "misma_observacion":
        i.mismaObservacion++;
        continue;
      case "conflicto":
        i.conflictos.push(decision.conflicto);
        continue;
      case "nuevo":
        i.nuevos++;
        break;
      case "nuevo_ciclo":
        i.nuevosCiclos++;
        break;
      case "enlace_completado":
        i.enlacesCompletados++;
        break;
      case "mismo_ciclo":
        if (decision.fechaCambiada || decision.enlaceCambiado) i.actualizados++;
        else i.sinCambios++;
        if (decision.fechaCambiada) i.fechasCambiadas++;
        if (decision.enlaceCambiado) i.enlacesCambiados++;
        if (decision.enlaceConservado) i.enlacesConservados++;
        break;
    }
    actuales.set(observado.clave, decision.fila);
    escrituras.set(observado.clave, { observado, fila: decision.fila });
  }

  return { escrituras, informe: i };
}

/**
 * Los avisos `upcoming` de una página que **se pueden decidir**: con su show
 * —sin él no hay título al que atribuirlos— y de una plataforma del MVP. En el
 * orden en que llegaron.
 */
export function anunciosObservados(
  avisosPorImdb: ReadonlyMap<string, readonly AvisoCanonico[]>,
): readonly AnuncioObservado[] {
  const salida: AnuncioObservado[] = [];
  for (const [imdbId, avisos] of avisosPorImdb) {
    for (const aviso of avisos) {
      if (aviso.tipo !== "upcoming") continue;
      const plataforma = plataformaDesdeFuente(aviso.plataformaId);
      if (plataforma === null) continue;
      salida.push({
        clave: claveDeOferta(imdbId, plataforma, aviso.tipoOferta, aviso.addon),
        imdbId,
        plataforma,
        tipoOferta: aviso.tipoOferta,
        addon: aviso.addon,
        anunciadoPara: aviso.instante,
        enlace: aviso.enlace,
      });
    }
  }
  return salida;
}

// ── SQL ─────────────────────────────────────────────────────────────────────

/**
 * ⚠️ El alias es `anuncio`, que **no** es `a`: la lectura del estado anterior
 * de las ofertas se reconoce en los dobles de los tests por
 * `FROM external_availability a`.
 */
const SQL_LEER = `
  SELECT t.imdb_id, anuncio.id, anuncio.platform_id, anuncio.offer_type, anuncio.addon,
         anuncio.announced_for, anuncio.first_announced_for, anuncio.link,
         anuncio.first_seen_at, anuncio.last_seen_at, anuncio.last_seen_run_id
    FROM external_availability_announcements anuncio
    JOIN external_titles t ON t.id = anuncio.title_id
   WHERE anuncio.country = $1 AND t.imdb_id = ANY($2::text[])`;

const SQL_INSERTAR = `
  INSERT INTO external_availability_announcements
    (title_id, platform_id, country, offer_type, addon, announced_for,
     first_announced_for, link, first_seen_at, last_seen_at, last_seen_run_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`;

/**
 * La guarda `last_seen_at <= $6` repite en la base la regla de orden: una
 * escritura nunca pisa una observación **posterior**. Si la fila avanzó entre
 * la lectura y la escritura, no se actualiza, y el `RETURNING` vacío hace
 * fallar la página en vez de pisarla en silencio. El `=` es el de un link que
 * se completa dentro de la misma observación.
 */
const SQL_ACTUALIZAR = `
  UPDATE external_availability_announcements
     SET announced_for = $2, first_announced_for = $3, link = $4,
         first_seen_at = $5, last_seen_at = $6, last_seen_run_id = $7
   WHERE id = $1 AND last_seen_at <= $6
  RETURNING id`;

interface FilaDeAnuncio {
  readonly imdb_id: string;
  readonly id: string | number;
  readonly platform_id: string;
  readonly offer_type: string;
  readonly addon: string | null;
  readonly announced_for: Date | string;
  readonly first_announced_for: Date | string;
  readonly link: string | null;
  readonly first_seen_at: Date | string;
  readonly last_seen_at: Date | string;
  readonly last_seen_run_id: string | number | null;
}

const fecha = (v: Date | string) => (v instanceof Date ? v : new Date(v));

/** Los anuncios ya guardados de estos títulos, por clave. */
export async function leerAnuncios(
  ejecutor: EjecutorSql,
  imdbIds: readonly string[],
): Promise<ReadonlyMap<string, AnuncioGuardado>> {
  if (imdbIds.length === 0) return new Map();
  const filas = await ejecutor.ejecutar<FilaDeAnuncio>(SQL_LEER, [PAIS, [...imdbIds]]);
  const salida = new Map<string, AnuncioGuardado>();
  for (const f of filas) {
    salida.set(claveDeOferta(f.imdb_id, f.platform_id, f.offer_type, f.addon), {
      id: String(f.id),
      anunciadoPara: fecha(f.announced_for),
      primeraFechaAnunciada: fecha(f.first_announced_for),
      enlace: f.link,
      vistoPrimeroEn: fecha(f.first_seen_at),
      vistoUltimoEn: fecha(f.last_seen_at),
      ultimaEjecucion: f.last_seen_run_id === null ? null : Number(f.last_seen_run_id),
    });
  }
  return salida;
}

/**
 * Escribe el plan de una página, **dentro de su transacción**. Devuelve
 * cuántas filas tocó. Los títulos tienen que estar ya escritos: el `id` de
 * cada uno llega en `idsDeTitulo`.
 */
export async function escribirAnuncios(
  ejecutor: EjecutorSql,
  plan: PlanDeAnuncios,
  idsDeTitulo: ReadonlyMap<string, unknown>,
): Promise<number> {
  let filas = 0;
  for (const { observado, fila } of plan.escrituras.values()) {
    if (fila.id === null) {
      const titleId = idsDeTitulo.get(observado.imdbId);
      if (titleId === undefined) {
        throw new Error(`Anuncio sin título escrito: ${observado.clave}`);
      }
      await ejecutor.ejecutar(SQL_INSERTAR, [
        titleId,
        observado.plataforma,
        PAIS,
        observado.tipoOferta,
        observado.addon,
        fila.anunciadoPara,
        fila.primeraFechaAnunciada,
        fila.enlace,
        fila.vistoPrimeroEn,
        fila.vistoUltimoEn,
        fila.ultimaEjecucion,
      ]);
    } else {
      const actualizadas = await ejecutor.ejecutar<{ id: unknown }>(SQL_ACTUALIZAR, [
        fila.id,
        fila.anunciadoPara,
        fila.primeraFechaAnunciada,
        fila.enlace,
        fila.vistoPrimeroEn,
        fila.vistoUltimoEn,
        fila.ultimaEjecucion,
      ]);
      if (actualizadas.length !== 1) {
        throw new Error(
          `El anuncio ${observado.clave} cambió entre la lectura y la escritura: ` +
            "no se pisa.",
        );
      }
    }
    filas++;
  }
  return filas;
}
