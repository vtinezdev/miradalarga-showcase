/**
 * Lectura paginada de `/changes`.
 *
 * **No llama a `fetch`.** Recibe un `Transporte` —`jobs/ops/transporte.ts`—,
 * que es el único punto autorizado a salir a la red y reserva cuota **antes**
 * de cada llamada. Aquí solo se construye la URL y se recorre el cursor.
 */
import type { TipoDeCambio } from "../../adapters/contracts.ts";
import { normalizarPaginaDeCambios } from "../../adapters/streaming-availability/normalizar-cambios.ts";
import type { PaginaDeCambios } from "../../adapters/streaming-availability/normalizar-cambios.ts";
import { respuestaCambiosProveedor } from "../../adapters/streaming-availability/schema.ts";
import { FalloOperativo } from "../../ops/contratos.ts";
import type { Transporte } from "../../ops/transporte.ts";
import { PAIS } from "./contratos.ts";
import { PLATAFORMAS_MVP } from "../seed/plataformas.ts";

/** 📏 Medido en el Spike 1: `https://api.movieofthenight.com/v4`. */
export const BASE_POR_DEFECTO = "https://api.movieofthenight.com/v4";

/**
 * 📏 **El desfase de reloj es real y cuesta un HTTP 400.** Dos segundos entre
 * calcular `from` y enviarlo bastaron para
 * `parameter "from" cannot be more than 31 days in the past`
 * (`spike-1/raw/019`, `021`). Se resta un minuto de margen.
 */
export const MARGEN_DE_RELOJ_MS = 60_000;

/** 📄 La ventana máxima de `/changes` es de 31 días. */
export const VENTANA_MAXIMA_DIAS = 31;

/** Los `source_id` del proveedor para las seis plataformas del MVP (`hbo`, no `max`). */
export const CATALOGOS_MVP = PLATAFORMAS_MVP.map((p) => p.sourceId).join(",");

export interface VentanaDeConsulta {
  readonly desde: Date;
  readonly hasta: Date;
}

/**
 * La ventana `[desde, hasta]`, ya con el margen de reloj aplicado.
 *
 * `desde` se recorta a los 31 días aunque se pidan más: pedir una ventana
 * inválida no devuelve menos datos, devuelve un 400.
 */
export function calcularVentana(ahora: Date, dias: number): VentanaDeConsulta {
  const diasUtiles = Math.min(dias, VENTANA_MAXIMA_DIAS);
  return {
    desde: new Date(ahora.getTime() - diasUtiles * 86_400_000 + MARGEN_DE_RELOJ_MS),
    hasta: new Date(ahora.getTime() + diasUtiles * 86_400_000),
  };
}

/**
 * La ventana **hacia delante**, para `expiring` y `upcoming`.
 *
 * 📏 Es la forma exacta que funcionó en el Spike 1 (`raw/023`, `raw/024`):
 * `from` = el instante de la consulta, `to` = 31 días después. La de
 * `calcularVentana` mira hacia atrás y abarcaría 62 días a caballo entre
 * ambos lados, que **nunca se ha probado** — y un HTTP 400 cuesta una request
 * igual que una respuesta buena.
 *
 * `from` lleva el mismo margen de 60 s, aquí por prudencia y no por necesidad:
 * el límite de los 31 días solo aplica hacia el pasado.
 */
export function ventanaHaciaDelante(ahora: Date, dias: number): VentanaDeConsulta {
  const diasUtiles = Math.min(dias, VENTANA_MAXIMA_DIAS);
  return {
    desde: new Date(ahora.getTime() - MARGEN_DE_RELOJ_MS),
    hasta: new Date(ahora.getTime() + diasUtiles * 86_400_000),
  };
}

/**
 * La ventana **hacia atrás** de `new` y `removed`, con la forma exacta que se
 * midió.
 *
 * 📏 `spike-1/probe-daily.mjs` → `raw/053`, `raw/054`: `from = ahora − 24 h`,
 * `to = ahora`. Es la única forma que ha respondido 200 para estos dos tipos.
 * `calcularVentana` enviaría `to = ahora + 24 h`, que **nunca se ha probado**
 * con `new`/`removed`, y un 400 cuesta una request igual que una respuesta
 * buena.
 *
 * Sin margen de reloj: el de 60 s existe por el límite de los 31 días, que a
 * 24 h no se roza. Añadirlo cambiaría la forma medida sin necesidad.
 */
export function ventanaHaciaAtras(ahora: Date, horas = 24): VentanaDeConsulta {
  return {
    desde: new Date(ahora.getTime() - horas * 3_600_000),
    hasta: new Date(ahora.getTime()),
  };
}

/**
 * Tipos para los que `include_unknown_dates=false` está 📏 **medido**: los dos
 * que miran hacia delante (`changes_validation`, filas 19–20). Con `new` y
 * `removed` nunca se envió, y no se envía hasta medirlo.
 */
const ACEPTAN_FECHAS_DESCONOCIDAS: readonly TipoDeCambio[] = ["expiring", "upcoming"];

export interface OpcionesDeUrl {
  readonly base: string;
  readonly tipo: TipoDeCambio;
  readonly cursor: string | null;
  /** `expiring` y `upcoming` miran hacia delante; los demás, hacia atrás. */
  readonly ventana: VentanaDeConsulta | null;
  readonly idioma: string;
}

/**
 * ⚖️ **`include_unknown_dates=false` en `expiring` y `upcoming` con ventana.**
 * Decidido para el MVP: todavía no se representan anuncios sin fecha
 * conocida, así que no se piden. 📏 Aceptado en vivo para esos dos tipos
 * (`docs/DATA-SOURCES.md` §1.9 bis). **Con `new` y `removed` no se envía**: la
 * query medida para ellos no lo llevaba.
 */
export function construirUrl(opciones: OpcionesDeUrl): string {
  const url = new URL(`${opciones.base.replace(/\/+$/, "")}/changes`);
  const q = url.searchParams;
  q.set("country", PAIS);
  q.set("change_type", opciones.tipo);
  q.set("item_type", "show");
  q.set("catalogs", CATALOGOS_MVP);
  q.set("output_language", opciones.idioma);

  if (opciones.ventana !== null) {
    q.set("from", String(Math.floor(opciones.ventana.desde.getTime() / 1000)));
    q.set("to", String(Math.floor(opciones.ventana.hasta.getTime() / 1000)));
    if (ACEPTAN_FECHAS_DESCONOCIDAS.includes(opciones.tipo)) {
      q.set("include_unknown_dates", "false");
    }
  }
  // 📄 Documentado por el proveedor; 📏 sin medir: el Spike 1 nunca pasó de la
  // página 1. La primera paginación real lo confirma o lo desmiente en el acto.
  if (opciones.cursor !== null) q.set("cursor", opciones.cursor);

  return url.toString();
}

export interface PeticionDeCambios {
  readonly transporte: Transporte;
  readonly apiKey: string;
  readonly base?: string;
  readonly idioma?: string;
}

/**
 * Pide una página y la devuelve ya normalizada.
 *
 * Un HTTP no-2xx **lanza**: no se sigue paginando sobre una respuesta que no
 * se ha entendido. La cuota ya se gastó —el transporte reserva antes de
 * llamar— y eso no se deshace.
 */
export async function pedirPagina(
  peticion: PeticionDeCambios,
  opciones: Omit<OpcionesDeUrl, "base" | "idioma">,
): Promise<PaginaDeCambios> {
  const idioma = peticion.idioma ?? PAIS;
  const url = construirUrl({
    ...opciones,
    base: peticion.base ?? BASE_POR_DEFECTO,
    idioma,
  });

  const respuesta = await peticion.transporte(url, {
    headers: { "X-API-Key": peticion.apiKey, Accept: "application/json" },
  });

  if (!respuesta.ok) {
    const cuerpo = await respuesta.text();
    throw new Error(
      `/changes?change_type=${opciones.tipo} respondió ${String(respuesta.status)}: ` +
        cuerpo.slice(0, 300),
    );
  }

  const crudo: unknown = await respuesta.json();
  return normalizarPaginaDeCambios(respuestaCambiosProveedor.parse(crudo), PAIS);
}

/**
 * Recorre todas las páginas de un `change_type`.
 *
 * ⚠️ **`pedirCuota()` ocurre dentro del transporte, una vez por página y nunca
 * por aviso**: el coste es por request HTTP, y 25 avisos cuestan lo mismo que
 * 3. Si la cuota se agota a mitad, `PresupuestoAgotado` sube sin capturar y
 * `ejecutarJob` cierra la ejecución como `budget_stopped`.
 */
export async function* recorrerCambios(
  peticion: PeticionDeCambios,
  opciones: {
    readonly tipo: TipoDeCambio;
    readonly ventana: VentanaDeConsulta | null;
    readonly maximoDePaginas: number;
    /**
     * Para **reanudar** una lista cortada: el `nextCursor` que quedó sin
     * pedir. Con la misma ventana, es la misma lista en el mismo punto.
     */
    readonly cursorInicial?: string | null;
  },
): AsyncGenerator<PaginaDeCambios> {
  let cursor: string | null = opciones.cursorInicial ?? null;
  // Los cursores con los que YA se ha pedido una página en este recorrido.
  const vistos = new Set<string>(cursor === null ? [] : [cursor]);

  for (let pagina = 0; pagina < opciones.maximoDePaginas; pagina++) {
    const resultado: PaginaDeCambios = await pedirPagina(peticion, {
      tipo: opciones.tipo,
      ventana: opciones.ventana,
      cursor,
    });
    // La página se entrega igual: su contenido es real y ya está pagado. La
    // guarda actúa ANTES de pedir la siguiente.
    yield resultado;

    if (!resultado.hayMas) return;
    exigirProgreso(
      opciones.tipo,
      cursor,
      resultado.cursorSiguiente,
      vistos,
      pagina + 1,
    );
    cursor = resultado.cursorSiguiente;
    vistos.add(cursor);
  }
}

/**
 * ⚖️ **Guarda contra un cursor sin progreso** (2026-09-24). Con `hasMore=true`,
 * el cursor siguiente tiene que existir y no haberse usado ya en este
 * recorrido. Si no, pedir otra página sería gastar cuota para repetirse:
 *
 *   · 📏 Los cursores de `upcoming` son `timestamp:0` (fila 50) y vuelven a
 *     servir todos los avisos del instante de la frontera: 9 repetidos entre
 *     las páginas 1 y 2. Si más de 25 avisos compartieran un instante, el
 *     cursor siguiente sería **el mismo**, y el recorrido pediría la misma
 *     página hasta agotar su tope.
 *   · Antes, `hasMore=true` sin cursor paraba **en silencio**, y el checkpoint
 *     lo daba por recorrido completo: un horizonte a medias medía ausencias.
 *
 * El solapamiento de avisos no es falta de progreso: `1790838000:0` →
 * `1791504000:0` avanza aunque repita avisos. Solo cuenta el cursor.
 */
function exigirProgreso(
  tipo: TipoDeCambio,
  cursorDeEntrada: string | null,
  siguiente: string | null,
  vistos: ReadonlySet<string>,
  paginas: number,
): asserts siguiente is string {
  const invalido = siguiente === null || siguiente.trim() === "";
  if (!invalido && !vistos.has(siguiente)) return;
  throw new FalloOperativo(
    "cursor_sin_progreso",
    invalido
      ? `/changes?change_type=${tipo} dijo hasMore=true sin un cursor siguiente válido.`
      : `/changes?change_type=${tipo} devolvió un cursor ya usado en este recorrido: ${siguiente}.`,
    {
      change_type: tipo,
      cursor_de_entrada: cursorDeEntrada,
      cursor_siguiente: siguiente,
      paginas_del_recorrido: paginas,
    },
  );
}
