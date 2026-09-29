import { cache } from "react";
import { DIA_MS, type FilaDeRadar } from "./consultas.ts";
import type {
  EstadoDeCapacidad,
  IdPlataforma,
  Instante,
  Movimiento,
  Plataforma,
  TipoDeMovimiento,
} from "./modelo.ts";
import { repositorio } from "./proveedor.ts";
import type { RepositorioDeCatalogo } from "./repositorio.ts";

/**
 * Radar del catálogo (`/radar`, SCREENS.md §4): todos los movimientos de una
 * ventana alrededor de hoy, ya con su título. La página es **estática**: los
 * filtros los aplica el navegador sobre este mismo conjunto, así que cambiar de
 * filtro no invoca el Worker ni la base (ADR 0002).
 *
 * La ventana es corta a propósito —14 días hacia atrás, el horizonte de 31 días
 * de `/changes` hacia delante— y nunca empieza antes de que registráramos nada.
 * La paginación por días (`?desde=`) llegará cuando el volumen real lo pida.
 */

export const DIAS_HACIA_ATRAS = 14;
export const DIAS_HACIA_DELANTE = 31;
/** Tope por tipo: una red de seguridad, no un límite editorial. */
const TOPE_POR_TIPO = 500;

export type CapacidadesDelRadar = Record<
  IdPlataforma,
  { expiring: EstadoDeCapacidad; upcoming: EstadoDeCapacidad }
>;

export interface VistaDeRadar {
  comprobadoEn: Instante;
  inicioDelRegistro: Instante;
  /** Primer instante de la ventana pasada (nunca antes del registro). */
  desde: Instante;
  hasta: Instante;
  plataformas: Plataforma[];
  capacidades: CapacidadesDelRadar;
  filas: FilaDeRadar[];
}

const PASADOS: TipoDeMovimiento[] = ["llega", "se-fue", "cambio"];
const FUTUROS: TipoDeMovimiento[] = ["se-va", "proximamente"];

export async function construirRadar(
  repo: RepositorioDeCatalogo,
): Promise<VistaDeRadar> {
  const [comprobadoEn, inicioDelRegistro, plataformas, matriz, listas] =
    await Promise.all([
      repo.ultimaComprobacion(),
      repo.inicioDelRegistro(),
      repo.plataformas(),
      repo.capacidades(),
      repo.listas(),
    ]);

  const referencia = Date.parse(comprobadoEn);
  const desde = new Date(
    Math.max(Date.parse(inicioDelRegistro), referencia - DIAS_HACIA_ATRAS * DIA_MS),
  ).toISOString();
  const hasta = new Date(referencia + DIAS_HACIA_DELANTE * DIA_MS).toISOString();

  const porTipo = await Promise.all([
    ...PASADOS.map((tipo) =>
      repo.movimientos(tipo, TOPE_POR_TIPO, { desde, hasta: comprobadoEn }),
    ),
    ...FUTUROS.map((tipo) =>
      repo.movimientos(tipo, TOPE_POR_TIPO, { desde: comprobadoEn, hasta }),
    ),
  ]);
  const movimientos: Movimiento[] = porTipo.flat();

  const enListas = new Set(listas.flatMap((l) => l.entradas.map((e) => e.tituloId)));
  const titulos = new Map(
    (await repo.titulos([...new Set(movimientos.map((m) => m.tituloId))])).map((t) => [
      t.id,
      t,
    ]),
  );

  const capacidades: CapacidadesDelRadar = {};
  for (const p of plataformas) {
    capacidades[p.id] = {
      expiring: matriz[p.id]?.expiring ?? "unknown",
      upcoming: matriz[p.id]?.upcoming ?? "unknown",
    };
  }

  return {
    comprobadoEn,
    inicioDelRegistro,
    desde,
    hasta,
    plataformas,
    capacidades,
    filas: movimientos.flatMap((movimiento) => {
      const titulo = titulos.get(movimiento.tituloId);
      return titulo
        ? [{ movimiento, titulo, enListas: enListas.has(movimiento.tituloId) }]
        : [];
    }),
  };
}

export const obtenerRadar = cache(() => construirRadar(repositorio()));
