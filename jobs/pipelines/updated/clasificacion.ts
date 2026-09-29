/**
 * **Qué hizo cada aviso `updated`.** Función pura sobre el detalle por oferta
 * del núcleo (`InformeDeDeltas.detalle`): no lee la base ni la red, y dos
 * ejecuciones con el mismo detalle dan la misma clasificación.
 *
 * ── Por qué hace falta ───────────────────────────────────────────────────────
 *
 * 📏 **Un aviso `updated` no dice qué cambió.** Trae la oferta —plataforma,
 * tipo, addon, link— y un `timestamp`; ni campos, ni antes, ni después. Lo que
 * cambió solo se sabe comparando nuestro estado con el snapshot del show que
 * acompaña al aviso. Esta clasificación hace esa comparación **opción a
 * opción** y la separa en tres planos que no se mezclan:
 *
 *   · **persistencia técnica** — qué se escribe para que la base sea correcta
 *     (`camposCambiados`, incluidos los que el agregado no ve);
 *   · **evento técnico** — qué cambio del **agregado** de la oferta queda en
 *     `external_availability_events` (`comparar.ts`, sin tocar);
 *   · **valor editorial** — **no se decide aquí**. Los recuentos por
 *     plataforma y tipo de oferta existen para poder decidirlo después.
 *
 * ── Resultados de un aviso (uno y solo uno) ──────────────────────────────────
 *
 *   · `sin_show` · `fuera_del_mvp` — no se puede atribuir a una oferta nuestra.
 *   · `fuera_de_catalogo` — su título no está en la base: no se escribe.
 *   · `sin_oferta` — el título sí, pero ni la base ni el snapshot conocen la
 *     oferta: un `updated` solo no demuestra que exista.
 *   · `linea_base` — la base no la conocía y el snapshot sí: estado sin evento.
 *   · `misma_observacion` · `fuera_de_orden` — la oferta ya tenía aplicada esta
 *     observación, u otra posterior: no se escribe nada.
 *   · `repetido` — otro aviso de la misma página ya nombró la misma oferta.
 *   · `evento` — cambió el agregado: hay evento técnico.
 *   · `cambio_sin_efecto_en_agregado` — cambió algo con significado en una
 *     opción (un precio que no es el mínimo, un idioma que ya estaba en la
 *     unión…) sin mover el agregado: se persiste, sin evento.
 *   · `solo_metadatos` — solo `video_link` o el orden de los idiomas: se
 *     persiste, sin significado.
 *   · `no_op` — nada distinto.
 */
import type {
  AvisoDetallado,
  DetalleDeOfertas,
  EvaluacionDeOferta,
  OpcionDetallada,
  OpcionObservada,
} from "../deltas/contratos.ts";
import type { PrecioCanonico } from "../../adapters/contracts.ts";

export const RESULTADOS_DE_AVISO = [
  "sin_show",
  "fuera_del_mvp",
  "fuera_de_catalogo",
  "sin_oferta",
  "linea_base",
  "misma_observacion",
  "fuera_de_orden",
  "repetido",
  "evento",
  "cambio_sin_efecto_en_agregado",
  "solo_metadatos",
  "no_op",
] as const;

export type ResultadoDeAviso = (typeof RESULTADOS_DE_AVISO)[number];

/**
 * Campos de **opción** que pueden cambiar, con los nombres del esquema.
 * `language_order` no es un campo: es el mismo conjunto de idiomas en otro
 * orden, que el agregado no ve y que se cuenta para saber cuánto ruido es.
 */
export const CAMPOS_DE_OPCION = [
  "available_since",
  "audio_languages",
  "currency",
  "expires_at",
  "language_order",
  "link",
  "options",
  "price",
  "quality",
  "subtitle_languages",
  "video_link",
] as const;

export type CampoDeOpcion = (typeof CAMPOS_DE_OPCION)[number];

/** Los que no cambian nada que se publique. */
const CAMPOS_SIN_SIGNIFICADO: ReadonlySet<CampoDeOpcion> = new Set([
  "video_link",
  "language_order",
]);

export interface CambioDePrecio {
  readonly clave: string;
  readonly grupo: string;
  readonly link: string;
  readonly calidad: string | null;
  readonly antes: PrecioCanonico | null;
  readonly despues: PrecioCanonico | null;
}

/** Lo que se sabe de un grupo `plataforma/tipo de oferta` (`apple/buy`). */
export interface ClasificacionDeGrupo {
  readonly avisos: number;
  readonly resultados: Readonly<Partial<Record<ResultadoDeAviso, number>>>;
  readonly campos: Readonly<Partial<Record<CampoDeOpcion, number>>>;
  readonly preciosCambiados: number;
}

export interface InformeDeUpdated {
  /** Avisos `updated` confirmados. */
  readonly avisos: number;
  /** Por nuestro id de plataforma; el de la fuente si está fuera del MVP. */
  readonly porPlataforma: Readonly<Record<string, number>>;
  readonly porTipoDeOferta: Readonly<Record<string, number>>;
  /** Todos los resultados, con 0 si no hubo ninguno. */
  readonly porResultado: Readonly<Record<ResultadoDeAviso, number>>;
  /** `plataforma/tipo` → su distribución. */
  readonly porGrupo: Readonly<Record<string, ClasificacionDeGrupo>>;
  /** `tipo de oferta` → resultados: suscripción frente a transaccional. */
  readonly porTipoDeOfertaYResultado: Readonly<
    Record<string, Readonly<Partial<Record<ResultadoDeAviso, number>>>>
  >;
  /**
   * De los avisos **comparados** (resultado `evento`,
   * `cambio_sin_efecto_en_agregado`, `solo_metadatos` o `no_op`), cuántos
   * cambiaron cada campo de opción.
   */
  readonly camposCambiados: Readonly<Partial<Record<CampoDeOpcion, number>>>;
  readonly precios: {
    /** Opciones con otro importe, o con precio que aparece o desaparece. */
    readonly cambios: number;
    readonly suben: number;
    readonly bajan: number;
    readonly aparecen: number;
    readonly desaparecen: number;
    readonly cambiosDeMoneda: number;
    /** Las primeras 25, en orden de llegada. */
    readonly muestra: readonly CambioDePrecio[];
  };
  readonly eventos: {
    /** De las ofertas nombradas por un `updated`, por tipo de evento. */
    readonly deAvisos: Readonly<Record<string, number>>;
    readonly camposDeAvisos: Readonly<Record<string, number>>;
    /**
     * De las **otras** ofertas del mismo título que el snapshot trajo sin que
     * ningún aviso las nombrara: el snapshot es el catálogo completo del show.
     */
    readonly deAcompanantes: Readonly<Record<string, number>>;
    readonly camposDeAcompanantes: Readonly<Record<string, number>>;
  };
  /**
   * Opciones activas en la base que el snapshot de su oferta **ya no lista**
   * y que siguen activas porque `updated` no interpreta ausencias. 📏 Es lo
   * que deja un cambio de `link` o de calidad: la opción nueva entra y la
   * vieja no sale.
   */
  readonly opcionesQueSobrevivenSinVerse: number;
  /** Títulos con aviso que no se escribieron por no estar en la base. */
  readonly titulosFueraDeCatalogo: number;
}

// ── Comparación opción a opción ──────────────────────────────────────────────

function claveDeOpcion(o: { readonly link: string; readonly calidad: string | null }) {
  return JSON.stringify([o.link, o.calidad]);
}

/** Numérico: `4.99` y `4.990` son el mismo importe. Si no es un número, el texto. */
function mismoImporte(a: PrecioCanonico, b: PrecioCanonico): boolean {
  const na = Number(a.importe);
  const nb = Number(b.importe);
  return Number.isNaN(na) || Number.isNaN(nb) ? a.importe === b.importe : na === nb;
}

function mismoPrecio(a: PrecioCanonico | null, b: PrecioCanonico | null): boolean {
  if (a === null || b === null) return a === b;
  return a.moneda === b.moneda && mismoImporte(a, b);
}

function mismaFecha(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

function conjunto(valores: readonly string[]): string {
  return [...new Set(valores)].sort().join(",");
}

export interface DiferenciaDeOferta {
  readonly campos: ReadonlySet<CampoDeOpcion>;
  readonly precios: readonly {
    readonly link: string;
    readonly calidad: string | null;
    readonly antes: PrecioCanonico | null;
    readonly despues: PrecioCanonico | null;
  }[];
  readonly sobrevivenSinVerse: number;
}

/**
 * Qué cambia entre las opciones activas de la base y las del snapshot de la
 * misma oferta. Las opciones se emparejan por `(link, quality)`, la identidad
 * de la tabla: un cambio de link o de calidad es una opción que entra y otra
 * que no se vuelve a ver.
 */
export function diferenciaDeOferta(
  antes: readonly OpcionDetallada[],
  snapshot: readonly OpcionDetallada[],
  despues: readonly OpcionObservada[] | null,
): DiferenciaDeOferta {
  const campos = new Set<CampoDeOpcion>();
  const precios: DiferenciaDeOferta["precios"][number][] = [];

  // Los cambios de conjunto se miden contra lo que queda ESCRITO (`despues`:
  // el snapshot más lo que sobrevive sin verse), no contra el snapshot: una
  // opción conservada de una observación anterior no es un cambio de esta.
  const tras = despues ?? snapshot;
  const links = (xs: readonly OpcionObservada[]) => conjunto(xs.map((o) => o.link));
  const calidades = (xs: readonly OpcionObservada[]) =>
    conjunto(xs.map((o) => o.calidad ?? "∅"));
  if (links(antes) !== links(tras)) campos.add("link");
  if (calidades(antes) !== calidades(tras)) campos.add("quality");
  if (antes.length !== tras.length) campos.add("options");

  const delSnapshot = new Map(snapshot.map((o) => [claveDeOpcion(o), o]));
  let sobrevivenSinVerse = 0;

  for (const a of antes) {
    const d = delSnapshot.get(claveDeOpcion(a));
    if (d === undefined) {
      // `updated` no borra ni fusiona nada (tampoco una `(link, NULL)` que el
      // snapshot ya precisa): toda opción que no vuelve a verse sigue activa.
      sobrevivenSinVerse++;
      continue;
    }
    if (!mismoPrecio(a.precio, d.precio)) {
      if (a.precio === null || d.precio === null) campos.add("price");
      else {
        if (a.precio.moneda !== d.precio.moneda) campos.add("currency");
        if (!mismoImporte(a.precio, d.precio)) campos.add("price");
      }
      precios.push({
        link: a.link,
        calidad: a.calidad,
        antes: a.precio,
        despues: d.precio,
      });
    }
    const idiomas = [
      ["audio_languages", a.idiomasAudio, d.idiomasAudio],
      ["subtitle_languages", a.idiomasSubtitulos, d.idiomasSubtitulos],
    ] as const;
    for (const [campo, x, y] of idiomas) {
      if (conjunto(x) !== conjunto(y)) campos.add(campo);
      else if (x.join(",") !== y.join(",")) campos.add("language_order");
    }
    if (!mismaFecha(a.disponibleDesde, d.disponibleDesde))
      campos.add("available_since");
    if (!mismaFecha(a.expiraEl, d.expiraEl)) campos.add("expires_at");
    if (a.enlaceReproduccion !== d.enlaceReproduccion) campos.add("video_link");
  }

  return { campos, precios, sobrevivenSinVerse };
}

// ── La clasificación ─────────────────────────────────────────────────────────

function sumar<K extends string>(destino: Partial<Record<K, number>>, clave: K, n = 1) {
  destino[clave] = (destino[clave] ?? 0) + n;
}

function grupoDe(aviso: AvisoDetallado): string {
  return `${aviso.plataforma ?? aviso.plataformaFuente}/${aviso.tipoOferta}`;
}

function resultadoDeEvaluacion(
  e: EvaluacionDeOferta,
  diferencia: DiferenciaDeOferta | null,
  ahora: string,
): ResultadoDeAviso {
  switch (e.destino) {
    case "fuera_de_catalogo":
      return "fuera_de_catalogo";
    case "sin_oferta":
    case "retirada_sin_estado_previo":
      return "sin_oferta";
    case "linea_base":
      return "linea_base";
    case "observacion_ya_aplicada":
      return e.ultimaComprobacion === ahora ? "misma_observacion" : "fuera_de_orden";
    case "evaluada": {
      if (e.evento !== null) return "evento";
      const campos = [...(diferencia?.campos ?? [])];
      if (campos.length === 0) return "no_op";
      return campos.every((c) => CAMPOS_SIN_SIGNIFICADO.has(c))
        ? "solo_metadatos"
        : "cambio_sin_efecto_en_agregado";
    }
  }
}

const COMPARADOS: ReadonlySet<ResultadoDeAviso> = new Set([
  "evento",
  "cambio_sin_efecto_en_agregado",
  "solo_metadatos",
  "no_op",
]);

/**
 * Clasifica los avisos `updated` de una ejecución.
 *
 * @param ahora el instante de la ejecución, para distinguir la misma
 *   observación de una posterior ya aplicada.
 */
export function clasificarUpdated(
  detalle: DetalleDeOfertas,
  ahora: Date,
  titulosFueraDeCatalogo: number,
): InformeDeUpdated {
  const ahoraIso = ahora.toISOString();
  const evaluacion = new Map(
    detalle.evaluaciones.map((e) => [`${String(e.pagina)}|${e.clave}`, e]),
  );

  const porPlataforma: Record<string, number> = {};
  const porTipoDeOferta: Record<string, number> = {};
  const porResultado = Object.fromEntries(
    RESULTADOS_DE_AVISO.map((r) => [r, 0]),
  ) as Record<ResultadoDeAviso, number>;
  const porGrupo: Record<
    string,
    {
      avisos: number;
      resultados: Partial<Record<ResultadoDeAviso, number>>;
      campos: Partial<Record<CampoDeOpcion, number>>;
      preciosCambiados: number;
    }
  > = {};
  const porTipoYResultado: Record<
    string,
    Partial<Record<ResultadoDeAviso, number>>
  > = {};
  const camposCambiados: Partial<Record<CampoDeOpcion, number>> = {};
  const precios = {
    cambios: 0,
    suben: 0,
    bajan: 0,
    aparecen: 0,
    desaparecen: 0,
    cambiosDeMoneda: 0,
    muestra: [] as CambioDePrecio[],
  };
  const eventosDeAvisos: Record<string, number> = {};
  const camposDeAvisos: Record<string, number> = {};
  let opcionesQueSobrevivenSinVerse = 0;

  const vistas = new Set<string>();
  let avisos = 0;

  for (const aviso of detalle.avisos) {
    if (aviso.tipo !== "updated") continue;
    avisos++;
    const grupo = grupoDe(aviso);
    sumar(porPlataforma, aviso.plataforma ?? aviso.plataformaFuente);
    sumar(porTipoDeOferta, aviso.tipoOferta);
    porGrupo[grupo] ??= { avisos: 0, resultados: {}, campos: {}, preciosCambiados: 0 };
    const g = porGrupo[grupo];
    g.avisos++;

    let resultado: ResultadoDeAviso;
    let diferencia: DiferenciaDeOferta | null = null;
    if (aviso.imdbId === null) resultado = "sin_show";
    else if (aviso.plataforma === null || aviso.clave === null)
      resultado = "fuera_del_mvp";
    else {
      const id = `${String(aviso.pagina)}|${aviso.clave}`;
      const e = evaluacion.get(id);
      if (vistas.has(id)) resultado = "repetido";
      else if (e === undefined) resultado = "sin_oferta";
      else {
        vistas.add(id);
        if (e.destino === "evaluada")
          diferencia = diferenciaDeOferta(e.antes, e.snapshot, e.despues);
        resultado = resultadoDeEvaluacion(e, diferencia, ahoraIso);
        if (e.evento !== null && e.destino === "evaluada") {
          sumar(eventosDeAvisos, e.evento.tipo);
          for (const c of e.evento.camposCambiados ?? ["(transición)"])
            sumar(camposDeAvisos, c);
        }
      }
    }

    porResultado[resultado]++;
    sumar(g.resultados, resultado);
    porTipoYResultado[aviso.tipoOferta] ??= {};
    sumar(porTipoYResultado[aviso.tipoOferta] ?? {}, resultado);

    if (diferencia === null || !COMPARADOS.has(resultado)) continue;
    opcionesQueSobrevivenSinVerse += diferencia.sobrevivenSinVerse;
    for (const campo of diferencia.campos) {
      sumar(camposCambiados, campo);
      sumar(g.campos, campo);
    }
    for (const p of diferencia.precios) {
      g.preciosCambiados++;
      precios.cambios++;
      if (p.antes === null) precios.aparecen++;
      else if (p.despues === null) precios.desaparecen++;
      else if (p.antes.moneda !== p.despues.moneda) precios.cambiosDeMoneda++;
      else if (Number(p.despues.importe) > Number(p.antes.importe)) precios.suben++;
      else precios.bajan++;
      if (precios.muestra.length < 25) {
        precios.muestra.push({ clave: aviso.clave ?? "?", grupo, ...p });
      }
    }
  }

  // Las ofertas que trajo el snapshot sin que ningún `updated` las nombrara.
  const eventosDeAcompanantes: Record<string, number> = {};
  const camposDeAcompanantes: Record<string, number> = {};
  for (const e of detalle.evaluaciones) {
    if (e.nombradaPor.includes("updated") || e.evento === null) continue;
    sumar(eventosDeAcompanantes, e.evento.tipo);
    for (const c of e.evento.camposCambiados ?? ["(transición)"]) {
      sumar(camposDeAcompanantes, c);
    }
  }

  return {
    avisos,
    porPlataforma,
    porTipoDeOferta,
    porResultado,
    porGrupo,
    porTipoDeOfertaYResultado: porTipoYResultado,
    camposCambiados,
    precios,
    eventos: {
      deAvisos: eventosDeAvisos,
      camposDeAvisos,
      deAcompanantes: eventosDeAcompanantes,
      camposDeAcompanantes,
    },
    opcionesQueSobrevivenSinVerse,
    titulosFueraDeCatalogo,
  };
}

/**
 * Lo que de la clasificación sale **solo del crudo**: no depende del estado
 * de la base, así que una reproducción de una ejecución real tiene que
 * repetirlo idéntico aunque la rama haya cambiado.
 */
export function clasificacionDelCrudo(informe: InformeDeUpdated) {
  return {
    avisos: informe.avisos,
    porPlataforma: informe.porPlataforma,
    porTipoDeOferta: informe.porTipoDeOferta,
  };
}
