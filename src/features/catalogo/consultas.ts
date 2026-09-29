import { cache } from "react";
import type {
  EntradaEditorial,
  FichaDeTitulo,
  IdPlataforma,
  ImagenPublicable,
  Instante,
  ListaEditorial,
  Movimiento,
  Plataforma,
  PosicionMejorValorada,
  TipoDeObra,
  TituloResumen,
} from "./modelo.ts";
import { repositorio } from "./proveedor.ts";
import { priorizarLoEditorial } from "./reglas.ts";
import type { RepositorioDeCatalogo } from "./repositorio.ts";

/**
 * Consultas de aplicación: lo que cada pantalla necesita, montado a partir del
 * repositorio. Las pantallas llaman a `obtenerPortada()` u `obtenerFicha()` y
 * nada más.
 *
 * Cada consulta hace sus lecturas **en paralelo** y, como mucho, una segunda
 * ronda para lo que depende de la primera (los títulos que nombra una lista).
 * `cache()` de React deduplica dentro de una misma petición: `generateMetadata`
 * y la página comparten la lectura.
 */

// ── Tipos de vista ─────────────────────────────────────────────────────────

export interface TarjetaDeLista {
  id: string;
  slug: string;
  titulo: string;
  entradilla: string;
  autor: ListaEditorial["autor"];
  revisada: Instante;
  numeroDeTitulos: number;
  disponiblesHoy: number;
  /** Hasta tres títulos para la portada de la tarjeta. */
  portada: TituloResumen[];
  /** Plataformas de cada título: el cliente cuenta cuántos están en las tuyas. */
  plataformasPorTitulo: IdPlataforma[][];
  imagen?: ImagenPublicable;
}

export interface FilaDeRadar {
  movimiento: Movimiento;
  titulo: TituloResumen;
  enListas: boolean;
}

export interface Portada {
  comprobadoEn: Instante;
  plataformas: Plataforma[];
  destacada: {
    lista: TarjetaDeLista;
    entradas: { entrada: EntradaEditorial; titulo: TituloResumen }[];
  } | null;
  selecciones: TarjetaDeLista[];
  totalDeListas: number;
  radar: {
    llega: FilaDeRadar[];
    seVa: FilaDeRadar[];
    proximamente: FilaDeRadar[];
    /** Movimientos pasados de menos protagonismo: solo los recientes. */
    seFue: FilaDeRadar[];
    cambios: FilaDeRadar[];
  };
  mejorValoradas: {
    peliculas: PosicionMejorValorada[];
    series: PosicionMejorValorada[];
  };
  /** Cuántos títulos llegaron a cada plataforma en los últimos 7 días. */
  llegadasDeLaSemana: Record<IdPlataforma, number>;
  /** Plataformas cuyas salidas y llegadas con fecha podemos publicar (§1.4 en ✅). */
  cobertura: { salidas: Plataforma[]; llegadasAnunciadas: Plataforma[] };
}

export interface Veredicto {
  entrada: EntradaEditorial;
  lista: TarjetaDeLista;
  /** Otras listas donde aparece, además de la del veredicto. */
  tambienEn: TarjetaDeLista[];
}

export interface VistaDeFicha {
  ficha: FichaDeTitulo;
  veredicto: Veredicto | null;
  listas: TarjetaDeLista[];
  relacionados: { mismoDirector: TituloResumen[]; mismasListas: TituloResumen[] };
  inicioDelRegistro: Instante;
}

const POR_COLUMNA_DE_RADAR = 5;
/** «Se fue» y «Cambios» tienen menos protagonismo que llegadas y salidas. */
const POR_TIPO_SECUNDARIO_DE_RADAR = 3;
const EN_MEJOR_VALORADAS = 5;
const SELECCIONES = 4;
const RELACIONADOS = 4;
export const DIA_MS = 24 * 60 * 60 * 1000;
const SEMANA_MS = 7 * DIA_MS;
/** «Acaba de llegar» es reciente de verdad: lo de hace meses no es noticia. */
export const VENTANA_DE_LLEGADAS_MS = 14 * DIA_MS;

// ── Portada ────────────────────────────────────────────────────────────────

export async function construirPortada(repo: RepositorioDeCatalogo): Promise<Portada> {
  const [
    comprobadoEn,
    plataformas,
    capacidades,
    destacada,
    listas,
    llega,
    seVa,
    proximamente,
    seFue,
    cambios,
    peliculas,
    series,
  ] = await Promise.all([
    repo.ultimaComprobacion(),
    repo.plataformas(),
    repo.capacidades(),
    repo.listaDestacada(),
    repo.listas(),
    repo.movimientos("llega", 50),
    repo.movimientos("se-va", 50),
    repo.movimientos("proximamente", 50),
    repo.movimientos("se-fue", 50),
    repo.movimientos("cambio", 50),
    repo.mejorValoradas("pelicula", EN_MEJOR_VALORADAS),
    repo.mejorValoradas("serie", EN_MEJOR_VALORADAS),
  ]);

  const enListas = new Set(listas.flatMap((l) => l.entradas.map((e) => e.tituloId)));
  const referencia = new Date(comprobadoEn).getTime();
  const reciente = (m: Movimiento) =>
    referencia - new Date(m.fecha).getTime() <= VENTANA_DE_LLEGADAS_MS;
  const recientes = llega.filter(reciente);
  const radar = {
    llega: priorizarLoEditorial(recientes, enListas, POR_COLUMNA_DE_RADAR),
    seVa: priorizarLoEditorial(seVa, enListas, POR_COLUMNA_DE_RADAR),
    proximamente: priorizarLoEditorial(proximamente, enListas, POR_COLUMNA_DE_RADAR),
    seFue: priorizarLoEditorial(
      seFue.filter(reciente),
      enListas,
      POR_TIPO_SECUNDARIO_DE_RADAR,
    ),
    cambios: priorizarLoEditorial(
      cambios.filter(reciente),
      enListas,
      POR_TIPO_SECUNDARIO_DE_RADAR,
    ),
  };
  const otras = listas.filter((l) => l.id !== destacada?.id).slice(0, SELECCIONES);

  // Segunda ronda: los títulos que nombran las listas y el radar, de una vez.
  const ids = new Set<string>([
    ...listas.flatMap((l) => l.entradas.map((e) => e.tituloId)),
    ...Object.values(radar).flatMap((ms) => ms.map((m) => m.tituloId)),
  ]);
  const titulos = new Map((await repo.titulos([...ids])).map((t) => [t.id, t]));

  const filas = (movimientos: Movimiento[]): FilaDeRadar[] =>
    movimientos.flatMap((movimiento) => {
      const titulo = titulos.get(movimiento.tituloId);
      return titulo
        ? [{ movimiento, titulo, enListas: enListas.has(movimiento.tituloId) }]
        : [];
    });

  const desde = referencia - SEMANA_MS;
  const llegadasDeLaSemana: Record<IdPlataforma, number> = {};
  for (const m of llega) {
    if (new Date(m.fecha).getTime() >= desde) {
      llegadasDeLaSemana[m.plataforma.id] =
        (llegadasDeLaSemana[m.plataforma.id] ?? 0) + 1;
    }
  }

  return {
    comprobadoEn,
    plataformas,
    destacada: destacada
      ? {
          lista: tarjetaDeLista(destacada, titulos),
          entradas: destacada.entradas.slice(0, 3).flatMap((entrada) => {
            const titulo = titulos.get(entrada.tituloId);
            return titulo ? [{ entrada, titulo }] : [];
          }),
        }
      : null,
    selecciones: otras.map((l) => tarjetaDeLista(l, titulos)),
    totalDeListas: listas.length,
    radar: {
      llega: filas(radar.llega),
      seVa: filas(radar.seVa),
      proximamente: filas(radar.proximamente),
      seFue: filas(radar.seFue),
      cambios: filas(radar.cambios),
    },
    mejorValoradas: { peliculas, series },
    llegadasDeLaSemana,
    cobertura: {
      salidas: plataformas.filter(
        (p) => capacidades[p.id]?.expiring === "supported_with_data",
      ),
      llegadasAnunciadas: plataformas.filter(
        (p) => capacidades[p.id]?.upcoming === "supported_with_data",
      ),
    },
  };
}

export const obtenerPortada = cache(() => construirPortada(repositorio()));

// ── Ficha ──────────────────────────────────────────────────────────────────

export async function construirFicha(
  repo: RepositorioDeCatalogo,
  tipo: TipoDeObra,
  slug: string,
): Promise<VistaDeFicha | null> {
  const ficha = await repo.ficha(tipo, slug);
  if (!ficha) return null;

  const [listas, mismoDirector, inicioDelRegistro] = await Promise.all([
    repo.listas(),
    repo.delMismoDirector(ficha.id, RELACIONADOS),
    repo.inicioDelRegistro(),
  ]);

  // `listas()` llega de la revisada más reciente a la más antigua: la primera
  // que contiene el título es la del veredicto que se muestra.
  const suyas = listas.filter((l) => l.entradas.some((e) => e.tituloId === ficha.id));
  const companeros = new Set(
    suyas
      .flatMap((l) => l.entradas.map((e) => e.tituloId))
      .filter((id) => id !== ficha.id),
  );
  for (const t of mismoDirector) companeros.delete(t.id);

  const ids = new Set([
    ...suyas.flatMap((l) => l.entradas.map((e) => e.tituloId)),
    ...companeros,
  ]);
  const titulos = new Map((await repo.titulos([...ids])).map((t) => [t.id, t]));
  const tarjetas = suyas.map((l) => tarjetaDeLista(l, titulos));

  const primera = suyas[0];
  const entrada = primera?.entradas.find((e) => e.tituloId === ficha.id);

  return {
    ficha,
    veredicto:
      primera && entrada && tarjetas[0]
        ? { entrada, lista: tarjetas[0], tambienEn: tarjetas.slice(1) }
        : null,
    listas: tarjetas,
    relacionados: {
      mismoDirector,
      mismasListas: [...companeros]
        .flatMap((id) => titulos.get(id) ?? [])
        .slice(0, RELACIONADOS),
    },
    inicioDelRegistro,
  };
}

export const obtenerFicha = cache((tipo: TipoDeObra, slug: string) =>
  construirFicha(repositorio(), tipo, slug),
);

export const obtenerSlugs = cache((tipo: TipoDeObra) => repositorio().slugs(tipo));

/** Lo que necesita el marco común de todas las páginas (cabecera y pie). */
export const obtenerMarco = cache(async () => {
  const repo = repositorio();
  const [plataformas, comprobadoEn] = await Promise.all([
    repo.plataformas(),
    repo.ultimaComprobacion(),
  ]);
  return { plataformas, comprobadoEn };
});

// ── Auxiliares ─────────────────────────────────────────────────────────────

export function tarjetaDeLista(
  lista: ListaEditorial,
  titulos: ReadonlyMap<string, TituloResumen>,
): TarjetaDeLista {
  const suyos = [...lista.entradas]
    .sort((a, b) => a.orden - b.orden)
    .flatMap((e) => titulos.get(e.tituloId) ?? []);
  return {
    id: lista.id,
    slug: lista.slug,
    titulo: lista.titulo,
    entradilla: lista.entradilla,
    autor: lista.autor,
    revisada: lista.revisada,
    numeroDeTitulos: lista.entradas.length,
    disponiblesHoy: suyos.filter((t) => t.disponibilidad.length > 0).length,
    portada: suyos.slice(0, 3),
    plataformasPorTitulo: suyos.map((t) => [
      ...new Set(t.disponibilidad.map((o) => o.plataforma.id)),
    ]),
    ...(lista.imagen ? { imagen: lista.imagen } : {}),
  };
}
