import type {
  Capacidad,
  FichaDeTitulo,
  FiltroDeCatalogo,
  FiltroDeMovimientos,
  IdPlataforma,
  MatrizDeCapacidades,
  Movimiento,
  PosicionMejorValorada,
  RecuentoDeGenero,
  ResultadoDeBusqueda,
  TipoDeMovimiento,
  TipoDeObra,
  TituloResumen,
} from "../modelo.ts";
import { puntuar } from "../busqueda.ts";
import type { RepositorioDeCatalogo } from "../repositorio.ts";
import { compararTitulos } from "../reglas.ts";
import {
  CAPACIDADES,
  FICHAS,
  INICIO_DEL_REGISTRO,
  LISTA_DESTACADA_ID,
  LISTAS,
  MOVIMIENTOS,
  PLATAFORMAS,
  ULTIMA_COMPROBACION,
} from "./datos.ts";

/**
 * Adaptador de desarrollo del puerto de catálogo: datos ficticios en memoria
 * (`datos.ts`), cero red y cero base de datos.
 *
 * Aplica las mismas reglas de contrato que aplicará el de Neon (capacidades,
 * orden, desempate del Ranking A), para que las pantallas se diseñen contra el
 * comportamiento real y no contra un atajo.
 */
export function crearRepositorioDeDesarrollo(
  datos = {
    fichas: FICHAS,
    listas: LISTAS,
    movimientos: MOVIMIENTOS,
    capacidades: CAPACIDADES,
  },
): RepositorioDeCatalogo {
  const fichas: FichaDeTitulo[] = datos.fichas.map((ficha) => {
    const movimientos = datos.movimientos
      .filter((m) => m.tituloId === ficha.id && permitido(datos.capacidades, m))
      .sort((a, b) => b.fecha.localeCompare(a.fecha));
    const ultimaSalida = movimientos.find((m) => m.tipo === "se-fue");
    return {
      ...ficha,
      disponibilidad: ficha.ofertas.map((oferta) => ({
        plataforma: oferta.plataforma,
        tipo: oferta.tipo,
        ...(oferta.precioDesde ? { precioDesde: oferta.precioDesde } : {}),
      })),
      ...(ficha.ofertas.length === 0 && ultimaSalida
        ? { fueraDesde: ultimaSalida.fecha }
        : {}),
      movimientos,
      comprobadoEn: ULTIMA_COMPROBACION,
    };
  });
  const porId = new Map(fichas.map((f) => [f.id, f]));

  const resumen = (f: FichaDeTitulo): TituloResumen => ({
    id: f.id,
    slug: f.slug,
    tipo: f.tipo,
    titulo: f.titulo,
    anio: f.anio,
    ...(f.anioFin === undefined ? {} : { anioFin: f.anioFin }),
    generos: f.generos,
    ...(f.temporadas === undefined ? {} : { temporadas: f.temporadas }),
    imagenes: f.imagenes,
    disponibilidad: f.disponibilidad,
    ...(f.fueraDesde === undefined ? {} : { fueraDesde: f.fueraDesde }),
  });

  const enPlataforma = (f: FichaDeTitulo, plataforma: IdPlataforma | undefined) =>
    plataforma === undefined || f.ofertas.some((o) => o.plataforma.id === plataforma);

  /** Disponibles hoy y dentro del filtro. */
  const disponibles = (filtro: FiltroDeCatalogo) =>
    fichas.filter(
      (f) =>
        f.ofertas.length > 0 &&
        (filtro.tipo === undefined || f.tipo === filtro.tipo) &&
        enPlataforma(f, filtro.plataforma) &&
        (filtro.genero === undefined || f.generos.includes(filtro.genero)),
    );

  return {
    plataformas: () => Promise.resolve(PLATAFORMAS),
    capacidades: () => Promise.resolve(datos.capacidades),
    ultimaComprobacion: () => Promise.resolve(ULTIMA_COMPROBACION),
    inicioDelRegistro: () => Promise.resolve(INICIO_DEL_REGISTRO),

    ficha: (tipo, slug) =>
      Promise.resolve(fichas.find((f) => f.tipo === tipo && f.slug === slug) ?? null),

    titulos: (ids) =>
      Promise.resolve(
        ids.flatMap((id) => {
          const ficha = porId.get(id);
          return ficha ? [resumen(ficha)] : [];
        }),
      ),

    slugs: (tipo) =>
      Promise.resolve(fichas.filter((f) => f.tipo === tipo).map((f) => f.slug)),

    delMismoDirector: (tituloId, limite) => {
      const propia = porId.get(tituloId);
      if (!propia || propia.direccion.length === 0) return Promise.resolve([]);
      const personas = new Set(propia.direccion);
      return Promise.resolve(
        fichas
          .filter((f) => f.id !== tituloId && f.direccion.some((p) => personas.has(p)))
          .sort(compararTitulos)
          .slice(0, limite)
          .map(resumen),
      );
    },

    buscar: (consulta, limite) => {
      const encontrados: (ResultadoDeBusqueda & { puntos: number })[] = [];
      for (const f of fichas) {
        const enTitulo = puntuar(f.titulo, consulta);
        const enOriginal = f.tituloOriginal
          ? puntuar(f.tituloOriginal, consulta)
          : null;
        if (enTitulo !== null) {
          encontrados.push({ titulo: resumen(f), puntos: enTitulo });
        } else if (enOriginal !== null && f.tituloOriginal) {
          encontrados.push({
            titulo: resumen(f),
            tituloOriginal: f.tituloOriginal,
            puntos: enOriginal,
          });
        }
      }
      encontrados.sort(
        (a, b) => a.puntos - b.puntos || compararTitulos(a.titulo, b.titulo),
      );
      return Promise.resolve({
        resultados: encontrados.slice(0, limite).map(({ puntos: _, ...r }) => r),
        total: encontrados.length,
      });
    },

    explorar: (filtro, limite) => {
      const todos = disponibles(filtro).sort(compararTitulos);
      return Promise.resolve({
        titulos: todos.slice(0, limite).map(resumen),
        total: todos.length,
      });
    },

    generos: (filtro) => {
      const recuento = new Map<string, number>();
      for (const f of disponibles(filtro))
        for (const g of f.generos) recuento.set(g, (recuento.get(g) ?? 0) + 1);
      return Promise.resolve(
        [...recuento.entries()]
          .map(([nombre, n]): RecuentoDeGenero => ({ nombre, recuento: n }))
          .sort(
            (a, b) =>
              b.recuento - a.recuento ||
              compararTitulos(
                { titulo: a.nombre, id: a.nombre },
                { titulo: b.nombre, id: b.nombre },
              ),
          ),
      );
    },

    recuentoPorPlataforma: () => {
      const recuento: Record<IdPlataforma, Record<TipoDeObra, number>> = {};
      for (const p of PLATAFORMAS) recuento[p.id] = { pelicula: 0, serie: 0 };
      for (const f of fichas) {
        for (const id of new Set(f.ofertas.map((o) => o.plataforma.id))) {
          const fila = recuento[id];
          if (fila) fila[f.tipo] += 1;
        }
      }
      return Promise.resolve(recuento);
    },

    listas: () =>
      Promise.resolve(
        [...datos.listas].sort((a, b) => b.revisada.localeCompare(a.revisada)),
      ),

    listaDestacada: () =>
      Promise.resolve(datos.listas.find((l) => l.id === LISTA_DESTACADA_ID) ?? null),

    lista: (slug) => Promise.resolve(datos.listas.find((l) => l.slug === slug) ?? null),

    movimientos: (tipo, limite, filtro = {}) => {
      const futuros = tipo === "se-va" || tipo === "proximamente";
      return Promise.resolve(
        datos.movimientos
          .filter(
            (m) =>
              m.tipo === tipo &&
              permitido(datos.capacidades, m) &&
              cumple(m, filtro, (id) => porId.get(id)?.tipo),
          )
          .sort((a, b) =>
            futuros ? a.fecha.localeCompare(b.fecha) : b.fecha.localeCompare(a.fecha),
          )
          .slice(0, limite),
      );
    },

    mejorValoradas: (tipo, limite, filtro = {}) => {
      // Ranking A (docs/RANKINGS.md): con valoración, disponible ahora y con
      // ficha mínima; por valoración descendente y desempate neutral.
      const candidatas = fichas.filter(
        (
          f,
        ): f is FichaDeTitulo & {
          valoracion: NonNullable<FichaDeTitulo["valoracion"]>;
        } =>
          f.tipo === tipo &&
          f.valoracion !== undefined &&
          f.ofertas.length > 0 &&
          enPlataforma(f, filtro.plataforma),
      );
      const ordenadas = [...candidatas].sort(
        (a, b) => b.valoracion.valor - a.valoracion.valor || compararTitulos(a, b),
      );
      return Promise.resolve(
        ordenadas.slice(0, limite).map((f, i): PosicionMejorValorada => ({
          posicion: i + 1,
          titulo: resumen(f),
          valoracion: f.valoracion,
        })),
      );
    },
  };
}

function cumple(
  m: Movimiento,
  filtro: FiltroDeMovimientos,
  tipoDe: (tituloId: string) => TipoDeObra | undefined,
): boolean {
  if (filtro.plataforma !== undefined && m.plataforma.id !== filtro.plataforma)
    return false;
  if (filtro.obra !== undefined && tipoDe(m.tituloId) !== filtro.obra) return false;
  const t = Date.parse(m.fecha);
  if (filtro.desde !== undefined && t < Date.parse(filtro.desde)) return false;
  if (filtro.hasta !== undefined && t > Date.parse(filtro.hasta)) return false;
  return true;
}

const CAPACIDAD_DEL_MOVIMIENTO: Partial<Record<TipoDeMovimiento, Capacidad>> = {
  "se-va": "expiring",
  proximamente: "upcoming",
};

/** Solo se muestra lo que la matriz tiene en ✅ (docs/DATA-SOURCES.md §1.4). */
function permitido(capacidades: MatrizDeCapacidades, movimiento: Movimiento): boolean {
  const capacidad = CAPACIDAD_DEL_MOVIMIENTO[movimiento.tipo];
  if (!capacidad) return true;
  return (
    estado(capacidades, movimiento.plataforma.id, capacidad) === "supported_with_data"
  );
}

function estado(
  capacidades: MatrizDeCapacidades,
  plataforma: IdPlataforma,
  capacidad: Capacidad,
) {
  return capacidades[plataforma]?.[capacidad] ?? "unknown";
}
