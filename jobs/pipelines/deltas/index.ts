/**
 * Pipeline de deltas: de los avisos de `/changes` al estado y al histórico.
 *
 * ── Lo que este pipeline NO hace ────────────────────────────────────────────
 *
 * **No convierte un aviso en un evento.** El `changeType` del proveedor solo
 * decide qué oferta hay que volver a mirar; el `event_type` sale siempre de
 * comparar el estado anterior con el nuevo (`comparar.ts`).
 *
 * **No pide la ficha de ningún título por separado.** 📏 `/changes` devuelve
 * `shows` con el show completo —110 de 110 validan contra el
 * `showProveedor` que ya existía—, así que `normalizarShow` se reutiliza tal
 * cual y el coste del pipeline es exactamente el de paginar.
 *
 * **No detecta ausencias a ciegas.** Solo interpreta la ausencia de una opción
 * cuando el snapshot habla de esa oferta. El barrido completo del catálogo es
 * el pipeline `reconcile`, que no es este.
 *
 * **No convierte un anuncio en disponibilidad** (ADR 0007). Un aviso
 * `upcoming` se guarda en `external_availability_announcements`
 * (`anuncios.ts`): no sintetiza opciones, no toca las reales, no es un aviso
 * de alta y no emite eventos. El snapshot del show que lo acompaña sí se
 * procesa, como el de cualquier otro aviso: es catálogo observado.
 */
import type { TipoDeCambio } from "../../adapters/contracts.ts";
import type { AvisoCanonico } from "../../adapters/contracts.ts";
import { claveDeOferta, construirFilas } from "../seed/filas.ts";
import type { TituloObservado } from "../seed/origen.ts";
import { plataformaDesdeFuente } from "../seed/plataformas.ts";
import { ejecutarSeed } from "../seed/index.ts";
import {
  anunciosObservados,
  escribirAnuncios,
  informeDeAnunciosVacio,
  leerAnuncios,
  planificarAnuncios,
  sumarInformesDeAnuncios,
} from "./anuncios.ts";
import { compararEstados } from "./comparar.ts";
import type { EventoCandidato } from "./comparar.ts";
import type {
  AvisoDetallado,
  DescarteDeAviso,
  DestinoDeOferta,
  EjecutorSql,
  EvaluacionDeOferta,
  InformeDeAnuncios,
  InformeDeDeltas,
  ListaNoAgotada,
  OfertaExistente,
  OpcionDetallada,
  OpcionExistente,
  OpcionObservada,
} from "./contratos.ts";
import { PAIS } from "./contratos.ts";
import { bucketDelDia, calcularEventDigest } from "./digest.ts";
import { activas, agregar } from "./estado.ts";
import { esObservacionNueva, planificarOpciones } from "./opciones.ts";
import { recorrerCambios } from "./origen.ts";
import type { PeticionDeCambios, VentanaDeConsulta } from "./origen.ts";

// ── Lectura del estado anterior ─────────────────────────────────────────────

const SQL_ESTADO_ANTERIOR = `
  SELECT t.imdb_id,
         a.id AS availability_id, a.platform_id, a.offer_type, a.addon,
         a.last_checked_at,
         o.id AS option_id, o.link, o.video_link, o.quality,
         o.price_amount, o.price_currency,
         o.audio_languages, o.subtitle_languages,
         o.available_since, o.expires_at, o.first_seen_at, o.missing_streak
    FROM external_availability a
    JOIN external_titles t ON t.id = a.title_id
    LEFT JOIN external_availability_options o ON o.availability_id = a.id
   WHERE a.country = $1 AND t.imdb_id = ANY($2::text[])`;

interface FilaDeEstado {
  readonly imdb_id: string;
  readonly availability_id: string | number;
  readonly platform_id: string;
  readonly offer_type: string;
  readonly addon: string | null;
  readonly last_checked_at?: Date | string | null;
  readonly option_id: string | number | null;
  readonly link: string | null;
  readonly video_link?: string | null;
  readonly quality: string | null;
  readonly price_amount: string | null;
  readonly price_currency: string | null;
  readonly audio_languages: readonly string[] | null;
  readonly subtitle_languages: readonly string[] | null;
  readonly available_since: Date | string | null;
  readonly expires_at: Date | string | null;
  readonly first_seen_at: Date | string | null;
  readonly missing_streak: number | null;
}

function aFecha(valor: Date | string | null): Date | null {
  if (valor === null) return null;
  return valor instanceof Date ? valor : new Date(valor);
}

function esCalidad(valor: string | null): "sd" | "hd" | "uhd" | null {
  return valor === "sd" || valor === "hd" || valor === "uhd" ? valor : null;
}

/** El estado anterior, indexado por la clave natural de la oferta. */
export async function leerEstadoAnterior(
  ejecutor: EjecutorSql,
  imdbIds: readonly string[],
): Promise<ReadonlyMap<string, OfertaExistente>> {
  const ofertas = new Map<
    string,
    { id: string; ultimaComprobacion: Date | null; opciones: OpcionExistente[] }
  >();
  if (imdbIds.length === 0) return new Map();

  const filas = await ejecutor.ejecutar<FilaDeEstado>(SQL_ESTADO_ANTERIOR, [
    PAIS,
    [...imdbIds],
  ]);

  for (const fila of filas) {
    const clave = claveDeOferta(
      fila.imdb_id,
      fila.platform_id,
      fila.offer_type,
      fila.addon,
    );
    let oferta = ofertas.get(clave);
    if (oferta === undefined) {
      oferta = {
        id: String(fila.availability_id),
        ultimaComprobacion: aFecha(fila.last_checked_at ?? null),
        opciones: [],
      };
      ofertas.set(clave, oferta);
    }
    // El LEFT JOIN devuelve la oferta aunque no tenga ninguna opción.
    if (fila.option_id === null || fila.link === null) continue;

    const importe = fila.price_amount;
    const moneda = fila.price_currency;
    oferta.opciones.push({
      id: String(fila.option_id),
      link: fila.link,
      calidad: esCalidad(fila.quality),
      precio:
        importe !== null && moneda !== null
          ? { importe: String(importe), moneda }
          : null,
      idiomasAudio: fila.audio_languages ?? [],
      idiomasSubtitulos: fila.subtitle_languages ?? [],
      disponibleDesde: aFecha(fila.available_since),
      expiraEl: aFecha(fila.expires_at),
      vistaPrimeroEn: aFecha(fila.first_seen_at) ?? new Date(0),
      ausenciasSeguidas: fila.missing_streak ?? 0,
      enlaceReproduccion: fila.video_link ?? null,
    });
  }

  const salida = new Map<string, OfertaExistente>();
  for (const [clave, oferta] of ofertas) {
    salida.set(clave, {
      id: oferta.id,
      clave,
      ultimaComprobacion: oferta.ultimaComprobacion,
      opciones: oferta.opciones,
    });
  }
  return salida;
}

/** Una opción sin fecha o con fecha pasada es una oferta disponible. */
function yaDisponible(desde: Date | null, ahora: Date): boolean {
  return desde === null || desde.getTime() <= ahora.getTime();
}

// ── Escrituras de reconciliación ────────────────────────────────────────────

const SQL_BORRAR = `DELETE FROM external_availability_options WHERE id = ANY($1::bigint[])`;
const SQL_VISTA = `
  UPDATE external_availability_options
     SET missing_streak = 0, last_seen_at = $2
   WHERE id = ANY($1::bigint[])`;
const SQL_AUSENTE = `
  UPDATE external_availability_options
     SET missing_streak = $2
   WHERE id = ANY($1::bigint[])`;
/**
 * La antigüedad **se hereda, no se reinicia**. Sin esto, estrenar un anuncio
 * borraría la fecha desde la que conocemos la oferta y el «en Netflix desde…»
 * mentiría. `LEAST` la hace monótona: nunca avanza, así que repetir la
 * sentencia no cambia nada.
 */
const SQL_HEREDAR = `
  UPDATE external_availability_options
     SET first_seen_at = LEAST(first_seen_at, $3::timestamptz)
   WHERE availability_id = $1 AND link = $2`;

const SQL_EVENTO = `
  INSERT INTO external_availability_events
    (availability_id, event_type, changed_fields, before, after,
     event_digest, dedupe_bucket_at, detected_at, sync_run_id)
  VALUES ($1, $2, $3::text[], $4::jsonb, $5::jsonb, $6, $7, $8, $9)
  ON CONFLICT ON CONSTRAINT external_availability_events_key DO NOTHING
  RETURNING id`;

// ── Frontera transaccional ──────────────────────────────────────────────────

/**
 * Cómo se confirma **una página**: estado, reconciliación y eventos juntos, o
 * nada.
 *
 * ⚠️ **No es opcional en producción.** Si el proceso muriera entre escribir el
 * estado y escribir sus eventos, la siguiente ejecución leería el estado nuevo
 * como «anterior», no vería ningún cambio y **el evento se perdería para
 * siempre**: el histórico no se reconstruye. La cuota, en cambio, va por otra
 * conexión (`jobs/ops/`) y un `ROLLBACK` aquí no la devuelve.
 *
 * `job.ts` da las dos implementaciones reales: `BEGIN`/`COMMIT` y, dentro de
 * un ensayo que nunca confirma, `SAVEPOINT`.
 */
export type Transaccion = <T>(trabajo: () => Promise<T>) => Promise<T>;

/** Sin frontera: solo para los tests que ya afirman sobre sentencias sueltas. */
export const sinTransaccion: Transaccion = (trabajo) => trabajo();

// ── Observación, para el manifiesto y la reanudación ────────────────────────

/** Lo que se sabe de una página **ya confirmada**. */
export interface RegistroDePagina {
  readonly tipo: TipoDeCambio;
  /** 1, 2, 3… dentro de su tipo **en esta ejecución**. */
  readonly pagina: number;
  /** El cursor con el que SE PIDIÓ. `null` en la primera de la lista. */
  readonly cursorDeEntrada: string | null;
  readonly hayMas: boolean;
  readonly cursorSiguiente: string | null;
  readonly avisos: number;
  /** El mayor `timestamp` procesado **en este tipo** hasta esta página. */
  readonly ultimoTimestamp: Date | null;
  readonly eventos: Readonly<Record<string, number>>;
  readonly eventosEscritos: number;
  readonly filasPorTabla: Readonly<Record<string, number>>;
  readonly multiLinkOffers: number;
  readonly farFutureExpiries: number;
}

export interface ObservadorDeDeltas {
  /** Una lista empieza, desde su principio o desde un cursor de reanudación. */
  alEmpezarTipo?(tipo: TipoDeCambio, cursor: string | null): void;
  /**
   * **Dentro** de la transacción de la página, como su **última** sentencia:
   * después del estado, la reconciliación y los eventos, antes del `COMMIT`.
   * Es donde se avanza el checkpoint (ADR 0006): si lanza, la página entera se
   * revierte; si la página se revierte, lo que escribió aquí también.
   *
   * ⚠️ Si está definido, **una página sin títulos también abre transacción**:
   * no tiene nada que escribir, pero su cursor tiene que quedar confirmado o
   * la reanudación volvería a pedirla.
   */
  dentroDeLaTransaccion?(registro: RegistroDePagina): Promise<void>;
  /** Una página quedó confirmada. Nunca se llama antes del `COMMIT`. */
  alConfirmarPagina?(registro: RegistroDePagina): void;
}

// ── El pipeline ─────────────────────────────────────────────────────────────

export interface OpcionesDeDeltas {
  readonly ejecutor: EjecutorSql;
  readonly peticion: PeticionDeCambios;
  /** Qué `change_type` recorre esta ejecución, en este orden. */
  readonly tipos: readonly TipoDeCambio[];
  readonly ventana: VentanaDeConsulta | null;
  readonly ahora: Date;
  readonly maximoDePaginas: number;
  readonly runId?: number | null;
  /** Por defecto, ninguna: los tests unitarios afirman sobre sentencias sueltas. */
  readonly transaccion?: Transaccion;
  readonly observador?: ObservadorDeDeltas;
  /**
   * Reanudar una ejecución cortada: los tipos anteriores a `tipo` en `tipos`
   * ya se agotaron y se saltan; `tipo` empieza en `cursor`. **Exige la misma
   * ventana** que la ejecución original, o el cursor apunta a otra lista.
   */
  readonly reanudarEn?: { readonly tipo: TipoDeCambio; readonly cursor: string | null };
  /**
   * Si la ausencia de una opción en el snapshot de un título cuenta para
   * `missing_streak`. Por defecto, sí: es lo que hace `deltas`.
   *
   * ⚖️ `expiring` la desactiva. Su recorrido del horizonte se confirma página
   * a página y ninguna página sabe si el recorrido terminará: una ausencia no
   * se interpreta como retirada mientras el recorrido no haya terminado
   * (decidido el 2026-09-24). Las presencias sí cuentan: son un hecho positivo.
   */
  readonly interpretarAusencias?: boolean;
  /**
   * Si solo se escriben títulos **que ya existen en la base**. Por defecto, no:
   * `deltas`, `expiring` y `upcoming` construyen catálogo con lo que observan.
   *
   * ⚖️ `updated` lo activa (2026-09-25). Un `updated` es un cambio sobre algo
   * que el proveedor ya conoce, no un alta: 📏 31 de sus 40 avisos en 24 h son
   * de Apple, sobre todo `buy`, y procesarlos a ciegas metería en el catálogo
   * títulos que nadie eligió. Los que no están se cuentan
   * (`titulosFueraDeCatalogo`) y no se tocan.
   */
  readonly soloTitulosConocidos?: boolean;
  /**
   * Si el informe lleva el **detalle por oferta** (`InformeDeDeltas.detalle`):
   * cada aviso atribuido y, por cada oferta evaluada, su antes, su snapshot,
   * su después y su evento. Solo auditoría: no cambia nada de lo que se
   * escribe. Lo usa la clasificación de `updated`.
   */
  readonly detallarOfertas?: boolean;
  /**
   * Ver `planificarOpciones.reconciliarCalidadDesconocida`. Por defecto, sí.
   * ⚖️ `updated` lo desactiva: no borra ni fusiona ninguna opción.
   */
  readonly reconciliarCalidadDesconocida?: boolean;
}

function sumar(
  destino: Record<string, number>,
  origen: Readonly<Record<string, number>>,
) {
  for (const [clave, n] of Object.entries(origen)) {
    destino[clave] = (destino[clave] ?? 0) + n;
  }
}

/** El trabajo de una página, antes de saber si se confirma. */
interface ResultadoDePagina {
  readonly eventos: Record<string, number>;
  readonly eventosEscritos: number;
  readonly filasPorTabla: Record<string, number>;
  readonly opcionesReconciliadas: number;
  readonly opcionesMarcadasAusentes: number;
  readonly multiLinkOffers: number;
  readonly farFutureExpiries: number;
  readonly ofertasDeLineaBase: number;
  readonly retiradasSinEstadoPrevio: number;
  readonly observacionesYaAplicadas: number;
  readonly anunciosSobreOfertaDisponible: number;
  readonly anuncios: InformeDeAnuncios;
  readonly titulosFueraDeCatalogo: number;
  readonly evaluaciones: readonly EvaluacionDeOferta[];
}

export async function ejecutarDeltas(
  opciones: OpcionesDeDeltas,
): Promise<InformeDeDeltas> {
  const { ejecutor, ahora } = opciones;
  const runId = opciones.runId ?? null;
  const transaccion = opciones.transaccion ?? sinTransaccion;
  const observador = opciones.observador ?? {};
  const bucket = bucketDelDia(ahora);
  const interpretarAusencias = opciones.interpretarAusencias ?? true;
  const soloTitulosConocidos = opciones.soloTitulosConocidos ?? false;
  const detallar = opciones.detallarOfertas ?? false;
  const reconciliarCalidadDesconocida = opciones.reconciliarCalidadDesconocida ?? true;

  let tipos = opciones.tipos;
  const reanudar = opciones.reanudarEn;
  if (reanudar !== undefined) {
    const indice = tipos.indexOf(reanudar.tipo);
    if (indice === -1) {
      throw new Error(
        `No se puede reanudar en "${reanudar.tipo}": no está entre los tipos ${tipos.join(", ")}.`,
      );
    }
    tipos = tipos.slice(indice);
  }

  const descartes: DescarteDeAviso[] = [];
  const eventosPorTipo: Record<string, number> = {};
  const filasPorTabla: Record<string, number> = {};
  const titulosTocados = new Set<string>();
  const ofertasNombradas = new Set<string>();
  const listasNoAgotadas: ListaNoAgotada[] = [];
  let paginas = 0;
  let avisos = 0;
  let avisosSinShow = 0;
  let avisosSinIdentidad = 0;
  let eventosEscritos = 0;
  let opcionesReconciliadas = 0;
  let opcionesMarcadasAusentes = 0;
  let multiLinkOffers = 0;
  let farFutureExpiries = 0;
  let ofertasDeLineaBase = 0;
  let retiradasSinEstadoPrevio = 0;
  let observacionesYaAplicadas = 0;
  let anunciosSobreOfertaDisponible = 0;
  let anuncios = informeDeAnunciosVacio();
  let titulosFueraDeCatalogo = 0;
  const avisosDetallados: AvisoDetallado[] = [];
  const evaluaciones: EvaluacionDeOferta[] = [];

  for (const tipo of tipos) {
    const cursorInicial = reanudar?.tipo === tipo ? reanudar.cursor : null;
    observador.alEmpezarTipo?.(tipo, cursorInicial);

    let cursorDeEntrada = cursorInicial;
    let paginaDelTipo = 0;
    let ultimoTimestamp: Date | null = null;
    let ultimaHayMas = false;
    let ultimoCursorSiguiente: string | null = null;

    for await (const pagina of recorrerCambios(opciones.peticion, {
      tipo,
      ventana: opciones.ventana,
      maximoDePaginas: opciones.maximoDePaginas,
      cursorInicial,
    })) {
      paginas++;
      paginaDelTipo++;
      avisos += pagina.avisos.length;

      // 📏 Hasta 4 avisos de un mismo título en una página de `updated`: se
      // agrupa antes de tocar la base para no recomputar su estado 4 veces.
      const porShow = new Map<string, AvisoCanonico[]>();
      for (const aviso of pagina.avisos) {
        const lista = porShow.get(aviso.idProveedor);
        if (lista === undefined) porShow.set(aviso.idProveedor, [aviso]);
        else lista.push(aviso);
      }

      const observados: TituloObservado[] = [];
      const avisosPorImdb = new Map<string, AvisoCanonico[]>();

      for (const [showId, avisosDelShow] of porShow) {
        const titulo = pagina.titulos.get(showId);
        if (titulo === undefined) {
          // B4: que `shows` cubra cada aviso está medido en la página 1 y
          // solo implicado más allá. Se cuenta, no se supone, y no rompe nada.
          // Un show sin identidad (`imdbId` vacío) cae aquí también: sin ella
          // no hay título al que atribuir el aviso.
          avisosSinShow += avisosDelShow.length;
          if (pagina.showsSinIdentidad.has(showId)) {
            avisosSinIdentidad += avisosDelShow.length;
          }
          continue;
        }

        titulosTocados.add(titulo.ids.imdbId);
        avisosPorImdb.set(titulo.ids.imdbId, avisosDelShow);
        for (const aviso of avisosDelShow) {
          const plataforma = plataformaDesdeFuente(aviso.plataformaId);
          if (plataforma === null) continue;
          ofertasNombradas.add(
            claveDeOferta(titulo.ids.imdbId, plataforma, aviso.tipoOferta, aviso.addon),
          );
        }
        observados.push({ titulo, observadoEn: ahora, observadoPorOpcion: new Map() });
      }

      for (const aviso of pagina.avisos) {
        if (ultimoTimestamp === null || aviso.instante > ultimoTimestamp) {
          ultimoTimestamp = aviso.instante;
        }
      }

      // Lo que se sabe de la página, con o sin trabajo confirmado. Se construye
      // igual dentro de la transacción (para el checkpoint) y fuera (para el
      // observador): es la misma página.
      const registroDe = (r: ResultadoDePagina | null): RegistroDePagina => ({
        tipo,
        pagina: paginaDelTipo,
        cursorDeEntrada,
        hayMas: pagina.hayMas,
        cursorSiguiente: pagina.cursorSiguiente,
        avisos: pagina.avisos.length,
        ultimoTimestamp,
        eventos: r?.eventos ?? {},
        eventosEscritos: r?.eventosEscritos ?? 0,
        filasPorTabla: r?.filasPorTabla ?? {},
        multiLinkOffers: r?.multiLinkOffers ?? 0,
        farFutureExpiries: r?.farFutureExpiries ?? 0,
      });

      const numeroDePagina = paginas;
      const hayTrabajo = observados.length > 0;
      const resultado =
        !hayTrabajo && observador.dentroDeLaTransaccion === undefined
          ? null
          : await transaccion(async () => {
              const r = hayTrabajo
                ? await procesarPagina({
                    ejecutor,
                    ahora,
                    bucket,
                    runId,
                    observados,
                    avisosPorImdb,
                    interpretarAusencias,
                    soloTitulosConocidos,
                    detallar,
                    reconciliarCalidadDesconocida,
                    pagina: numeroDePagina,
                  })
                : null;
              // Lo último antes del COMMIT: el checkpoint no puede adelantarse
              // a nada de lo que describe, ni quedarse por detrás.
              await observador.dentroDeLaTransaccion?.(registroDe(r));
              return r;
            });

      // ── Confirmada. Solo desde aquí cuenta como hecha ─────────────────────
      if (resultado !== null) {
        sumar(eventosPorTipo, resultado.eventos);
        sumar(filasPorTabla, resultado.filasPorTabla);
        eventosEscritos += resultado.eventosEscritos;
        opcionesReconciliadas += resultado.opcionesReconciliadas;
        opcionesMarcadasAusentes += resultado.opcionesMarcadasAusentes;
        multiLinkOffers += resultado.multiLinkOffers;
        farFutureExpiries += resultado.farFutureExpiries;
        ofertasDeLineaBase += resultado.ofertasDeLineaBase;
        retiradasSinEstadoPrevio += resultado.retiradasSinEstadoPrevio;
        observacionesYaAplicadas += resultado.observacionesYaAplicadas;
        anunciosSobreOfertaDisponible += resultado.anunciosSobreOfertaDisponible;
        anuncios = sumarInformesDeAnuncios(anuncios, resultado.anuncios);
        titulosFueraDeCatalogo += resultado.titulosFueraDeCatalogo;
        evaluaciones.push(...resultado.evaluaciones);
      }
      if (detallar) {
        avisosDetallados.push(
          ...detallarAvisos(numeroDePagina, pagina.avisos, pagina.titulos),
        );
      }

      observador.alConfirmarPagina?.(registroDe(resultado));

      cursorDeEntrada = pagina.cursorSiguiente;
      ultimaHayMas = pagina.hayMas;
      ultimoCursorSiguiente = pagina.cursorSiguiente;
    }

    // `recorrerCambios` para en silencio al llegar a `maximoDePaginas`. Aquí
    // deja de ser silencio: una lista con `hasMore` y cursor NO está agotada.
    if (ultimaHayMas && ultimoCursorSiguiente !== null) {
      listasNoAgotadas.push({
        tipo,
        cursorPendiente: ultimoCursorSiguiente,
        ultimoTimestamp,
      });
    }
  }

  return {
    paginas,
    avisos,
    titulosTocados: titulosTocados.size,
    eventos: eventosPorTipo,
    eventosEscritos,
    opcionesReconciliadas,
    opcionesMarcadasAusentes,
    descartes,
    avisosSinShow,
    avisosSinIdentidad,
    multiLinkOffers,
    farFutureExpiries,
    filasPorTabla,
    ofertasDeLineaBase,
    retiradasSinEstadoPrevio,
    observacionesYaAplicadas,
    anunciosSobreOfertaDisponible,
    anuncios,
    listasNoAgotadas,
    ofertasNombradas: [...ofertasNombradas].sort(),
    titulosFueraDeCatalogo,
    detalle: detallar ? { avisos: avisosDetallados, evaluaciones } : null,
  };
}

/** Los avisos de una página, atribuidos a su título y a su oferta si se puede. */
function detallarAvisos(
  pagina: number,
  avisos: readonly AvisoCanonico[],
  titulos: ReadonlyMap<string, { readonly ids: { readonly imdbId: string } }>,
): AvisoDetallado[] {
  return avisos.map((aviso) => {
    const imdbId = titulos.get(aviso.idProveedor)?.ids.imdbId ?? null;
    const plataforma = plataformaDesdeFuente(aviso.plataformaId);
    return {
      pagina,
      tipo: aviso.tipo,
      idProveedor: aviso.idProveedor,
      imdbId,
      plataformaFuente: aviso.plataformaId,
      plataforma,
      tipoOferta: aviso.tipoOferta,
      addon: aviso.addon,
      instante: aviso.instante.toISOString(),
      enlace: aviso.enlace,
      clave:
        imdbId === null || plataforma === null
          ? null
          : claveDeOferta(imdbId, plataforma, aviso.tipoOferta, aviso.addon),
    };
  });
}

/** Una opción de la base con su `video_link`, para el detalle. */
function detallarExistente(o: OpcionExistente): OpcionDetallada {
  return {
    link: o.link,
    calidad: o.calidad,
    precio: o.precio,
    idiomasAudio: o.idiomasAudio,
    idiomasSubtitulos: o.idiomasSubtitulos,
    disponibleDesde: o.disponibleDesde,
    expiraEl: o.expiraEl,
    enlaceReproduccion: o.enlaceReproduccion ?? null,
  };
}

const SQL_TITULOS_CONOCIDOS = `SELECT imdb_id FROM external_titles WHERE imdb_id = ANY($1::text[])`;

/** Cuáles de estos títulos existen ya en la base. */
async function leerTitulosConocidos(
  ejecutor: EjecutorSql,
  imdbIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (imdbIds.length === 0) return new Set();
  const filas = await ejecutor.ejecutar<{ imdb_id: string }>(SQL_TITULOS_CONOCIDOS, [
    [...imdbIds],
  ]);
  return new Set(filas.map((f) => f.imdb_id));
}

/**
 * Lee, compara y escribe **una página**. Todo lo que hace va dentro de la
 * transacción que le pasa el llamador.
 */
async function procesarPagina(entrada: {
  readonly ejecutor: EjecutorSql;
  readonly ahora: Date;
  readonly bucket: Date;
  readonly runId: number | null;
  readonly observados: readonly TituloObservado[];
  readonly avisosPorImdb: ReadonlyMap<string, readonly AvisoCanonico[]>;
  readonly interpretarAusencias: boolean;
  readonly soloTitulosConocidos: boolean;
  readonly detallar: boolean;
  readonly reconciliarCalidadDesconocida: boolean;
  readonly pagina: number;
}): Promise<ResultadoDePagina> {
  const { ejecutor, ahora, bucket, runId, detallar } = entrada;
  const evaluaciones: EvaluacionDeOferta[] = [];

  // ⚖️ Con `soloTitulosConocidos`, un título que no está en la base no se
  // escribe: ni él ni sus ofertas. Sus ofertas nombradas quedan en el detalle
  // como `fuera_de_catalogo`, para que se vea qué se dejó fuera.
  let observadosEntrada = entrada.observados;
  let avisosPorImdb = entrada.avisosPorImdb;
  let titulosFueraDeCatalogo = 0;
  if (entrada.soloTitulosConocidos) {
    const conocidos = await leerTitulosConocidos(ejecutor, [
      ...entrada.avisosPorImdb.keys(),
    ]);
    const filtrados = new Map<string, readonly AvisoCanonico[]>();
    for (const [imdbId, lista] of entrada.avisosPorImdb) {
      if (conocidos.has(imdbId)) {
        filtrados.set(imdbId, lista);
        continue;
      }
      titulosFueraDeCatalogo++;
      if (!detallar) continue;
      const titulo = entrada.observados.find((o) => o.titulo.ids.imdbId === imdbId);
      const claves = new Map<string, TipoDeCambio[]>();
      for (const aviso of lista) {
        const plataforma = plataformaDesdeFuente(aviso.plataformaId);
        if (plataforma === null) continue;
        const clave = claveDeOferta(imdbId, plataforma, aviso.tipoOferta, aviso.addon);
        claves.set(clave, [...(claves.get(clave) ?? []), aviso.tipo]);
      }
      for (const [clave, nombradaPor] of claves) {
        evaluaciones.push({
          pagina: entrada.pagina,
          clave,
          nombradaPor: [...new Set(nombradaPor)].sort(),
          destino: "fuera_de_catalogo",
          ultimaComprobacion: null,
          antes: [],
          snapshot: (titulo?.titulo.disponibilidad ?? [])
            .filter((d) => {
              const plataforma = plataformaDesdeFuente(d.plataformaId);
              return (
                plataforma !== null &&
                claveDeOferta(imdbId, plataforma, d.tipoOferta, d.addon) === clave
              );
            })
            .map((d) => ({
              link: d.enlace,
              calidad: d.calidad,
              precio: d.precio,
              idiomasAudio: d.idiomasAudio,
              idiomasSubtitulos: d.idiomasSubtitulos,
              disponibleDesde: d.disponibleDesde,
              expiraEl: d.expiraEl,
              enlaceReproduccion: d.enlaceReproduccion,
            })),
          despues: null,
          evento: null,
        });
      }
    }
    avisosPorImdb = filtrados;
    observadosEntrada = entrada.observados.filter((o) =>
      conocidos.has(o.titulo.ids.imdbId),
    );
  }

  const eventosPorTipo: Record<string, number> = {};
  const filasPorTabla: Record<string, number> = {};
  let eventosEscritos = 0;
  let opcionesReconciliadas = 0;
  let opcionesMarcadasAusentes = 0;
  let multiLinkOffers = 0;
  let ofertasDeLineaBase = 0;
  let retiradasSinEstadoPrevio = 0;
  let observacionesYaAplicadas = 0;
  let anunciosSobreOfertaDisponible = 0;

  // Todo lo anterior se lee ANTES de escribir nada: el estado de las ofertas y
  // el de los anuncios.
  const imdbIds = [...avisosPorImdb.keys()];
  const anterior = await leerEstadoAnterior(ejecutor, imdbIds);
  const observadosDeAnuncio = anunciosObservados(avisosPorImdb);
  const planDeAnuncios = planificarAnuncios(
    observadosDeAnuncio.length === 0
      ? new Map()
      : await leerAnuncios(ejecutor, imdbIds),
    observadosDeAnuncio,
    ahora,
    runId,
  );

  // Un anuncio sobre una oferta **ya disponible** —en el snapshot o en la
  // base— se guarda igual, pero se cuenta: 📏 `tt9000044` («Título ficticio 068»,
  // fila 50) está en Netflix desde 2022 y se anuncia con otro link y fecha
  // futura. Qué hace «Próximamente» con él no se decide aquí.
  const tituloDe = new Map(
    observadosEntrada.map((o) => [o.titulo.ids.imdbId, o.titulo]),
  );
  for (const anuncio of observadosDeAnuncio) {
    const enElSnapshot = (tituloDe.get(anuncio.imdbId)?.disponibilidad ?? []).some(
      (d) =>
        plataformaDesdeFuente(d.plataformaId) === anuncio.plataforma &&
        d.tipoOferta === anuncio.tipoOferta &&
        d.addon === anuncio.addon &&
        yaDisponible(d.disponibleDesde, ahora),
    );
    const enLaBase = activas(anterior.get(anuncio.clave)?.opciones ?? []).some((o) =>
      yaDisponible(o.disponibleDesde, ahora),
    );
    if (enElSnapshot || enLaBase) anunciosSobreOfertaDisponible++;
  }

  const construidas = construirFilas(observadosEntrada);

  // El snapshot, agrupado por la misma clave natural.
  // Con su `video_link`, que el agregado ignora y el detalle necesita.
  const snapshotPorClave = new Map<string, OpcionDetallada[]>();
  for (const opcion of construidas.opciones) {
    const lista = snapshotPorClave.get(opcion.claveOferta);
    const observada: OpcionDetallada = {
      link: opcion.link,
      calidad: esCalidad(opcion.quality),
      precio:
        opcion.priceAmount !== null && opcion.priceCurrency !== null
          ? { importe: opcion.priceAmount, moneda: opcion.priceCurrency }
          : null,
      idiomasAudio: opcion.audioLanguages,
      idiomasSubtitulos: opcion.subtitleLanguages,
      disponibleDesde: opcion.availableSince,
      expiraEl: opcion.expiresAt,
      enlaceReproduccion: opcion.videoLink,
    };
    if (lista === undefined) snapshotPorClave.set(opcion.claveOferta, [observada]);
    else lista.push(observada);
  }
  for (const lista of snapshotPorClave.values()) {
    if (lista.length > 1) multiLinkOffers++;
  }

  // Ofertas a evaluar: las que el snapshot lista y las que los avisos
  // nombran. Una retirada solo se conoce por su aviso.
  const retiradas = new Set<string>();
  const nombradas = new Set<string>();
  // Las que un aviso presenta como ALTA. Solo estas pueden estrenar histórico
  // sin estado previo: `updated` o `expiring` dicen que la oferta ya existía,
  // y un `removed` dice lo contrario de un alta.
  const altasAnunciadas = new Set<string>();
  // Solo para el detalle: qué tipos de aviso nombran cada oferta.
  const nombradaPor = new Map<string, Set<TipoDeCambio>>();
  for (const [imdbId, lista] of avisosPorImdb) {
    for (const aviso of lista) {
      if (detallar) {
        const plataforma = plataformaDesdeFuente(aviso.plataformaId);
        if (plataforma !== null) {
          const clave = claveDeOferta(
            imdbId,
            plataforma,
            aviso.tipoOferta,
            aviso.addon,
          );
          const tipos = nombradaPor.get(clave) ?? new Set<TipoDeCambio>();
          tipos.add(aviso.tipo);
          nombradaPor.set(clave, tipos);
        }
      }
      // ⚖️ Un `upcoming` no dice nada de la disponibilidad de hoy (ADR 0007):
      // ni nombra una oferta que evaluar ni es un aviso de alta. Vive en
      // `anuncios.ts`. Su oferta se evalúa solo si el snapshot la lista.
      if (aviso.tipo === "upcoming") continue;
      const plataforma = plataformaDesdeFuente(aviso.plataformaId);
      if (plataforma === null) continue;
      const clave = claveDeOferta(imdbId, plataforma, aviso.tipoOferta, aviso.addon);
      nombradas.add(clave);
      if (aviso.tipo === "removed") retiradas.add(clave);
      if (aviso.tipo === "new") altasAnunciadas.add(clave);
    }
  }

  const claves = new Set<string>([...snapshotPorClave.keys(), ...nombradas]);

  // Se planifica ANTES de escribir, con el estado anterior en la mano.
  const planes = new Map<string, ReturnType<typeof planificarOpciones>>();
  const eventos = new Map<string, EventoCandidato>();
  // Ofertas cuya observación ya estaba aplicada: no se escriben.
  const fueraDeOrden = new Set<string>();

  for (const clave of claves) {
    const existente = anterior.get(clave);
    const existentes = existente?.opciones ?? [];
    const snapshot = snapshotPorClave.get(clave) ?? [];
    const retiradaExplicita = retiradas.has(clave);
    const observacionNueva = esObservacionNueva(
      existente?.ultimaComprobacion ?? null,
      ahora,
    );
    // Solo auditoría: lo que se decidió sobre esta oferta, con su antes y su
    // snapshot. No interviene en ninguna decisión de este bucle.
    const evaluar = (
      destino: DestinoDeOferta,
      despues: readonly OpcionObservada[] | null = null,
      evento: EventoCandidato | null = null,
    ): void => {
      if (!detallar) return;
      evaluaciones.push({
        pagina: entrada.pagina,
        clave,
        nombradaPor: [...(nombradaPor.get(clave) ?? [])].sort(),
        destino,
        ultimaComprobacion: existente?.ultimaComprobacion?.toISOString() ?? null,
        antes: activas(existentes).map(detallarExistente),
        snapshot,
        despues,
        evento:
          evento === null
            ? null
            : { tipo: evento.tipo, camposCambiados: evento.camposCambiados },
      });
    };
    // ⚖️ **Protección contra escrituras fuera de orden** (2026-09-24). Si la
    // oferta existe y esta observación no es posterior a la ya aplicada, es
    // la misma otra vez —reproceso, la misma oferta en otra página— o una más
    // vieja. Ninguna de las dos tiene nada que escribir sobre esta oferta: ni
    // opciones, ni fechas, ni `video_link`, ni idiomas, ni un evento. Antes
    // solo se protegía `missing_streak`, y el upsert sí sobrescribía
    // `available_since` con el dato viejo (📏 ensayo de `upcoming`, 4 ofertas).
    if (existente !== undefined && !observacionNueva) {
      observacionesYaAplicadas++;
      fueraDeOrden.add(clave);
      evaluar("observacion_ya_aplicada");
      continue;
    }

    const plan = planificarOpciones({
      existentes,
      snapshot,
      ahora,
      retiradaExplicita,
      aplicarAusencias:
        entrada.interpretarAusencias && (snapshot.length > 0 || retiradaExplicita),
      observacionNueva,
      reconciliarCalidadDesconocida: entrada.reconciliarCalidadDesconocida,
    });
    planes.set(clave, plan);

    // ⚖️ **Sin estado previo, solo un aviso de ALTA justifica un evento.** Un
    // título que entra por primera vez trae TODAS sus ofertas: la que el
    // aviso anuncia y las que llevan años en otras plataformas. Para esas no
    // sabemos cuándo llegaron; llamarlas `added` sería fechar hoy una alta
    // que nadie observó (CLAUDE.md, regla 7). Se escriben como estado —la
    // línea base desde la que medir— y se cuentan.
    if (existente === undefined) {
      if (retiradaExplicita) {
        // El proveedor retira algo que nunca vimos: no hay «antes» que
        // registrar. Si el snapshot aún la lista, tampoco es un alta.
        retiradasSinEstadoPrevio++;
        evaluar("retirada_sin_estado_previo");
        continue;
      }
      if (!altasAnunciadas.has(clave)) {
        ofertasDeLineaBase++;
        // Sin estado previo y sin snapshot no se escribe nada: un aviso solo
        // no demuestra que la oferta exista.
        evaluar(snapshot.length > 0 ? "linea_base" : "sin_oferta", plan.activasDespues);
        continue;
      }
    }

    const antes = agregar(
      activas(existentes).map((o) => ({
        link: o.link,
        calidad: o.calidad,
        precio: o.precio,
        idiomasAudio: o.idiomasAudio,
        idiomasSubtitulos: o.idiomasSubtitulos,
        disponibleDesde: o.disponibleDesde,
        expiraEl: o.expiraEl,
      })),
      ahora,
    );
    const despues = agregar(plan.activasDespues, ahora);

    const evento = compararEstados(antes, despues);
    if (evento !== null) eventos.set(clave, evento);
    evaluar("evaluada", plan.activasDespues, evento);
  }

  // ── Escritura del estado, por el camino ya validado del seed ────────────
  // La fila de la oferta sí va: su `last_checked_at` es `GREATEST` y no
  // retrocede. Sus opciones, no.
  const filas = {
    ...construidas,
    opciones: construidas.opciones.filter((o) => !fueraDeOrden.has(o.claveOferta)),
  };
  const informe = await ejecutarSeed(ejecutor, filas);
  for (const tabla of informe.tablas) {
    filasPorTabla[tabla.tabla] =
      (filasPorTabla[tabla.tabla] ?? 0) + tabla.insertadas + tabla.actualizadas;
  }

  // ── Anuncios, con los títulos ya escritos ──────────────────────────────
  const filasDeAnuncios = await escribirAnuncios(
    ejecutor,
    planDeAnuncios,
    informe.idsDeTitulo,
  );
  if (filasDeAnuncios > 0) {
    filasPorTabla.external_availability_announcements = filasDeAnuncios;
  }

  // ── Reconciliación ──────────────────────────────────────────────────────
  // El id de una oferta que ya existía se toma del estado anterior, no del
  // `RETURNING` del upsert: los dos coinciden en PostgreSQL —un `ON CONFLICT
  // DO UPDATE` devuelve la fila existente—, pero depender de ello haría que
  // el histórico se colgara de un detalle del driver.
  const idDeOferta = (clave: string): string | undefined =>
    anterior.get(clave)?.id ?? informe.idsDeOferta.get(clave);

  for (const [clave, plan] of planes) {
    const availabilityId = idDeOferta(clave);

    if (plan.aBorrar.length > 0) {
      await ejecutor.ejecutar(SQL_BORRAR, [[...plan.aBorrar]]);
      opcionesReconciliadas += plan.aBorrar.length;
    }
    if (plan.presentes.length > 0) {
      await ejecutor.ejecutar(SQL_VISTA, [[...plan.presentes], ahora]);
    }
    for (const ausencia of plan.ausencias) {
      await ejecutor.ejecutar(SQL_AUSENTE, [[ausencia.id], ausencia.ausenciasSeguidas]);
      opcionesMarcadasAusentes++;
    }
    if (availabilityId !== undefined) {
      for (const [link, desde] of plan.herencias) {
        await ejecutor.ejecutar(SQL_HEREDAR, [availabilityId, link, desde]);
      }
    }
  }

  // ── Histórico ───────────────────────────────────────────────────────────
  for (const [clave, evento] of eventos) {
    const availabilityId = idDeOferta(clave);
    if (availabilityId === undefined) continue;

    const digest = calcularEventDigest(
      evento.camposCambiados,
      evento.antes,
      evento.despues,
    );
    const escritas = await ejecutor.ejecutar<{ id: string }>(SQL_EVENTO, [
      availabilityId,
      evento.tipo,
      evento.camposCambiados === null ? null : [...evento.camposCambiados],
      JSON.stringify(evento.antes),
      JSON.stringify(evento.despues),
      digest,
      bucket,
      ahora,
      runId,
    ]);

    eventosPorTipo[evento.tipo] = (eventosPorTipo[evento.tipo] ?? 0) + 1;
    if (escritas.length > 0) {
      eventosEscritos++;
      filasPorTabla.external_availability_events =
        (filasPorTabla.external_availability_events ?? 0) + 1;
    }
  }

  return {
    eventos: eventosPorTipo,
    eventosEscritos,
    filasPorTabla,
    opcionesReconciliadas,
    opcionesMarcadasAusentes,
    multiLinkOffers,
    farFutureExpiries: filas.expiracionesNormalizadas,
    ofertasDeLineaBase,
    retiradasSinEstadoPrevio,
    observacionesYaAplicadas,
    anunciosSobreOfertaDisponible,
    anuncios: planDeAnuncios.informe,
    titulosFueraDeCatalogo,
    evaluaciones,
  };
}
