import { cache } from "react";
import { LONGITUD_MINIMA, limpiarConsulta } from "./busqueda.ts";
import { tarjetaDeLista, type TarjetaDeLista } from "./consultas.ts";
import type { Plataforma, ResultadoDeBusqueda } from "./modelo.ts";
import { repositorio } from "./proveedor.ts";
import type { RepositorioDeCatalogo } from "./repositorio.ts";

/**
 * Búsqueda (`/buscar?q=`, SCREENS.md §6). Se resuelve **en el servidor al
 * enviar**, sin autocompletado en vivo: cada pulsación sería una invocación del
 * Worker (ADR 0002). Nunca sale a una API externa, ni sin resultados (CLAUDE.md,
 * regla 1): solo lee nuestro catálogo.
 */

export const MAXIMO_DE_RESULTADOS = 50;
const LISTAS_SUGERIDAS = 3;

export interface Resultado extends ResultadoDeBusqueda {
  /** En cuántas listas editoriales aparece («En 2 listas»). */
  enListas: number;
}

export type EstadoDeBusqueda =
  "sin-consulta" | "corta" | "resultados" | "sin-resultados";

export interface VistaDeBusqueda {
  consulta: string;
  estado: EstadoDeBusqueda;
  resultados: Resultado[];
  /** Todas las coincidencias, aunque solo se muestren las primeras. */
  total: number;
  plataformas: Plataforma[];
  /** Salidas cuando no hay nada que mostrar: sin consulta o sin resultados. */
  sugeridas: TarjetaDeLista[];
}

export async function construirBusqueda(
  repo: RepositorioDeCatalogo,
  crudo: string | string[] | undefined,
): Promise<VistaDeBusqueda> {
  const consulta = limpiarConsulta(crudo);
  const buscable = consulta.length >= LONGITUD_MINIMA;
  const [plataformas, listas, encontrados] = await Promise.all([
    repo.plataformas(),
    repo.listas(),
    buscable
      ? repo.buscar(consulta, MAXIMO_DE_RESULTADOS)
      : Promise.resolve({ resultados: [], total: 0 }),
  ]);

  const cuantas = new Map<string, number>();
  for (const l of listas)
    for (const id of new Set(l.entradas.map((e) => e.tituloId)))
      cuantas.set(id, (cuantas.get(id) ?? 0) + 1);

  const estado: EstadoDeBusqueda =
    consulta.length === 0
      ? "sin-consulta"
      : !buscable
        ? "corta"
        : encontrados.total === 0
          ? "sin-resultados"
          : "resultados";

  // Solo hace falta montar tarjetas cuando se van a enseñar.
  let sugeridas: TarjetaDeLista[] = [];
  if (estado !== "resultados") {
    const elegidas = listas.slice(0, LISTAS_SUGERIDAS);
    const titulos = new Map(
      (
        await repo.titulos([
          ...new Set(elegidas.flatMap((l) => l.entradas.map((e) => e.tituloId))),
        ])
      ).map((t) => [t.id, t]),
    );
    sugeridas = elegidas.map((l) => tarjetaDeLista(l, titulos));
  }

  return {
    consulta,
    estado,
    resultados: encontrados.resultados.map((r) => ({
      ...r,
      enListas: cuantas.get(r.titulo.id) ?? 0,
    })),
    total: encontrados.total,
    plataformas,
    sugeridas,
  };
}

export const obtenerBusqueda = cache((crudo: string | undefined) =>
  construirBusqueda(repositorio(), crudo),
);
