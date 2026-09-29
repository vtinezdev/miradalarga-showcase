import type {
  FichaDeTitulo,
  FiltroDeCatalogo,
  FiltroDeMovimientos,
  IdPlataforma,
  Instante,
  ListaEditorial,
  MatrizDeCapacidades,
  Movimiento,
  Plataforma,
  PosicionMejorValorada,
  RecuentoDeGenero,
  ResultadoDeBusqueda,
  TipoDeMovimiento,
  TipoDeObra,
  TituloResumen,
} from "./modelo.ts";

/**
 * Puerto de lectura del catálogo. Es lo único que las consultas de aplicación
 * (`consultas.ts`) conocen del origen de los datos.
 *
 * Lo implementan dos adaptadores: el de desarrollo (`desarrollo/`), con datos
 * ficticios en memoria, y el de Neon (`src/db/queries/repositorio-neon.ts`),
 * con el usuario de **solo lectura** del runtime (CLAUDE.md, regla 8). Cuál se
 * usa lo decide `proveedor.ts` (`CATALOGO_FUENTE`): ninguna pantalla lo sabe.
 *
 * Reglas del contrato, que cualquier adaptador debe cumplir:
 *
 * - **Solo lectura.** Ningún método escribe.
 * - **Ninguna llamada externa** (CLAUDE.md, regla 1): un adaptador lee de
 *   nuestra base o de memoria, nunca de una API de terceros.
 * - **Solo imágenes publicables** (ADR 0008): el adaptador decide si una imagen
 *   tiene base de uso y está en nuestro CDN; si no, no la devuelve.
 * - **Solo lo que la matriz de capacidades permite** (docs/DATA-SOURCES.md
 *   §1.4): p. ej., `movimientos("se-va")` no devuelve salidas de plataformas
 *   cuya capacidad `expiring` no esté en ✅.
 */
export interface RepositorioDeCatalogo {
  plataformas(): Promise<Plataforma[]>;
  capacidades(): Promise<MatrizDeCapacidades>;

  /** Instante de la última sincronización completa del catálogo. */
  ultimaComprobacion(): Promise<Instante>;
  /** Desde cuándo registramos movimientos (el ancla del seed, ADR 0009). */
  inicioDelRegistro(): Promise<Instante>;

  ficha(tipo: TipoDeObra, slug: string): Promise<FichaDeTitulo | null>;
  titulos(ids: readonly string[]): Promise<TituloResumen[]>;
  slugs(tipo: TipoDeObra): Promise<string[]>;
  /** Títulos con al menos una persona de dirección en común, sin el propio. */
  delMismoDirector(tituloId: string, limite: number): Promise<TituloResumen[]>;

  /**
   * Búsqueda por título, en español o en su idioma original: sin distinguir
   * mayúsculas ni tildes, y todas las palabras de la consulta. Orden: título
   * exacto, empieza por la consulta, el resto; a igualdad, `compararTitulos`.
   * `total` cuenta todas las coincidencias aunque `limite` corte la lista.
   */
  buscar(
    consulta: string,
    limite: number,
  ): Promise<{ resultados: ResultadoDeBusqueda[]; total: number }>;

  /**
   * Títulos **disponibles hoy** que cumplen el filtro, en orden alfabético
   * (`compararTitulos`): un orden neutro, no un ranking.
   */
  explorar(
    filtro: FiltroDeCatalogo,
    limite: number,
  ): Promise<{ titulos: TituloResumen[]; total: number }>;
  /** Géneros de los títulos disponibles hoy, del más al menos frecuente. */
  generos(filtro: Omit<FiltroDeCatalogo, "genero">): Promise<RecuentoDeGenero[]>;
  /** Títulos disponibles hoy en cada plataforma, por tipo de obra. */
  recuentoPorPlataforma(): Promise<Record<IdPlataforma, Record<TipoDeObra, number>>>;

  /** Listas editoriales publicadas, de la revisada más recientemente a la más antigua. */
  listas(): Promise<ListaEditorial[]>;
  /** La selección principal de la portada, si hay una marcada. */
  listaDestacada(): Promise<ListaEditorial | null>;
  lista(slug: string): Promise<ListaEditorial | null>;

  /**
   * Movimientos de un tipo. Los pasados («llega», «se-fue», «cambio»), del más
   * reciente al más antiguo; los futuros («se-va», «proximamente»), del más
   * próximo al más lejano.
   */
  movimientos(
    tipo: TipoDeMovimiento,
    limite: number,
    filtro?: FiltroDeMovimientos,
  ): Promise<Movimiento[]>;

  /**
   * Ranking A (docs/RANKINGS.md), ya con su desempate determinista. Con
   * `plataforma`, solo títulos con alguna oferta en ella; las posiciones se
   * numeran dentro de ese ranking.
   */
  mejorValoradas(
    tipo: TipoDeObra,
    limite: number,
    filtro?: { plataforma?: IdPlataforma },
  ): Promise<PosicionMejorValorada[]>;
}
