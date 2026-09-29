/**
 * Lectura del corpus del Spike 1 desde disco. **Cero llamadas a la API.**
 *
 * ⚠️ Estos ficheros **no son respuestas de la API**: son lo que archivó
 * `spike-1/probe.mjs`, que guarda `{ meta: <sus metadatos>, body: <la
 * respuesta> }`. Por eso aquí se desenvuelve el `body`. La API emite `shows` y
 * `changes` **en la raíz** (`docs/DATA-SOURCES.md` §1.9 bis).
 *
 * Dentro de ese `body`, el cuerpo viene en tres formas —`shows[]` en
 * `shows/search/filters`, `shows{}` indexado por id en `/changes`, y un array
 * plano en `/shows/top`— pero todas llevan dentro el mismo objeto `show`. En
 * vez de un lector por forma, se recorre el JSON buscando esos objetos: si el
 * proveedor añade un envoltorio nuevo, esto sigue funcionando.
 *
 * La normalización la hace el **adaptador de verdad**, no una copia. Si el
 * pipeline normalizara distinto que la ingesta, esta validación no probaría
 * nada sobre la ingesta.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type {
  DisponibilidadCanonica,
  TituloCanonico,
} from "../../adapters/contracts.ts";
import { normalizarShow } from "../../adapters/streaming-availability/normalizar.ts";
import { showProveedor } from "../../adapters/streaming-availability/schema.ts";

const PAIS = "es";

/** Un título del corpus, con el instante en que lo observamos. */
export interface TituloObservado {
  readonly titulo: TituloCanonico;
  /**
   * Cuándo se capturó, sacado del manifiesto del Spike 1. **Nunca `now()`**:
   * decir que un dato de septiembre se comprobó hoy sería mentir sobre su
   * frescura, y de `last_checked_at` depende el «Comprobado el {fecha}».
   */
  readonly observadoEn: Date;
  /** Instante de observación de cada opción, por firma. */
  readonly observadoPorOpcion: ReadonlyMap<string, Date>;
}

export interface CorpusLeido {
  readonly titulos: readonly TituloObservado[];
  readonly diagnostico: {
    readonly ficherosLeidos: number;
    readonly ficherosIlegibles: number;
    readonly showsBrutos: number;
    readonly showsRechazadosPorSchema: number;
    /**
     * Shows que pasan el schema pero **sin identidad** (`imdbId` vacío o solo
     * espacios, `normalizarImdbId`). No entran: agruparlos por un `imdbId`
     * vacío fundiría títulos distintos en uno.
     */
    readonly showsSinIdentidad: number;
    readonly titulosUnicos: number;
    readonly opcionesEs: number;
    readonly ficherosSinMarcaDeTiempo: number;
  };
}

/** Identidad de una opción: todo lo que la distingue de otra. */
export function firmaDeOpcion(d: DisponibilidadCanonica): string {
  return JSON.stringify([
    d.plataformaId,
    d.tipoOferta,
    d.enlace,
    d.calidad,
    d.addon,
    d.precio?.importe ?? null,
    d.disponibleDesde?.toISOString() ?? null,
    d.expiraEl?.toISOString() ?? null,
  ]);
}

interface Manifiesto {
  readonly llamadas?: readonly { readonly slug?: string; readonly ts_utc?: string }[];
}

/** `003-B-netflix-movie.json` → `B-netflix-movie`, que es el slug del manifiesto. */
function slugDeFichero(nombre: string): string {
  return nombre.replace(/^\d+-/, "").replace(/\.json$/, "");
}

function leerMarcasDeTiempo(raizSpike: string): {
  porSlug: Map<string, Date>;
  respaldo: Date;
} {
  const porSlug = new Map<string, Date>();
  let ultima: Date | null = null;

  for (const fichero of ["manifest.json", "daily.json", "popularity.json"]) {
    let m: Manifiesto;
    try {
      m = JSON.parse(readFileSync(join(raizSpike, fichero), "utf8")) as Manifiesto;
    } catch {
      continue;
    }
    for (const llamada of m.llamadas ?? []) {
      if (llamada.slug === undefined || llamada.ts_utc === undefined) continue;
      const t = new Date(llamada.ts_utc);
      if (Number.isNaN(t.getTime())) continue;
      porSlug.set(llamada.slug, t);
      if (ultima === null || t > ultima) ultima = t;
    }
  }

  if (ultima === null) {
    throw new Error(
      "El manifiesto del Spike 1 no trae ninguna marca de tiempo utilizable.\n" +
        "  Sin ella no se puede fechar la observación, y fecharla con now() sería\n" +
        "  mentir sobre la frescura del dato.",
    );
  }
  return { porSlug, respaldo: ultima };
}

/** Recorre el JSON y recoge todo objeto que sea un `show` con `imdbId`. */
function recogerShows(nodo: unknown, salida: unknown[]): void {
  if (Array.isArray(nodo)) {
    for (const hijo of nodo) recogerShows(hijo, salida);
    return;
  }
  if (nodo === null || typeof nodo !== "object") return;
  const objeto = nodo as Record<string, unknown>;
  if (objeto.itemType === "show" && typeof objeto.imdbId === "string") {
    salida.push(nodo);
    return;
  }
  for (const valor of Object.values(objeto)) recogerShows(valor, salida);
}

/**
 * @param opciones.excluir ficheros de `raw/` que no entran en el corpus. Lo
 * usa el ensayo de `deltas` para separar la **línea base** —el catálogo— de
 * los **avisos** de `/changes`, que son lo que se ensaya contra ella.
 */
export function leerCorpusSpike1(
  raizSpike: string,
  opciones: { readonly excluir?: (fichero: string) => boolean } = {},
): CorpusLeido {
  const raizCruda = join(raizSpike, "raw");
  const { porSlug, respaldo } = leerMarcasDeTiempo(raizSpike);
  const excluir = opciones.excluir ?? (() => false);

  const ficheros = readdirSync(raizCruda)
    .filter((f) => f.endsWith(".json") && !excluir(f))
    .sort();

  let ilegibles = 0;
  let brutos = 0;
  let rechazados = 0;
  let sinIdentidad = 0;
  let sinMarca = 0;

  // imdbId → acumulador. La primera aparición manda en los campos del título;
  // la disponibilidad es la UNIÓN de todas, para no perder ofertas que solo
  // salieron en una de las respuestas.
  const acumulado = new Map<
    string,
    {
      titulo: TituloCanonico;
      observadoEn: Date;
      opciones: Map<string, { d: DisponibilidadCanonica; en: Date }>;
    }
  >();

  for (const fichero of ficheros) {
    let crudo: unknown;
    try {
      crudo = JSON.parse(readFileSync(join(raizCruda, fichero), "utf8")) as unknown;
    } catch {
      ilegibles++;
      continue;
    }

    const marca = porSlug.get(slugDeFichero(fichero));
    if (marca === undefined) sinMarca++;
    const observadoEn = marca ?? respaldo;

    const envoltorio = crudo as { body?: unknown };
    const cuerpo = envoltorio.body ?? crudo;

    const encontrados: unknown[] = [];
    recogerShows(cuerpo, encontrados);
    brutos += encontrados.length;

    for (const bruto of encontrados) {
      const validado = showProveedor.safeParse(bruto);
      if (!validado.success) {
        rechazados++;
        continue;
      }
      const titulo = normalizarShow(validado.data, PAIS);
      if (titulo === null) {
        sinIdentidad++;
        continue;
      }

      let entrada = acumulado.get(titulo.ids.imdbId);
      if (entrada === undefined) {
        entrada = { titulo, observadoEn, opciones: new Map() };
        acumulado.set(titulo.ids.imdbId, entrada);
      }
      for (const d of titulo.disponibilidad) {
        const firma = firmaDeOpcion(d);
        if (!entrada.opciones.has(firma))
          entrada.opciones.set(firma, { d, en: observadoEn });
      }
    }
  }

  let opcionesEs = 0;
  const titulos: TituloObservado[] = [];
  for (const entrada of acumulado.values()) {
    const disponibilidad = [...entrada.opciones.values()].map((o) => o.d);
    opcionesEs += disponibilidad.length;
    const observadoPorOpcion = new Map<string, Date>();
    for (const [firma, o] of entrada.opciones) observadoPorOpcion.set(firma, o.en);
    titulos.push({
      titulo: { ...entrada.titulo, disponibilidad },
      observadoEn: entrada.observadoEn,
      observadoPorOpcion,
    });
  }

  return {
    titulos,
    diagnostico: {
      ficherosLeidos: ficheros.length,
      ficherosIlegibles: ilegibles,
      showsBrutos: brutos,
      showsRechazadosPorSchema: rechazados,
      showsSinIdentidad: sinIdentidad,
      titulosUnicos: titulos.length,
      opcionesEs,
      ficherosSinMarcaDeTiempo: sinMarca,
    },
  };
}
