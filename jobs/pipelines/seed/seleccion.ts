/**
 * **Selección del seed**: qué títulos entran, a partir de las páginas del
 * crudo (ADR 0009 §1). Función pura del crudo: dos cargas del mismo crudo
 * seleccionan exactamente lo mismo.
 *
 * ── Las reglas ───────────────────────────────────────────────────────────────
 *
 *   · **Identidad:** `imdbId` normalizado (`normalizarImdbId`). Un show sin
 *     identidad no entra y se cuenta como `sinIdentidad` en su estrato.
 *   · **Snapshot más reciente por `imdbId`:** si un título aparece en varias
 *     páginas, **gana la observación completa más reciente** —mayor instante de
 *     respuesta; a igual instante, la página de mayor `n` y, dentro de ella, la
 *     posición posterior—. **Sus ofertas, géneros e imágenes son las de ese
 *     snapshot, y solo las suyas.** ⚖️ Esto sustituye a la regla del Spike
 *     —«la primera aparición manda» y **unión** de ofertas—: cada snapshot
 *     trae todas las ofertas de `es` (📏 `raw/011`), y unir resucitaría una
 *     oferta que desapareció entre dos páginas.
 *   · **Elegible:** el snapshot ganador tiene al menos una opción de una
 *     plataforma del MVP. Si no, `sinOfertaMvp`, y no entra: la elegibilidad se
 *     decide **después** de deduplicar, así que una oferta vieja tampoco puede
 *     colarse por esta puerta.
 *   · **Un show que viola el schema invalida su página** (`validarShows`):
 *     la captura la marca `invalida` y falla con `respuesta_invalida`, y la
 *     verificación la rechaza. Una deriva del contrato del proveedor no puede
 *     convertirse en títulos omitidos en silencio. La **única** excepción es la
 *     identidad: `imdbId` ausente, `null`, vacío o solo espacios pasa el schema
 *     y se cuenta como `sinIdentidad` (ADR 0009 §1, enmienda del 2026-09-27).
 *   · **Anomalía contada, no corregida:** un mismo `imdbId` con distinto
 *     `showType` entre snapshots.
 *
 * El recuento de únicos para el criterio de parada sale de aquí también: la
 * captura y la verificación usan la misma cuenta.
 */
import type { TituloCanonico } from "../../adapters/contracts.ts";
import { normalizarShow } from "../../adapters/streaming-availability/normalizar.ts";
import { showProveedor } from "../../adapters/streaming-availability/schema.ts";
import type { TituloObservado } from "./origen.ts";
import { plataformaDesdeFuente } from "./plataformas.ts";

const PAIS = "es";

/** El primer show de una página que no cumple el schema del proveedor. */
export interface ShowInvalido {
  readonly posicion: number;
  /** `ruta: mensaje` de Zod, sin valores: el contenido no se reimprime. */
  readonly problemas: readonly string[];
}

/**
 * Valida **todos** los shows de una página contra `showProveedor`. `null` si
 * todos lo cumplen. Un `imdbId` ausente, `null` o vacío **lo cumple**: la falta
 * de identidad no es una deriva del contrato, y se cuenta después.
 */
export function validarShows(shows: readonly unknown[]): ShowInvalido | null {
  for (const [posicion, bruto] of shows.entries()) {
    const r = showProveedor.safeParse(bruto);
    if (!r.success) {
      return {
        posicion,
        problemas: r.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.map(String).join(".") || "(raíz)"}: ${i.message}`),
      };
    }
  }
  return null;
}

/** Lo que la selección necesita de una página ya leída y confirmada. */
export interface PaginaParaSeleccion {
  readonly n: number;
  readonly estrato: string;
  /** El instante de respuesta: el de la observación. **Nunca el de la carga.** */
  readonly respondidaEn: Date;
  /** Los shows del cuerpo. Tienen que haber pasado `validarShows`. */
  readonly shows: readonly unknown[];
}

export interface ContadoresDeEstrato {
  readonly shows: number;
  readonly sinIdentidad: number;
  /** Apariciones de un `imdbId` ya visto **en el mismo estrato**. */
  readonly duplicadosEnEstrato: number;
  /** Títulos cuyo snapshot ganador es de este estrato y no tiene oferta MVP. */
  readonly sinOfertaMvp: number;
  /** Títulos elegibles cuyo snapshot ganador es de este estrato. */
  readonly elegibles: number;
}

export interface SeleccionDelSeed {
  /** Los elegibles, ordenados por `imdbId`. */
  readonly titulos: readonly TituloObservado[];
  readonly porEstrato: Readonly<Record<string, ContadoresDeEstrato>>;
  /** `imdbId` distintos con identidad, elegibles o no. */
  readonly titulosIdentificados: number;
  /** Veces que un snapshot más reciente sustituyó a otro del mismo título. */
  readonly sustituciones: number;
  /** Títulos vistos en más de un estrato. */
  readonly titulosEnVariosEstratos: number;
  /**
   * **El solapamiento real**, por par de estratos (`a|b`, con `a < b`):
   * cuántos títulos comparten. Sustituye al 8 % de suelo (M3).
   */
  readonly pares: Readonly<Record<string, number>>;
  /** Mismo `imdbId` con distinto `showType` entre snapshots. */
  readonly tiposDistintos: number;
}

interface Snapshot {
  readonly titulo: TituloCanonico;
  readonly showType: string;
  readonly respondidaEn: number;
  readonly n: number;
  readonly posicion: number;
  readonly estrato: string;
}

interface Contadores {
  shows: number;
  sinIdentidad: number;
  duplicadosEnEstrato: number;
}

/** `a` es más reciente que `b`: instante, después página, después posición. */
function masReciente(a: Snapshot, b: Snapshot): boolean {
  if (a.respondidaEn !== b.respondidaEn) return a.respondidaEn > b.respondidaEn;
  if (a.n !== b.n) return a.n > b.n;
  return a.posicion > b.posicion;
}

/** Al menos una opción de una plataforma del MVP, en `es`. */
export function esElegible(titulo: TituloCanonico): boolean {
  return titulo.disponibilidad.some(
    (d) => plataformaDesdeFuente(d.plataformaId) !== null,
  );
}

export interface AcumuladorDeSeleccion {
  /** Añade una página confirmada. El orden de llegada no cambia el resultado. */
  anadir(pagina: PaginaParaSeleccion): void;
  /** Títulos elegibles únicos con lo añadido hasta ahora. */
  unicosElegibles(): number;
  resultado(): SeleccionDelSeed;
}

export function crearAcumulador(): AcumuladorDeSeleccion {
  const ganadores = new Map<string, Snapshot>();
  const estratosPorTitulo = new Map<string, Set<string>>();
  const tipos = new Map<string, Set<string>>();
  const contadores = new Map<string, Contadores>();
  let sustituciones = 0;

  const de = (estrato: string): Contadores => {
    let c = contadores.get(estrato);
    if (c === undefined) {
      c = { shows: 0, sinIdentidad: 0, duplicadosEnEstrato: 0 };
      contadores.set(estrato, c);
    }
    return c;
  };

  return {
    anadir(pagina) {
      const c = de(pagina.estrato);
      pagina.shows.forEach((bruto, posicion) => {
        c.shows++;
        const validado = showProveedor.safeParse(bruto);
        if (!validado.success) {
          // Quien llama tenía que haberla validado: una página así es inválida.
          throw new Error(
            `La página ${String(pagina.n)} tiene un show que no cumple el schema ` +
              `(posición ${String(posicion)}): no se selecciona una página inválida.`,
          );
        }
        const titulo = normalizarShow(validado.data, PAIS);
        if (titulo === null) {
          c.sinIdentidad++;
          return;
        }
        const imdb = titulo.ids.imdbId;

        let estratos = estratosPorTitulo.get(imdb);
        if (estratos === undefined) {
          estratos = new Set();
          estratosPorTitulo.set(imdb, estratos);
        }
        if (estratos.has(pagina.estrato)) c.duplicadosEnEstrato++;
        estratos.add(pagina.estrato);

        let vistos = tipos.get(imdb);
        if (vistos === undefined) {
          vistos = new Set();
          tipos.set(imdb, vistos);
        }
        vistos.add(validado.data.showType);

        const nuevo: Snapshot = {
          titulo,
          showType: validado.data.showType,
          respondidaEn: pagina.respondidaEn.getTime(),
          n: pagina.n,
          posicion,
          estrato: pagina.estrato,
        };
        const anterior = ganadores.get(imdb);
        if (anterior === undefined) {
          ganadores.set(imdb, nuevo);
          return;
        }
        sustituciones++;
        // El snapshot completo, o nada: nunca una mezcla de los dos.
        if (masReciente(nuevo, anterior)) ganadores.set(imdb, nuevo);
      });
    },

    unicosElegibles() {
      let n = 0;
      for (const s of ganadores.values()) if (esElegible(s.titulo)) n++;
      return n;
    },

    resultado() {
      const porEstrato: Record<string, ContadoresDeEstrato> = {};
      const extra = new Map<string, { sinOfertaMvp: number; elegibles: number }>();
      const titulos: TituloObservado[] = [];

      for (const imdb of [...ganadores.keys()].sort()) {
        const s = ganadores.get(imdb);
        if (s === undefined) continue;
        const e = extra.get(s.estrato) ?? { sinOfertaMvp: 0, elegibles: 0 };
        extra.set(s.estrato, e);
        if (!esElegible(s.titulo)) {
          e.sinOfertaMvp++;
          continue;
        }
        e.elegibles++;
        titulos.push({
          titulo: s.titulo,
          observadoEn: new Date(s.respondidaEn),
          // Todas las opciones son de ese snapshot: comparten su instante.
          observadoPorOpcion: new Map(),
        });
      }

      for (const [estrato, c] of contadores) {
        porEstrato[estrato] = {
          ...c,
          sinOfertaMvp: extra.get(estrato)?.sinOfertaMvp ?? 0,
          elegibles: extra.get(estrato)?.elegibles ?? 0,
        };
      }

      const pares: Record<string, number> = {};
      let enVarios = 0;
      for (const estratos of estratosPorTitulo.values()) {
        if (estratos.size < 2) continue;
        enVarios++;
        const lista = [...estratos].sort();
        for (let i = 0; i < lista.length; i++) {
          for (let j = i + 1; j < lista.length; j++) {
            const clave = `${lista[i] ?? ""}|${lista[j] ?? ""}`;
            pares[clave] = (pares[clave] ?? 0) + 1;
          }
        }
      }

      let tiposDistintos = 0;
      for (const t of tipos.values()) if (t.size > 1) tiposDistintos++;

      return {
        titulos,
        porEstrato,
        titulosIdentificados: ganadores.size,
        sustituciones,
        titulosEnVariosEstratos: enVarios,
        pares,
        tiposDistintos,
      };
    },
  };
}

/** La selección de un conjunto de páginas confirmadas. */
export function seleccionar(paginas: readonly PaginaParaSeleccion[]): SeleccionDelSeed {
  const acumulador = crearAcumulador();
  for (const p of paginas) acumulador.anadir(p);
  return acumulador.resultado();
}
