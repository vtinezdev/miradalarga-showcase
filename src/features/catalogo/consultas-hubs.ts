import { cache } from "react";
import {
  DIA_MS,
  VENTANA_DE_LLEGADAS_MS,
  tarjetaDeLista,
  type FilaDeRadar,
  type TarjetaDeLista,
} from "./consultas.ts";
import { enumerar, mensajeDeCapacidad } from "./formato.ts";
import type {
  EntradaEditorial,
  Instante,
  ListaEditorial,
  MatrizDeCapacidades,
  Movimiento,
  Plataforma,
  PosicionMejorValorada,
  RecuentoDeGenero,
  TipoDeObra,
  TituloResumen,
} from "./modelo.ts";
import { repositorio } from "./proveedor.ts";
import { MINIMO_PARA_PUBLICAR_RANKING, priorizarLoEditorial } from "./reglas.ts";
import type { RepositorioDeCatalogo } from "./repositorio.ts";

/**
 * Hubs de navegación (SCREENS.md §7 y §8): `/plataformas`, `/plataformas/{slug}`,
 * `/peliculas` y `/series`. Cada bloque existe **solo si tiene dato**: ninguna
 * sección vacía de relleno, y cuando falta un dato por capacidad de la fuente,
 * se dice por qué (INFORMATION-ARCHITECTURE.md §7).
 */

const POR_COLUMNA = 5;
const EN_RANKING = 10;
const DE_NUESTRAS_LISTAS = 6;
const POR_GENERO = 6;
const HORIZONTE_MS = 31 * DIA_MS;

// ── Radar en tres columnas ─────────────────────────────────────────────────

export type TipoDeColumna = "llega" | "se-va" | "proximamente";

export interface ColumnaDeRadar {
  tipo: TipoDeColumna;
  filas: FilaDeRadar[];
  /**
   * Ya redactada: por qué está vacía (capacidad o ausencia real) o, si tiene
   * filas, qué plataformas cubre. Nunca un vacío mudo.
   */
  nota?: string;
}

async function columnasDeRadar(
  repo: RepositorioDeCatalogo,
  contexto: {
    referencia: Instante;
    plataformas: Plataforma[];
    capacidades: MatrizDeCapacidades;
    enListas: ReadonlySet<string>;
    plataforma?: Plataforma;
    obra?: TipoDeObra;
  },
): Promise<ColumnaDeRadar[]> {
  const { referencia, plataforma, obra } = contexto;
  const t = Date.parse(referencia);
  const base = {
    ...(plataforma ? { plataforma: plataforma.id } : {}),
    ...(obra ? { obra } : {}),
  };
  const futuro = {
    ...base,
    desde: referencia,
    hasta: new Date(t + HORIZONTE_MS).toISOString(),
  };
  const [llega, seVa, proximamente] = await Promise.all([
    repo.movimientos("llega", 50, {
      ...base,
      desde: new Date(t - VENTANA_DE_LLEGADAS_MS).toISOString(),
      hasta: referencia,
    }),
    repo.movimientos("se-va", 50, futuro),
    repo.movimientos("proximamente", 50, futuro),
  ]);
  const elegidos = {
    llega: priorizarLoEditorial(llega, contexto.enListas, POR_COLUMNA),
    "se-va": priorizarLoEditorial(seVa, contexto.enListas, POR_COLUMNA),
    proximamente: priorizarLoEditorial(proximamente, contexto.enListas, POR_COLUMNA),
  };
  const titulos = new Map(
    (
      await repo.titulos([
        ...new Set(Object.values(elegidos).flatMap((ms) => ms.map((m) => m.tituloId))),
      ])
    ).map((x) => [x.id, x]),
  );
  const filas = (ms: Movimiento[]): FilaDeRadar[] =>
    ms.flatMap((movimiento) => {
      const titulo = titulos.get(movimiento.tituloId);
      return titulo
        ? [{ movimiento, titulo, enListas: contexto.enListas.has(movimiento.tituloId) }]
        : [];
    });

  const que =
    obra === "pelicula" ? "películas" : obra === "serie" ? "series" : "títulos";
  const nota = (tipo: TipoDeColumna, vacia: boolean): string | undefined => {
    if (tipo === "llega") {
      if (!vacia) return undefined;
      return plataforma
        ? `Nada nuevo en ${plataforma.nombre} en los últimos 14 días.`
        : `Ninguna llegada de ${que} en los últimos 14 días.`;
    }
    const capacidad = tipo === "se-va" ? "expiring" : "upcoming";
    if (plataforma) {
      const estado = contexto.capacidades[plataforma.id]?.[capacidad] ?? "unknown";
      if (estado !== "supported_with_data" || vacia)
        return mensajeDeCapacidad(capacidad, estado, plataforma.nombre);
      return undefined;
    }
    const cubiertas = contexto.plataformas
      .filter((p) => contexto.capacidades[p.id]?.[capacidad] === "supported_with_data")
      .map((p) => p.nombre);
    const cobertura =
      tipo === "se-va"
        ? `Solo publicamos salidas con fecha de ${enumerar(cubiertas)}: las demás no las anuncian o todavía no las medimos.`
        : `Solo publicamos llegadas anunciadas de ${enumerar(cubiertas)}: las demás no las anuncian o todavía no las medimos.`;
    if (!vacia) return cobertura;
    return tipo === "se-va"
      ? `Ningún aviso de salida para ${que} en los próximos 31 días. ${cobertura}`
      : `Ninguna llegada anunciada de ${que} en los próximos 31 días. ${cobertura}`;
  };

  return (["llega", "se-va", "proximamente"] as const).map((tipo) => {
    const lista = filas(elegidos[tipo]);
    const n = nota(tipo, lista.length === 0);
    return { tipo, filas: lista, ...(n ? { nota: n } : {}) };
  });
}

// ── Índice de plataformas ──────────────────────────────────────────────────

export interface ResumenDePlataforma {
  plataforma: Plataforma;
  recuento: Record<TipoDeObra, number>;
  llegadasRecientes: number;
  salidasProximas: number;
  /** Hasta tres títulos de nuestras listas disponibles en ella. */
  deNuestrasListas: TituloResumen[];
  /** Lo que no podemos publicar de ella, ya redactado. */
  limites: string[];
}

export interface IndiceDePlataformas {
  comprobadoEn: Instante;
  plataformas: ResumenDePlataforma[];
}

export async function construirIndiceDePlataformas(
  repo: RepositorioDeCatalogo,
): Promise<IndiceDePlataformas> {
  const [comprobadoEn, plataformas, capacidades, recuentos, listas] = await Promise.all(
    [
      repo.ultimaComprobacion(),
      repo.plataformas(),
      repo.capacidades(),
      repo.recuentoPorPlataforma(),
      repo.listas(),
    ],
  );
  const t = Date.parse(comprobadoEn);
  const [llega, seVa, titulos] = await Promise.all([
    repo.movimientos("llega", 500, {
      desde: new Date(t - VENTANA_DE_LLEGADAS_MS).toISOString(),
      hasta: comprobadoEn,
    }),
    repo.movimientos("se-va", 500, {
      desde: comprobadoEn,
      hasta: new Date(t + HORIZONTE_MS).toISOString(),
    }),
    mapaDeTitulos(repo, listas),
  ]);
  const editoriales = entradasPorTitulo(listas);

  return {
    comprobadoEn,
    plataformas: plataformas.map((plataforma) => ({
      plataforma,
      recuento: recuentos[plataforma.id] ?? { pelicula: 0, serie: 0 },
      llegadasRecientes: llega.filter((m) => m.plataforma.id === plataforma.id).length,
      salidasProximas: seVa.filter((m) => m.plataforma.id === plataforma.id).length,
      deNuestrasListas: [...editoriales.keys()]
        .flatMap((id) => titulos.get(id) ?? [])
        .filter((x) => x.disponibilidad.some((o) => o.plataforma.id === plataforma.id))
        .slice(0, 3),
      limites: (["expiring", "upcoming"] as const).flatMap((c) => {
        const estado = capacidades[plataforma.id]?.[c] ?? "unknown";
        return estado === "supported_with_data"
          ? []
          : [mensajeDeCapacidad(c, estado, plataforma.nombre)];
      }),
    })),
  };
}

export const obtenerIndiceDePlataformas = cache(() =>
  construirIndiceDePlataformas(repositorio()),
);

// ── Hub de una plataforma ──────────────────────────────────────────────────

export interface TituloDeLista {
  titulo: TituloResumen;
  entrada: EntradaEditorial;
  lista: { titulo: string; slug: string };
}

export interface HubDePlataforma {
  plataforma: Plataforma;
  otras: Plataforma[];
  comprobadoEn: Instante;
  recuento: Record<TipoDeObra, number>;
  deNuestrasListas: TituloDeLista[];
  radar: ColumnaDeRadar[];
  /** Vacío si no alcanza el mínimo de publicación: el bloque no se pinta. */
  mejorValoradas: {
    peliculas: PosicionMejorValorada[];
    series: PosicionMejorValorada[];
  };
}

export async function construirHubDePlataforma(
  repo: RepositorioDeCatalogo,
  slug: string,
): Promise<HubDePlataforma | null> {
  // Dos rondas: lo que no depende de la plataforma, y lo que sí.
  const [plataformas, comprobadoEn, capacidades, recuentos, listas] = await Promise.all(
    [
      repo.plataformas(),
      repo.ultimaComprobacion(),
      repo.capacidades(),
      repo.recuentoPorPlataforma(),
      repo.listas(),
    ],
  );
  const plataforma = plataformas.find((p) => p.slug === slug);
  if (!plataforma) return null;

  const [peliculas, series, radar, titulos] = await Promise.all([
    repo.mejorValoradas("pelicula", EN_RANKING, { plataforma: plataforma.id }),
    repo.mejorValoradas("serie", EN_RANKING, { plataforma: plataforma.id }),
    columnasDeRadar(repo, {
      referencia: comprobadoEn,
      plataformas,
      capacidades,
      enListas: idsEnListas(listas),
      plataforma,
    }),
    mapaDeTitulos(repo, listas),
  ]);

  const deNuestrasListas: TituloDeLista[] = [];
  for (const [id, { entrada, lista }] of entradasPorTitulo(listas)) {
    const titulo = titulos.get(id);
    if (!titulo?.disponibilidad.some((o) => o.plataforma.id === plataforma.id))
      continue;
    deNuestrasListas.push({
      titulo,
      entrada,
      lista: { titulo: lista.titulo, slug: lista.slug },
    });
    if (deNuestrasListas.length === DE_NUESTRAS_LISTAS) break;
  }

  return {
    plataforma,
    otras: plataformas.filter((p) => p.id !== plataforma.id),
    comprobadoEn,
    recuento: recuentos[plataforma.id] ?? { pelicula: 0, serie: 0 },
    deNuestrasListas,
    radar,
    mejorValoradas: { peliculas: publicable(peliculas), series: publicable(series) },
  };
}

export const obtenerHubDePlataforma = cache((slug: string) =>
  construirHubDePlataforma(repositorio(), slug),
);

// ── Hub de tipo: películas o series ────────────────────────────────────────

export interface GeneroConTitulos extends RecuentoDeGenero {
  /** Una muestra en orden alfabético, no un ranking. */
  titulos: TituloResumen[];
}

export interface HubDeTipo {
  tipo: TipoDeObra;
  comprobadoEn: Instante;
  total: number;
  listas: TarjetaDeLista[];
  radar: ColumnaDeRadar[];
  mejorValoradas: PosicionMejorValorada[];
  porPlataforma: { plataforma: Plataforma; recuento: number }[];
  generos: GeneroConTitulos[];
  /** Solo series: las de una única temporada. Dato, no criterio. */
  unaTemporada: TituloResumen[];
}

export async function construirHubDeTipo(
  repo: RepositorioDeCatalogo,
  tipo: TipoDeObra,
): Promise<HubDeTipo> {
  const [
    comprobadoEn,
    plataformas,
    capacidades,
    listas,
    ranking,
    recuentos,
    catalogo,
    generos,
  ] = await Promise.all([
    repo.ultimaComprobacion(),
    repo.plataformas(),
    repo.capacidades(),
    repo.listas(),
    repo.mejorValoradas(tipo, EN_RANKING),
    repo.recuentoPorPlataforma(),
    // Para las series de una temporada: el catálogo del tipo, en orden neutro.
    tipo === "serie" ? repo.explorar({ tipo }, 500) : repo.explorar({ tipo }, 0),
    repo.generos({ tipo }),
  ]);
  const enListas = idsEnListas(listas);
  const [radar, titulos, muestras] = await Promise.all([
    columnasDeRadar(repo, {
      referencia: comprobadoEn,
      plataformas,
      capacidades,
      enListas,
      obra: tipo,
    }),
    mapaDeTitulos(repo, listas),
    Promise.all(
      generos.map((g) => repo.explorar({ tipo, genero: g.nombre }, POR_GENERO)),
    ),
  ]);

  const delTipo = listas.filter((l) =>
    l.entradas.some((e) => titulos.get(e.tituloId)?.tipo === tipo),
  );

  return {
    tipo,
    comprobadoEn,
    total: catalogo.total,
    listas: delTipo.map((l) => tarjetaDeLista(l, titulos)),
    radar,
    mejorValoradas: publicable(ranking),
    porPlataforma: plataformas.map((plataforma) => ({
      plataforma,
      recuento: recuentos[plataforma.id]?.[tipo] ?? 0,
    })),
    generos: generos.map((g, i) => ({ ...g, titulos: muestras[i]?.titulos ?? [] })),
    unaTemporada:
      tipo === "serie" ? catalogo.titulos.filter((t) => t.temporadas === 1) : [],
  };
}

export const obtenerHubDeTipo = cache((tipo: TipoDeObra) =>
  construirHubDeTipo(repositorio(), tipo),
);

// ── Auxiliares ─────────────────────────────────────────────────────────────

function publicable(ranking: PosicionMejorValorada[]): PosicionMejorValorada[] {
  return ranking.length >= MINIMO_PARA_PUBLICAR_RANKING ? ranking : [];
}

function idsEnListas(listas: ListaEditorial[]): Set<string> {
  return new Set(listas.flatMap((l) => l.entradas.map((e) => e.tituloId)));
}

/**
 * Cada título con su entrada en la lista revisada más recientemente (el mismo
 * criterio que el veredicto de la ficha), en orden de lista y de entrada.
 */
function entradasPorTitulo(
  listas: ListaEditorial[],
): Map<string, { entrada: EntradaEditorial; lista: ListaEditorial }> {
  const mapa = new Map<string, { entrada: EntradaEditorial; lista: ListaEditorial }>();
  for (const lista of listas)
    for (const entrada of [...lista.entradas].sort((a, b) => a.orden - b.orden))
      if (!mapa.has(entrada.tituloId)) mapa.set(entrada.tituloId, { entrada, lista });
  return mapa;
}

async function mapaDeTitulos(
  repo: RepositorioDeCatalogo,
  listas: ListaEditorial[],
): Promise<Map<string, TituloResumen>> {
  const ids = [...new Set(listas.flatMap((l) => l.entradas.map((e) => e.tituloId)))];
  return new Map((await repo.titulos(ids)).map((t) => [t.id, t]));
}
