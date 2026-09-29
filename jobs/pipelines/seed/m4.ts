/**
 * **M4 — ¿basta el margen de 1 h del ancla?** (ADR 0009 §7). Comprobación
 * empírica, offline y a **0 requests adicionales**: cruza los avisos del primer
 * `deltas` del destino (su crudo en `.deltas-runs/`) con las páginas del crudo
 * del seed y sus instantes de reserva y respuesta.
 *
 * Para cada aviso `new`/`removed` con `c` (su `timestamp`) en `[S, T1]` y cada
 * página `p` del crudo que trae ese título:
 *
 * | Caso | Lectura |
 * |---|---|
 * | `c ≥ q_p` | posterior a la página: **sin información** |
 * | `r_p ≤ c < q_p` | mientras se servía: **ambiguo**, se descarta |
 * | `c < r_p` y reflejado | **muestra compatible** |
 * | `c < r_p` y no reflejado | **retraso observado**, de al menos `r_p − c` |
 *
 * Reflejado = el snapshot de `p` ya muestra el cambio en la oferta que nombra el
 * aviso, con la clave de oferta de `deltas` (plataforma, país, tipo, addon):
 * para `new`, la oferta **está**; para `removed`, **no está**.
 *
 * | Resultado | Condición |
 * |---|---|
 * | `refutado` | algún retraso observado ≥ 1 h → **el crudo no va a `production`** |
 * | `compatible` | al menos una muestra (`c < r_p`) y ninguna refuta |
 * | `sin_muestras` | ningún caso `c < r_p`: hipótesis operacional no refutada |
 *
 * ⚠️ **M4 no demuestra ninguna cota del retraso del proveedor.** Unas pocas
 * muestras compatibles no acotan el máximo, y su ausencia no dice nada. Solo
 * puede **derribar** el margen, nunca confirmarlo.
 *
 * Funciones puras. No lee disco ni llama a nadie.
 */
import type { AvisoCanonico, TituloCanonico } from "../../adapters/contracts.ts";
import { normalizarShow } from "../../adapters/streaming-availability/normalizar.ts";
import { normalizarPaginaDeCambios } from "../../adapters/streaming-availability/normalizar-cambios.ts";
import {
  respuestaCambiosProveedor,
  showProveedor,
} from "../../adapters/streaming-availability/schema.ts";
import type { ContenidoDelCrudo } from "./crudo/disco.ts";
import type { CrudoVerificado } from "./crudo/verificar.ts";
import { MARGEN_DEL_ANCLA_SEGUNDOS } from "./crudo/formato.ts";
import { leerPagina } from "./pagina.ts";

const PAIS = "es";
const decodificador = new TextDecoder("utf-8", { fatal: true });

/** Un aviso del primer `deltas`, ya atribuido a un título. */
export interface AvisoParaM4 {
  readonly tipo: AvisoCanonico["tipo"];
  /** `c`: el `timestamp` del proveedor. */
  readonly instante: Date;
  /** `null` si su show no llegó o no tiene identidad. */
  readonly imdbId: string | null;
  /** El `service.id` del proveedor (`hbo`, no `max`): el de los snapshots. */
  readonly plataformaId: string;
  readonly tipoOferta: string;
  readonly addon: string | null;
}

/** Una página confirmada del crudo del seed, con sus títulos. */
export interface PaginaParaM4 {
  readonly n: number;
  readonly fichero: string;
  /** `r_p`. */
  readonly reservadaEn: Date;
  /** `q_p`. */
  readonly respondidaEn: Date;
  readonly titulos: ReadonlyMap<string, TituloCanonico>;
}

export type CasoDeM4 = "sin_informacion" | "ambiguo" | "muestra_reflejada" | "retraso";

export interface ObservacionDeM4 {
  readonly aviso: {
    readonly tipo: string;
    readonly c: string;
    readonly imdbId: string;
    readonly oferta: string;
  };
  readonly pagina: number;
  readonly r: string;
  readonly q: string;
  readonly caso: CasoDeM4;
  /** `r_p − c` en segundos, cuando `c < r_p`. */
  readonly adelantoSegundos: number | null;
}

export interface InformeM4 {
  readonly resultado: "refutado" | "compatible" | "sin_muestras";
  readonly ancla: string;
  readonly T1: string;
  readonly margenSegundos: number;
  readonly avisosLeidos: number;
  /** `new` y `removed` con `c ∈ [S, T1]`. */
  readonly avisosEnVentana: number;
  readonly avisosSinIdentidad: number;
  /** En ventana, con identidad, y sin ninguna página del crudo que traiga el título. */
  readonly avisosSinPagina: number;
  readonly casos: Readonly<Record<CasoDeM4, number>>;
  /** Pares `c < r_p`: las muestras que cuentan. */
  readonly muestras: number;
  /** El mayor `r_p − c` entre los NO reflejados. `null` si no hay ninguno. */
  readonly retrasoMaximoObservadoSegundos: number | null;
  readonly refutan: readonly ObservacionDeM4[];
  readonly observaciones: readonly ObservacionDeM4[];
  readonly nota: string;
}

/** Las páginas confirmadas del crudo verificado, con sus títulos normalizados. */
export function paginasDelCrudo(
  crudo: CrudoVerificado,
  contenido: ContenidoDelCrudo,
): PaginaParaM4[] {
  return crudo.manifiesto.paginas
    .filter((p) => p.estado !== "invalida")
    .map((p) => {
      const leida = leerPagina(p.http, contenido.get(p.fichero) ?? new Uint8Array());
      const titulos = new Map<string, TituloCanonico>();
      if (leida.valida) {
        for (const bruto of leida.pagina.shows) {
          const show = showProveedor.safeParse(bruto);
          const t = show.success ? normalizarShow(show.data, PAIS) : null;
          if (t !== null) titulos.set(t.ids.imdbId, t);
        }
      }
      return {
        n: p.n,
        fichero: p.fichero,
        reservadaEn: new Date(p.reservadaEn),
        respondidaEn: new Date(p.respondidaEn),
        titulos,
      };
    });
}

/** Los avisos de las respuestas 2xx de un crudo de `/changes`, atribuidos a su título. */
export function avisosDesdeRespuestas(
  respuestas: readonly { readonly status: number; readonly cuerpo: Uint8Array }[],
): AvisoParaM4[] {
  const salida: AvisoParaM4[] = [];
  for (const r of respuestas) {
    if (r.status < 200 || r.status > 299) continue;
    const pagina = normalizarPaginaDeCambios(
      respuestaCambiosProveedor.parse(JSON.parse(decodificador.decode(r.cuerpo))),
      PAIS,
    );
    for (const a of pagina.avisos) {
      salida.push({
        tipo: a.tipo,
        instante: a.instante,
        imdbId: pagina.titulos.get(a.idProveedor)?.ids.imdbId ?? null,
        plataformaId: a.plataformaId,
        tipoOferta: a.tipoOferta,
        addon: a.addon,
      });
    }
  }
  return salida;
}

function tieneLaOferta(t: TituloCanonico, a: AvisoParaM4): boolean {
  return t.disponibilidad.some(
    (d) =>
      d.pais === PAIS &&
      d.plataformaId === a.plataformaId &&
      d.tipoOferta === a.tipoOferta &&
      (d.addon ?? null) === (a.addon ?? null),
  );
}

export function analizarM4(entrada: {
  readonly ancla: Date;
  readonly T1: Date;
  readonly paginas: readonly PaginaParaM4[];
  readonly avisos: readonly AvisoParaM4[];
}): InformeM4 {
  const S = entrada.ancla.getTime();
  const T1 = entrada.T1.getTime();
  const margenMs = MARGEN_DEL_ANCLA_SEGUNDOS * 1000;
  const casos: Record<CasoDeM4, number> = {
    sin_informacion: 0,
    ambiguo: 0,
    muestra_reflejada: 0,
    retraso: 0,
  };
  const observaciones: ObservacionDeM4[] = [];
  let enVentana = 0;
  let sinIdentidad = 0;
  let sinPagina = 0;

  for (const a of entrada.avisos) {
    if (a.tipo !== "new" && a.tipo !== "removed") continue;
    const c = a.instante.getTime();
    if (c < S || c > T1) continue;
    enVentana++;
    if (a.imdbId === null) {
      sinIdentidad++;
      continue;
    }
    const imdb = a.imdbId;
    const suyas = entrada.paginas.filter((p) => p.titulos.has(imdb));
    if (suyas.length === 0) {
      sinPagina++;
      continue;
    }
    for (const p of suyas) {
      const r = p.reservadaEn.getTime();
      const q = p.respondidaEn.getTime();
      let caso: CasoDeM4;
      if (c >= q) caso = "sin_informacion";
      else if (c >= r) caso = "ambiguo";
      else {
        const titulo = p.titulos.get(imdb);
        const esta = titulo !== undefined && tieneLaOferta(titulo, a);
        caso = (a.tipo === "new" ? esta : !esta) ? "muestra_reflejada" : "retraso";
      }
      casos[caso]++;
      observaciones.push({
        aviso: {
          tipo: a.tipo,
          c: a.instante.toISOString(),
          imdbId: imdb,
          oferta: `${a.plataformaId}|${PAIS}|${a.tipoOferta}|${a.addon ?? "∅"}`,
        },
        pagina: p.n,
        r: p.reservadaEn.toISOString(),
        q: p.respondidaEn.toISOString(),
        caso,
        adelantoSegundos: c < r ? Math.floor((r - c) / 1000) : null,
      });
    }
  }

  const retrasos = observaciones.filter((o) => o.caso === "retraso");
  const maximo = retrasos.reduce<number | null>(
    (m, o) => Math.max(m ?? 0, o.adelantoSegundos ?? 0),
    null,
  );
  const refutan = retrasos.filter((o) => (o.adelantoSegundos ?? 0) * 1000 >= margenMs);
  const muestras = casos.muestra_reflejada + casos.retraso;
  const resultado =
    refutan.length > 0 ? "refutado" : muestras > 0 ? "compatible" : "sin_muestras";
  const nota =
    resultado === "refutado"
      ? "REFUTADO: un cambio de al menos 1 h no estaba en la página que lo pedía. El margen no basta; " +
        "el crudo NO va a production con este ancla sin una decisión explícita."
      : resultado === "compatible"
        ? `Muestras compatibles (${String(muestras)}). No demuestran que el retraso del proveedor sea ≤ 1 h: ` +
          "el margen sigue siendo una decisión conservadora no refutada, no una propiedad validada."
        : "Sin muestras: el margen de 1 h sigue siendo una hipótesis operacional no refutada. No bloquea.";
  return {
    resultado,
    ancla: entrada.ancla.toISOString(),
    T1: entrada.T1.toISOString(),
    margenSegundos: MARGEN_DEL_ANCLA_SEGUNDOS,
    avisosLeidos: entrada.avisos.length,
    avisosEnVentana: enVentana,
    avisosSinIdentidad: sinIdentidad,
    avisosSinPagina: sinPagina,
    casos,
    muestras,
    retrasoMaximoObservadoSegundos: maximo,
    refutan,
    observaciones,
    nota,
  };
}

/** **La compuerta hacia `production`**: un M4 refutado la cierra. */
export function m4PermiteProduction(informe: Pick<InformeM4, "resultado">): boolean {
  return informe.resultado !== "refutado";
}
