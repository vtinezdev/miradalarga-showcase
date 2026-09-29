/**
 * El **manifiesto local** de una ejecución de `deltas`, y su crudo.
 *
 * Vive en `.deltas-runs/<ejecución>/`, **fuera de git** (`.gitignore`), igual
 * que `spike-1/raw/`: es evidencia de trabajo, no código.
 *
 * ── Para qué existe ─────────────────────────────────────────────────────────
 *
 * 1. **Reanudar exactamente.** `/changes` pagina en orden ascendente
 *    (📏 `raw/018`, `raw/020`), así que un corte deja sin ver lo más reciente.
 *    Recalcular unas nuevas «últimas 24 h» movería la ventana y el cursor
 *    dejaría de apuntar a la misma lista. El manifiesto guarda `from`, `to`,
 *    `changeType` y el `cursorDeEntrada` de la página pendiente: con ellos se
 *    reanuda **la misma** lista.
 *
 * ── Dos cursores, dos significados. No se mezclan ──────────────────────────
 *
 *   · `cursorDeEntrada` — con qué cursor **se pidió** (o se pedirá) una página.
 *   · `nextCursor`      — qué cursor **devolvió** esa página para la siguiente.
 *
 * El punto de reanudación es siempre un `cursorDeEntrada`: el de la primera
 * página **no confirmada**, que coincide con el `nextCursor` de la última
 * página **confirmada**. **Nunca** es el `nextCursor` de una página que falló:
 * esa página se revirtió, y saltar a su siguiente perdería sus avisos.
 * 2. **Reproducir sin cuota.** Cada respuesta se guarda **al llegar, antes de
 *    procesarla**. Si el proceso cae después, lo pagado no se pierde: se
 *    reprocesa desde disco.
 *
 * ⚠️ **Ya no decide ninguna reanudación** (ADR 0006). La fuente autoritativa es
 * `ops_sync_runs.checkpoint`, que sobrevive a un runner efímero y se confirma
 * en la misma transacción que los datos. El manifiesto queda para **auditar y
 * reproducir**: qué se pidió, qué llegó y qué se confirmó, página a página.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { TipoDeCambio } from "../../adapters/contracts.ts";
import type { NombreDePipeline } from "../../ops/contratos.ts";
import type { CuotaDelProveedor } from "../../ops/cuota-proveedor.ts";
import {
  CABECERA_CONCEDIDA,
  CABECERA_REINICIO,
  CABECERA_USADA,
} from "../../ops/cuota-proveedor.ts";
import type { InformeDeUpdated } from "../updated/clasificacion.ts";
import type { InformeDeAnuncios, InformeDeDeltas } from "./contratos.ts";
import type { RegistroDePagina } from "./index.ts";
import type { VentanaDeConsulta } from "./origen.ts";

export const VERSION_DEL_MANIFIESTO = 1;
export const NOMBRE_DEL_MANIFIESTO = "manifiesto.json";

export type ModoDeEjecucion = "real" | "reanudacion" | "ensayo" | "reproduccion";

/**
 * **Desde dónde seguir.** Lo mínimo para reanudar la misma lista: el tipo, la
 * ventana exacta y el cursor que quedó sin pedir.
 *
 * `cursorDeEntrada: null` significa que la página pendiente es la **primera**
 * de ese tipo: se reanuda desde su principio, con la misma ventana.
 */
export interface PuntoDeReanudacion {
  readonly changeType: TipoDeCambio;
  /** Segundos UNIX, tal y como viajaron en la query. */
  readonly from: number;
  readonly to: number;
  /**
   * El cursor con el que se pedirá la página pendiente: el `nextCursor` de la
   * última página **confirmada**. Nunca el de una página revertida.
   */
  readonly cursorDeEntrada: string | null;
  /** ISO. El mayor `timestamp` de las páginas **confirmadas** de ese tipo. */
  readonly ultimoTimestamp: string | null;
}

/** Una respuesta HTTP tal y como llegó, antes de procesarla. */
export interface RespuestaGuardada {
  readonly n: number;
  readonly fichero: string;
  readonly changeType: string | null;
  /** El `cursor` de la query: con qué se pidió esta página. */
  readonly cursorDeEntrada: string | null;
  /**
   * El `nextCursor` que DEVOLVIÓ la respuesta. Se registra para auditar, no
   * para reanudar: si la página falló después, este cursor no vale nada.
   * `null` si la respuesta no lo traía o no era JSON.
   */
  readonly nextCursorDevuelto: string | null;
  /** La URL pedida. No lleva credencial: la clave viaja en una cabecera. */
  readonly url: string;
  readonly status: number;
  readonly recibidaEn: string;
  /** Solo las `x-quota-*`: son las únicas que se usan. */
  readonly cabeceras: Readonly<Record<string, string | null>>;
}

export interface PaginaDelManifiesto {
  readonly changeType: TipoDeCambio;
  readonly pagina: number;
  readonly cursorDeEntrada: string | null;
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly avisos: number;
  readonly ultimoTimestamp: string | null;
  readonly eventos: Readonly<Record<string, number>>;
  readonly eventosEscritos: number;
}

/**
 * El resultado de un recorrido del horizonte. **Solo auditoría**: no decide
 * nada ni lo lee ninguna ejecución.
 *
 *   · `completo` — la lista terminó con `hasMore=false` dentro del tope.
 *   · `desaparecidas` — en `expiring`, ofertas con `expires_at` dentro del
 *     horizonte que el recorrido **completo** ya no nombra; en `upcoming`
 *     (ADR 0007), anuncios con `announced_for` dentro del horizonte que el
 *     recorrido completo no observó. `null` si el recorrido no terminó: con la
 *     lista a medias, una ausencia no significa nada.
 *   · `muestra` — las primeras de esas claves, ordenadas, para poder mirarlas.
 */
export interface ResultadoDelHorizonte {
  readonly completo: boolean;
  readonly desaparecidas: number | null;
  readonly muestra: readonly string[];
  /**
   * Solo `upcoming`: anuncios dentro del horizonte en plataformas cuyo
   * endpoint `upcoming` **no las cubre** (SkyShowtime). No se cuentan
   * como desaparecidas: su ausencia no significa nada. `null` si el recorrido
   * no terminó. Ausente en `expiring`.
   */
  readonly fueraDeCobertura?: number | null;
}

/** Un anuncio `upcoming` que llegó **sin `link`**: tal y como vino, sin inventar nada. */
export interface AnuncioSinEnlace {
  readonly idProveedor: string;
  /** `null` si la página no traía el show del aviso. */
  readonly imdbId: string | null;
  /** Nuestro `id` (`max`, no `hbo`); el de la fuente si está fuera del MVP. */
  readonly plataforma: string;
  readonly tipoOferta: string;
  readonly addon: string | null;
  /** ISO. La fecha de estreno anunciada. */
  readonly instante: string;
}

/**
 * Solo `upcoming`: **qué trajo el recorrido**, sacado del crudo de las páginas
 * confirmadas. No depende de la base: una reproducción tiene que repetirlo
 * idéntico. Con `completo: false`, todas las cifras son un suelo.
 */
export interface ResumenDeAnuncios {
  readonly paginas: number;
  readonly completo: boolean;
  readonly avisos: number;
  /** Las seis plataformas del MVP, con su `id` nuestro y 0 si no hubo avisos. */
  readonly porPlataforma: Readonly<Record<string, number>>;
  /** Avisos de servicios fuera del MVP, por su id en la fuente. */
  readonly fueraDelMvp: Readonly<Record<string, number>>;
  readonly sinEnlace: {
    readonly total: number;
    readonly porPlataforma: Readonly<Record<string, number>>;
    /** Los primeros, en orden de llegada. El total es siempre completo. */
    readonly muestra: readonly AnuncioSinEnlace[];
  };
  /** Avisos cuyo show no trae ninguna opción en `streamingOptions.es`. */
  readonly sinDisponibilidadEnEs: number;
  /** Avisos cuya oferta anunciada ya figura en `streamingOptions.es` del show. */
  readonly yaEnElCatalogo: number;
  /** Avisos sin su show en la página: no se pueden atribuir a un título. */
  readonly sinShow: number;
  /** Avisos con `timestamp` fuera de `[from, to]`. Se procesan igual. */
  readonly fueraDelHorizonte: { readonly antes: number; readonly despues: number };
  /** Avisos que repiten una oferta —show, plataforma, tipo, addon— ya vista. */
  readonly repetidos: number;
}

/**
 * **De qué estado de la base partió la ejecución.** Sin esto, `--reproducir`
 * solo puede reprocesar el crudo sobre lo que haya hoy en la rama, y el
 * resultado depende de ese estado: 📏 el ensayo de `expiring` del 2026-09-24
 * midió 4 desaparecidas y 0 ofertas de línea base sobre el catálogo del
 * Spike 1; su reproducción sobre la rama, 2 y 309. El crudo era el mismo; la
 * base, no.
 *
 *   · `rama` — el estado de `drizzle-schema-v1-test` **en el momento de la
 *     ejecución**. Una ejecución real confirma su trabajo, así que ese estado
 *     ya no existe después: **no se puede reconstruir**. Su reproducción es
 *     una prueba de idempotencia, no una repetición.
 *   · `corpus_spike1` — **reconstruible**: el catálogo de `spike-1/raw/` sin
 *     los ficheros que casan con `excluir` (una `RegExp` en su `source`),
 *     y encima, en orden, las ejecuciones de `previas` (directorios de
 *     manifiesto relativos a este). Es el estado de partida de los ensayos.
 *
 *     ⚠️ El ensayo no parte de una base vacía: siembra el corpus **encima de
 *     la rama**, que tiene el catálogo de `deltas`. `rama` guarda su huella, y
 *     la reconstrucción solo es exacta si la rama sigue igual; el cron diario
 *     de `deltas` la cambia.
 */
export type EstadoInicial =
  | { readonly tipo: "rama" }
  | {
      readonly tipo: "corpus_spike1";
      readonly excluir: string;
      readonly previas: readonly string[];
      readonly rama: HuellaDeLaRama;
    };

/**
 * Lo justo para saber si la rama cambió: los recuentos de las 14 tablas, el
 * último evento y la última observación de una oferta. `deltas` mueve al
 * menos la última, aunque no inserte nada.
 */
export interface HuellaDeLaRama {
  readonly recuentos: Readonly<Record<string, number>>;
  readonly ultimoEvento: number;
  readonly ultimaComprobacion: string | null;
}

/** Lo que el informe del pipeline dijo al terminar. Ausente si no terminó. */
export interface ResumenDelInforme {
  readonly paginas: number;
  readonly avisos: number;
  readonly titulosTocados: number;
  readonly eventos: Readonly<Record<string, number>>;
  readonly eventosEscritos: number;
  readonly ofertasDeLineaBase: number;
  readonly retiradasSinEstadoPrevio: number;
  readonly observacionesYaAplicadas: number;
}

export interface Manifiesto {
  readonly version: number;
  readonly pipeline: NombreDePipeline;
  readonly modo: ModoDeEjecucion;
  readonly creadoEn: string;
  /**
   * Ausente en los manifiestos anteriores al 2026-09-24: no se sabe de qué
   * estado partieron. `--reproducir` de `expiring` rechaza un ensayo sin él
   * —partió de un corpus que ya no puede adivinar— y trata el resto como
   * `rama`.
   */
  readonly estadoInicial?: EstadoInicial;
  /** El `ahora` de la ejecución: fija el bucket de los eventos. */
  readonly ahora: string;
  readonly ventana: { readonly from: number; readonly to: number };
  readonly tipos: readonly TipoDeCambio[];
  readonly reanudaDe: PuntoDeReanudacion | null;
  runId: number | null;
  /** **Requests realizadas** = reservas concedidas: la cuota se gasta al reservar. */
  requests: { reservadas: number; respuestas: number; respuestasOk: number };
  respuestas: RespuestaGuardada[];
  paginas: PaginaDelManifiesto[];
  cuotaDelProveedor: CuotaDelProveedor[];
  estado: "en_curso" | "succeeded" | "failed" | "budget_stopped";
  reanudacion: PuntoDeReanudacion | null;
  /** Solo los recorridos del horizonte: ausente en los manifiestos de `deltas`. */
  horizonte?: ResultadoDelHorizonte;
  /** Solo `upcoming`. */
  anuncios?: ResumenDeAnuncios;
  /**
   * Solo `upcoming` (ADR 0007): qué hicieron sus anuncios con
   * `external_availability_announcements`, **conflictos incluidos**. Depende
   * del estado del que partió. Ausente en los manifiestos anteriores.
   */
  anunciosGuardados?: InformeDeAnuncios;
  /**
   * Solo `updated`: qué hizo cada aviso (`updated/clasificacion.ts`). Depende
   * del estado del que partió, salvo sus recuentos por plataforma y tipo.
   * Ausente si la ejecución no terminó.
   */
  updated?: InformeDeUpdated;
  /** El informe del pipeline, si terminó. Un corte de cuota no deja informe. */
  resumen?: ResumenDelInforme;
}

/** Segundos UNIX de una ventana, como viajan en la query. */
export function ventanaEnSegundos(ventana: VentanaDeConsulta): {
  from: number;
  to: number;
} {
  return {
    from: Math.floor(ventana.desde.getTime() / 1000),
    to: Math.floor(ventana.hasta.getTime() / 1000),
  };
}

/** La inversa: una ventana guardada, lista para reenviar **idéntica**. */
export function ventanaDesdeSegundos(v: {
  readonly from: number;
  readonly to: number;
}): VentanaDeConsulta {
  return { desde: new Date(v.from * 1000), hasta: new Date(v.to * 1000) };
}

/** Lo comparable de un informe: sin descartes ni claves, que no caben en un resumen. */
export function resumirInforme(informe: InformeDeDeltas): ResumenDelInforme {
  return {
    paginas: informe.paginas,
    avisos: informe.avisos,
    titulosTocados: informe.titulosTocados,
    eventos: informe.eventos,
    eventosEscritos: informe.eventosEscritos,
    ofertasDeLineaBase: informe.ofertasDeLineaBase,
    retiradasSinEstadoPrevio: informe.retiradasSinEstadoPrevio,
    observacionesYaAplicadas: informe.observacionesYaAplicadas,
  };
}

/** El `nextCursor` de un cuerpo crudo, si lo hay. Sin inventar nada. */
function nextCursorDe(cuerpo: string): string | null {
  try {
    const r = JSON.parse(cuerpo) as { nextCursor?: unknown };
    return typeof r.nextCursor === "string" ? r.nextCursor : null;
  } catch {
    return null;
  }
}

export interface RegistroLocal {
  readonly directorio: string;
  fijarRunId(runId: number | null): void;
  anotarReserva(): void;
  /** Guarda el cuerpo **tal cual** y devuelve el nombre del fichero. */
  guardarRespuesta(respuesta: {
    readonly url: string;
    readonly status: number;
    readonly cabeceras: Headers;
    readonly cuerpo: string;
  }): string;
  anotarCuota(cuota: CuotaDelProveedor): void;
  anotarPagina(registro: RegistroDePagina): void;
  cerrar(estado: Manifiesto["estado"], reanudacion: PuntoDeReanudacion | null): void;
  anotarHorizonte(horizonte: ResultadoDelHorizonte): void;
  anotarAnuncios(anuncios: ResumenDeAnuncios): void;
  anotarAnunciosGuardados(informe: InformeDeAnuncios): void;
  anotarUpdated(informe: InformeDeUpdated): void;
  anotarResumen(informe: InformeDeDeltas): void;
  manifiesto(): Manifiesto;
}

/**
 * Escribe el manifiesto entero cada vez. Pesa unos KB y así el fichero en disco
 * es siempre un JSON completo: se escribe a un temporal y se renombra, para que
 * una caída a mitad no deje medio manifiesto.
 */
function persistir(directorio: string, manifiesto: Manifiesto): void {
  const destino = join(directorio, NOMBRE_DEL_MANIFIESTO);
  const temporal = `${destino}.tmp`;
  writeFileSync(temporal, `${JSON.stringify(manifiesto, null, 2)}\n`, "utf8");
  renameSync(temporal, destino);
}

export function crearRegistroLocal(
  directorio: string,
  cabecera: {
    readonly modo: ModoDeEjecucion;
    readonly ahora: Date;
    readonly ventana: VentanaDeConsulta;
    readonly tipos: readonly TipoDeCambio[];
    readonly reanudaDe: PuntoDeReanudacion | null;
    /** Por defecto, `deltas`. */
    readonly pipeline?: NombreDePipeline;
    /** Sin declarar, no se escribe: el manifiesto no afirma lo que no sabe. */
    readonly estadoInicial?: EstadoInicial;
  },
): RegistroLocal {
  mkdirSync(directorio, { recursive: true });

  const m: Manifiesto = {
    version: VERSION_DEL_MANIFIESTO,
    pipeline: cabecera.pipeline ?? "deltas",
    modo: cabecera.modo,
    creadoEn: new Date().toISOString(),
    ...(cabecera.estadoInicial === undefined
      ? {}
      : { estadoInicial: cabecera.estadoInicial }),
    ahora: cabecera.ahora.toISOString(),
    ventana: ventanaEnSegundos(cabecera.ventana),
    tipos: [...cabecera.tipos],
    reanudaDe: cabecera.reanudaDe,
    runId: null,
    requests: { reservadas: 0, respuestas: 0, respuestasOk: 0 },
    respuestas: [],
    paginas: [],
    cuotaDelProveedor: [],
    estado: "en_curso",
    reanudacion: null,
  };
  persistir(directorio, m);

  return {
    directorio,
    fijarRunId(runId) {
      m.runId = runId;
      persistir(directorio, m);
    },
    anotarReserva() {
      m.requests.reservadas++;
      persistir(directorio, m);
    },
    guardarRespuesta({ url, status, cabeceras, cuerpo }) {
      const n = m.respuestas.length + 1;
      const q = new URL(url).searchParams;
      const changeType = q.get("change_type");
      const fichero = `${String(n).padStart(3, "0")}-${changeType ?? "desconocido"}.json`;

      // El cuerpo va primero al disco y solo después al manifiesto: si algo
      // cae entre medias, sobra un fichero, nunca falta uno que se anotó.
      writeFileSync(join(directorio, fichero), cuerpo, "utf8");

      m.requests.respuestas++;
      if (status >= 200 && status < 300) m.requests.respuestasOk++;
      m.respuestas.push({
        n,
        fichero,
        changeType,
        cursorDeEntrada: q.get("cursor"),
        nextCursorDevuelto: nextCursorDe(cuerpo),
        url,
        status,
        recibidaEn: new Date().toISOString(),
        cabeceras: {
          [CABECERA_USADA]: cabeceras.get(CABECERA_USADA),
          [CABECERA_CONCEDIDA]: cabeceras.get(CABECERA_CONCEDIDA),
          [CABECERA_REINICIO]: cabeceras.get(CABECERA_REINICIO),
        },
      });
      persistir(directorio, m);
      return fichero;
    },
    anotarCuota(cuota) {
      m.cuotaDelProveedor.push(cuota);
      persistir(directorio, m);
    },
    anotarPagina(r) {
      m.paginas.push({
        changeType: r.tipo,
        pagina: r.pagina,
        cursorDeEntrada: r.cursorDeEntrada,
        nextCursor: r.cursorSiguiente,
        hasMore: r.hayMas,
        avisos: r.avisos,
        ultimoTimestamp: r.ultimoTimestamp?.toISOString() ?? null,
        eventos: r.eventos,
        eventosEscritos: r.eventosEscritos,
      });
      persistir(directorio, m);
    },
    cerrar(estado, reanudacion) {
      m.estado = estado;
      m.reanudacion = reanudacion;
      persistir(directorio, m);
    },
    anotarHorizonte(horizonte) {
      m.horizonte = horizonte;
      persistir(directorio, m);
    },
    anotarAnuncios(anuncios) {
      m.anuncios = anuncios;
      persistir(directorio, m);
    },
    anotarAnunciosGuardados(informe) {
      m.anunciosGuardados = informe;
      persistir(directorio, m);
    },
    anotarUpdated(informe) {
      m.updated = informe;
      persistir(directorio, m);
    },
    anotarResumen(informe) {
      m.resumen = resumirInforme(informe);
      persistir(directorio, m);
    },
    manifiesto: () => structuredClone(m),
  };
}

export function leerManifiesto(
  directorio: string,
  pipeline: NombreDePipeline = "deltas",
): Manifiesto {
  const bruto = JSON.parse(
    readFileSync(join(directorio, NOMBRE_DEL_MANIFIESTO), "utf8"),
  ) as Manifiesto;
  if (bruto.version !== VERSION_DEL_MANIFIESTO || bruto.pipeline !== pipeline) {
    throw new Error(
      `${directorio} no es un manifiesto de ${pipeline} v${String(VERSION_DEL_MANIFIESTO)}.`,
    );
  }
  return bruto;
}

/**
 * Qué pedir para **reanudar** la ejecución de un manifiesto: la misma ventana,
 * el mismo orden de tipos y el cursor pendiente.
 *
 * Se niega si no hay nada que reanudar. Recalcular una ventana nueva no es
 * reanudar, es otra ejecución, y confundirlas es justo lo que esto evita.
 */
export function planDeReanudacion(manifiesto: Manifiesto): {
  readonly ventana: VentanaDeConsulta;
  readonly tipos: readonly TipoDeCambio[];
  readonly reanudarEn: { readonly tipo: TipoDeCambio; readonly cursor: string | null };
  readonly punto: PuntoDeReanudacion;
} {
  const punto = manifiesto.reanudacion;
  if (punto === null) {
    throw new Error(
      `La ejecución del manifiesto terminó "${manifiesto.estado}" sin punto de reanudación: no queda nada pendiente.`,
    );
  }
  if (punto.from !== manifiesto.ventana.from || punto.to !== manifiesto.ventana.to) {
    throw new Error(
      "El punto de reanudación no coincide con la ventana del manifiesto.",
    );
  }
  return {
    ventana: ventanaDesdeSegundos(punto),
    tipos: manifiesto.tipos,
    reanudarEn: { tipo: punto.changeType, cursor: punto.cursorDeEntrada },
    punto,
  };
}
