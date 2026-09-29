/**
 * **Adaptador de Neon del puerto de catálogo** (`RepositorioDeCatalogo`).
 *
 *     consultas de aplicación → RepositorioDeCatalogo → este adaptador
 *                                  → catalogo-sql.ts (SQL) → LectorSql → Neon
 *                                  ← mapeo.ts (filas → modelo)
 *
 * Solo lectura, sin red externa, sin estado por petición. Cada operación del
 * puerto es **una consulta, o unas pocas en paralelo**; las tarjetas de muchos
 * títulos salen de **una** consulta por lista de ids (nunca una por tarjeta).
 *
 * **Fuente de verdad por dominio** (`docs/NEON-ADAPTER.md` §2):
 *
 * - Catálogo, disponibilidad, histórico, anuncios, capacidades: **Neon**.
 * - Contenido editorial (listas, veredictos, autores): **no existe todavía**
 *   (`editorial_*` es Fase 3). Este adaptador devuelve **ninguna lista**: no
 *   mezcla las listas ficticias de desarrollo, que nombran títulos que en Neon
 *   no existen, con el catálogo real.
 * - Imágenes publicables: **ninguna** (ADR 0008, `imagenesPublicables`).
 */
import type { SQL } from "drizzle-orm";
import type {
  Capacidad,
  EstadoDeCapacidad,
  FichaDeTitulo,
  IdPlataforma,
  Instante,
  MatrizDeCapacidades,
  Movimiento,
  Plataforma,
  PosicionMejorValorada,
  RecuentoDeGenero,
  ResultadoDeBusqueda,
  TipoDeMovimiento,
  TipoDeObra,
  TituloResumen,
} from "@/features/catalogo/modelo.ts";
import { normalizar, palabras } from "@/features/catalogo/busqueda.ts";
import type { RepositorioDeCatalogo } from "@/features/catalogo/repositorio.ts";
import { ordenDePlataforma } from "@/features/catalogo/plataformas.ts";
import { compararTitulos } from "@/features/catalogo/reglas.ts";
import { imdbDeSlug, slugDeTitulo } from "@/lib/slug.ts";
import * as q from "./catalogo-sql.ts";
import { ErrorDeCatalogo } from "./errores.ts";
import type { LectorSql } from "./lector.ts";
import {
  type FilaDeAnuncio,
  type FilaDeFicha,
  type FilaDeMovimiento,
  type FilaDeOferta,
  type FilaDePlataforma,
  type FilaDeTitulo,
  FUENTE_DE_VALORACION,
  entero,
  ficha as mapearFicha,
  instante,
  movimiento,
  plataforma,
  tipoDeObra,
  tituloResumen,
} from "./mapeo.ts";

const CAPACIDADES = new Set<Capacidad>([
  "expiring",
  "upcoming",
  "official_top",
  "prices",
  "popularity_order",
]);
const ESTADOS = new Set<EstadoDeCapacidad>([
  "supported_with_data",
  "supported_no_data_in_sample",
  "not_supported",
  "unknown",
]);

const EVENTO_DEL_MOVIMIENTO = {
  llega: "added",
  "se-fue": "removed",
  cambio: "changed",
} as const;

const MOVIMIENTO_DEL_EVENTO: Record<string, TipoDeMovimiento> = {
  added: "llega",
  removed: "se-fue",
  changed: "cambio",
};

/** Un `limite` negativo o no entero es un error de quien llama, no una consulta vacía. */
function limiteValido(operacion: string, limite: number): number {
  if (!Number.isInteger(limite) || limite < 0) {
    throw new ErrorDeCatalogo("forma", operacion, "límite inválido");
  }
  return limite;
}

export function crearRepositorioNeon(lector: LectorSql): RepositorioDeCatalogo {
  const leer = <T>(operacion: string, consulta: SQL) =>
    lector.leer<T>(operacion, consulta);

  /** Tarjetas de una lista de `imdb_id`, **en el orden pedido**, una sola consulta. */
  async function titulos(ids: readonly string[]): Promise<TituloResumen[]> {
    const unicos = [...new Set(ids)];
    if (unicos.length === 0) return [];
    const filas = await leer<FilaDeTitulo>("titulos", q.tarjetas(unicos));
    const porId = new Map(filas.map((f) => [f.imdb_id, tituloResumen(f)]));
    return unicos.flatMap((id) => porId.get(id) ?? []);
  }

  async function ultimaComprobacion(): Promise<Instante> {
    const [fila] = await leer<{ comprobado: Date | string | null }>(
      "ultimaComprobacion",
      q.ultimaComprobacion(),
    );
    if (!fila?.comprobado) {
      // Regla 7: sin ninguna observación no hay «Comprobado el…» que decir.
      throw new ErrorDeCatalogo(
        "sin_datos",
        "ultimaComprobacion",
        "no hay ninguna oferta observada en el país",
      );
    }
    return instante(fila.comprobado, "ultimaComprobacion");
  }

  async function movimientosDeTipo(
    tipo: TipoDeMovimiento,
    limite: number,
    v: q.VentanaSql,
  ): Promise<Movimiento[]> {
    if (limite === 0) return [];
    const consulta =
      tipo === "se-va"
        ? q.movimientosSeVa(limite, v)
        : tipo === "proximamente"
          ? q.movimientosProximamente(limite, v)
          : q.movimientosDelHistorico(EVENTO_DEL_MOVIMIENTO[tipo], limite, v);
    const filas = await leer<FilaDeMovimiento>(`movimientos:${tipo}`, consulta);
    return filas.map((f) => movimiento(tipo, f, `movimientos:${tipo}`));
  }

  return {
    async plataformas(): Promise<Plataforma[]> {
      const filas = await leer<FilaDePlataforma>("plataformas", q.plataformas());
      // El orden de presentación de la web, no el de la base.
      return filas
        .map((f) => plataforma(f, "plataformas"))
        .sort((a, b) => ordenDePlataforma(a.id) - ordenDePlataforma(b.id));
    },

    async capacidades(): Promise<MatrizDeCapacidades> {
      const filas = await leer<{
        platform_id: string;
        capability: string;
        status: string;
      }>("capacidades", q.capacidades());
      // Lo que no está en la tabla queda ausente: la interfaz lo lee como `unknown`.
      const matriz: MatrizDeCapacidades = {};
      for (const f of filas) {
        if (!CAPACIDADES.has(f.capability as Capacidad)) continue;
        if (!ESTADOS.has(f.status as EstadoDeCapacidad)) continue;
        (matriz[f.platform_id] ??= {})[f.capability as Capacidad] =
          f.status as EstadoDeCapacidad;
      }
      return matriz;
    },

    ultimaComprobacion,

    async inicioDelRegistro(): Promise<Instante> {
      const [fila] = await leer<{
        ancla: string | null;
        primer_evento: Date | string | null;
      }>("inicioDelRegistro", q.inicioDelRegistro());
      // El ancla del seed (ADR 0009) manda. Sin ella —la rama histórica nunca
      // tuvo seed—, el primer evento registrado. Sin ninguno de los dos, nada
      // se ha registrado antes de la última comprobación.
      if (fila?.ancla) return instante(fila.ancla, "inicioDelRegistro");
      if (fila?.primer_evento) return instante(fila.primer_evento, "inicioDelRegistro");
      return ultimaComprobacion();
    },

    async ficha(tipo: TipoDeObra, slug: string): Promise<FichaDeTitulo | null> {
      const imdbId = imdbDeSlug(slug);
      if (imdbId === null) return null;
      const [base, ofertas, anuncios, historico] = await Promise.all([
        leer<FilaDeFicha>("ficha", q.fichaBase(tipo, imdbId)),
        leer<FilaDeOferta>("ficha:ofertas", q.ofertasDeFicha(tipo, imdbId)),
        leer<FilaDeAnuncio>("ficha:anuncios", q.anunciosDeFicha(tipo, imdbId)),
        leer<FilaDeMovimiento & { event_type: string }>(
          "ficha:historico",
          q.historicoDeTitulo(tipo, imdbId),
        ),
      ]);
      const [fila] = base;
      if (!fila) return null;

      const pasados = historico.flatMap((f) => {
        const t = MOVIMIENTO_DEL_EVENTO[f.event_type];
        return t ? [movimiento(t, f, "ficha:historico")] : [];
      });
      // «Se va», uno por plataforma (la salida más próxima), como en el radar:
      // alquiler y compra que caducan juntos son una sola salida.
      const salidas = new Map<string, Movimiento>();
      for (const o of ofertas) {
        if (o.salida === null) continue;
        const fecha = instante(o.salida, "ficha");
        const previa = salidas.get(o.platform_id);
        if (!previa || fecha < previa.fecha) {
          salidas.set(o.platform_id, {
            tipo: "se-va",
            tituloId: imdbId,
            plataforma: plataforma(o),
            fecha,
          });
        }
      }
      const futuros: Movimiento[] = [
        ...salidas.values(),
        ...anuncios.map((n) => ({
          tipo: "proximamente" as const,
          tituloId: imdbId,
          plataforma: plataforma(n),
          fecha: instante(n.announced_for, "ficha"),
        })),
      ];
      return mapearFicha(fila, {
        ofertas,
        anuncios,
        movimientos: [...pasados, ...futuros].sort((a, b) =>
          b.fecha.localeCompare(a.fecha),
        ),
        // Su última observación; si no tiene ninguna oferta observada (solo
        // anunciado), la del catálogo, que también es real. Nunca `new Date()`.
        comprobadoEn:
          fila.comprobado_en === null
            ? await ultimaComprobacion()
            : instante(fila.comprobado_en, "ficha"),
      });
    },

    titulos,

    async slugs(tipo: TipoDeObra): Promise<string[]> {
      const filas = await leer<{ imdb_id: string; title: string }>(
        "slugs",
        q.slugs(tipo),
      );
      return filas.flatMap((f) => slugDeTitulo(f.title, f.imdb_id) ?? []);
    },

    async delMismoDirector(tituloId: string, limite: number): Promise<TituloResumen[]> {
      if (limiteValido("delMismoDirector", limite) === 0) return [];
      const filas = await leer<{ imdb_id: string }>(
        "delMismoDirector",
        q.delMismoDirector(tituloId, limite),
      );
      return ordenados(await titulos(filas.map((f) => f.imdb_id)));
    },

    async buscar(consulta: string, limite: number) {
      const ps = palabras(consulta).slice(0, q.MAXIMO_DE_PALABRAS);
      if (ps.length === 0 || limiteValido("buscar", limite) === 0) {
        return { resultados: [], total: 0 };
      }
      const filas = await leer<{
        imdb_id: string;
        title: string;
        original_title: string | null;
        en_titulo: boolean;
        puntos: number | string;
        total: number | string;
      }>("buscar", q.buscar(normalizar(consulta), ps, limite));
      const tarjetas = new Map(
        (await titulos(filas.map((f) => f.imdb_id))).map((t) => [t.id, t]),
      );
      const resultados = filas
        .flatMap((f) => {
          const titulo = tarjetas.get(f.imdb_id);
          if (!titulo) return [];
          const r: ResultadoDeBusqueda & { puntos: number } = {
            titulo,
            puntos: entero(f.puntos, "buscar"),
            ...(!f.en_titulo && f.original_title
              ? { tituloOriginal: f.original_title }
              : {}),
          };
          return [r];
        })
        // El SQL ya ordena; esto iguala el desempate al de `compararTitulos`.
        .sort((a, b) => a.puntos - b.puntos || compararTitulos(a.titulo, b.titulo))
        .map(({ puntos: _, ...r }) => r);
      return { resultados, total: filas[0] ? entero(filas[0].total, "buscar") : 0 };
    },

    async explorar(filtro, limite) {
      const f = sinIndefinidos(filtro);
      if (limiteValido("explorar", limite) === 0) {
        const [fila] = await leer<{ total: number | string }>(
          "explorar",
          q.contarDisponibles(f),
        );
        return { titulos: [], total: fila ? entero(fila.total, "explorar") : 0 };
      }
      const filas = await leer<{ imdb_id: string; total: number | string }>(
        "explorar",
        q.explorar(f, limite),
      );
      return {
        titulos: ordenados(await titulos(filas.map((x) => x.imdb_id))),
        total: filas[0] ? entero(filas[0].total, "explorar") : 0,
      };
    },

    async generos(filtro): Promise<RecuentoDeGenero[]> {
      const filas = await leer<{ name: string; recuento: number | string }>(
        "generos",
        q.generos(sinIndefinidos(filtro)),
      );
      return filas
        .map((f) => ({ nombre: f.name, recuento: entero(f.recuento, "generos") }))
        .sort(
          (a, b) =>
            b.recuento - a.recuento ||
            compararTitulos(
              { titulo: a.nombre, id: a.nombre },
              { titulo: b.nombre, id: b.nombre },
            ),
        );
    },

    async recuentoPorPlataforma() {
      const [activas, filas] = await Promise.all([
        leer<FilaDePlataforma>("recuentoPorPlataforma", q.plataformas()),
        leer<{ platform_id: string; type: string; recuento: number | string }>(
          "recuentoPorPlataforma",
          q.recuentoPorPlataforma(),
        ),
      ]);
      const recuento: Record<IdPlataforma, Record<TipoDeObra, number>> = {};
      for (const p of activas) recuento[p.platform_id] = { pelicula: 0, serie: 0 };
      for (const f of filas) {
        const fila = recuento[f.platform_id];
        if (fila)
          fila[tipoDeObra(f.type, "recuentoPorPlataforma")] = entero(f.recuento);
      }
      return recuento;
    },

    // ── Editorial: no vive en Neon todavía (ver la cabecera) ──────────────
    listas: () => Promise.resolve([]),
    listaDestacada: () => Promise.resolve(null),
    lista: () => Promise.resolve(null),

    async movimientos(tipo, limite, filtro = {}) {
      return movimientosDeTipo(
        tipo,
        limiteValido("movimientos", limite),
        sinIndefinidos(filtro),
      );
    },

    async mejorValoradas(tipo, limite, filtro = {}): Promise<PosicionMejorValorada[]> {
      if (limiteValido("mejorValoradas", limite) === 0) return [];
      const candidatas = await leer<{
        imdb_id: string;
        title: string;
        rating: number | string;
      }>("mejorValoradas", q.candidatasMejorValoradas(tipo, limite, filtro.plataforma));
      // Desempate neutral de docs/RANKINGS.md: el mismo `compararTitulos` que el
      // adaptador de desarrollo, sobre los empates que el SQL deja pasar.
      const elegidas = candidatas
        .map((c) => ({
          id: c.imdb_id,
          titulo: c.title,
          valor: entero(c.rating, "mejorValoradas"),
        }))
        .sort((a, b) => b.valor - a.valor || compararTitulos(a, b))
        .slice(0, limite);
      const tarjetas = new Map(
        (await titulos(elegidas.map((e) => e.id))).map((t) => [t.id, t]),
      );
      return elegidas
        .flatMap((e) => {
          const titulo = tarjetas.get(e.id);
          return titulo
            ? [{ titulo, valoracion: { valor: e.valor, fuente: FUENTE_DE_VALORACION } }]
            : [];
        })
        .map((p, i) => ({ posicion: i + 1, ...p }));
    },
  };
}

/** El SQL ya ordena por colación es-ES; esto iguala el desempate a `compararTitulos`. */
function ordenados(titulos: TituloResumen[]): TituloResumen[] {
  return [...titulos].sort(compararTitulos);
}

/** `exactOptionalPropertyTypes`: un filtro con `undefined` explícito no es un filtro. */
function sinIndefinidos<T extends object>(
  filtro: T,
): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(
    Object.entries(filtro).filter(([, v]) => v !== undefined),
  ) as { [K in keyof T]: Exclude<T[K], undefined> };
}
