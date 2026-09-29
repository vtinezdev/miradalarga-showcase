"use client";

import { useMemo, type ReactNode } from "react";
import { EmptyState } from "@/components/ui/EmptyState.tsx";
import { FilterChips } from "@/components/ui/FilterChips.tsx";
import { InvitacionMisPlataformas } from "@/components/ui/InvitacionMisPlataformas.tsx";
import type { Plataforma, TipoDeObra } from "@/features/catalogo/modelo.ts";
import {
  MIS_PLATAFORMAS,
  OBRAS,
  useFiltrosEnUrl,
  type Faceta,
  type Filtros,
} from "@/features/filtros/url.ts";
import { useMisPlataformas } from "@/features/mis-plataformas/estado.ts";
import { cx } from "@/lib/cx.ts";
import s from "./Busqueda.module.css";

export interface ResultadoFiltrable {
  clave: string;
  obra: TipoDeObra;
  /** Ids de las plataformas donde está hoy. */
  plataformas: string[];
  nodo: ReactNode;
}

/**
 * Resultados de búsqueda con filtros de obra y plataforma (SCREENS.md §6). La
 * búsqueda se hizo en el servidor; aquí solo se decide qué resultados se ven.
 * El servidor conoce los filtros de la URL (`inicial`), así que el HTML servido
 * ya llega filtrado y la hidratación no mueve nada.
 */
export function ResultadosFiltrables({
  resultados,
  plataformas,
  inicial,
}: {
  resultados: readonly ResultadoFiltrable[];
  plataformas: readonly Plataforma[];
  inicial: string;
}) {
  const facetas = useMemo<Faceta[]>(
    () => [
      { clave: "obra", valores: Object.keys(OBRAS) },
      {
        clave: "plataforma",
        valores: [...plataformas.map((p) => p.slug), MIS_PLATAFORMAS],
      },
    ],
    [plataformas],
  );
  const { filtros, cambiar, limpiar, activos, tocado } = useFiltrosEnUrl(
    facetas,
    inicial,
  );
  const validos = useMemo(() => plataformas.map((p) => p.id), [plataformas]);
  const { seleccion } = useMisPlataformas(validos);
  const mias = new Set(seleccion);
  const idPorSlug = new Map(plataformas.map((p) => [p.slug, p.id]));

  const cumple = (r: ResultadoFiltrable, f: Filtros, ignorar?: string) => {
    if (ignorar !== "obra" && f.obra && r.obra !== OBRAS[f.obra]) return false;
    if (ignorar !== "plataforma" && f.plataforma) {
      if (f.plataforma === MIS_PLATAFORMAS)
        return r.plataformas.some((p) => mias.has(p));
      const id = idPorSlug.get(f.plataforma);
      return id !== undefined && r.plataformas.includes(id);
    }
    return true;
  };
  const contar = (clave: string, valor: string) =>
    resultados.filter((r) => cumple(r, { ...filtros, [clave]: valor })).length;
  const visibles = resultados.filter((r) => cumple(r, filtros));
  const grupos = (
    [
      ["pelicula", "Películas"],
      ["serie", "Series"],
    ] as const
  )
    .map(([obra, titulo]) => ({
      obra,
      titulo,
      filas: visibles.filter((r) => r.obra === obra),
    }))
    .filter((g) => g.filas.length > 0);

  const resumen = `${visibles.length} de ${resultados.length} resultados`;

  return (
    <div className={s.resultados}>
      <section className={s.filtros} aria-labelledby="filtrar-resultados">
        <h2 id="filtrar-resultados" className="sr-only">
          Filtrar los resultados
        </h2>
        <FilterChips
          legend="Obra"
          valor={filtros.obra ?? ""}
          alCambiar={(v) => cambiar("obra", v)}
          opciones={[
            { valor: "", etiqueta: "Todo", recuento: contar("obra", "") },
            {
              valor: "peliculas",
              etiqueta: "Películas",
              recuento: contar("obra", "peliculas"),
            },
            { valor: "series", etiqueta: "Series", recuento: contar("obra", "series") },
          ]}
        />
        <div className={s.grupoPlataforma}>
          <FilterChips
            legend="Plataforma"
            plegable
            valor={filtros.plataforma ?? ""}
            alCambiar={(v) => cambiar("plataforma", v)}
            opciones={[
              { valor: "", etiqueta: "Todas", recuento: contar("plataforma", "") },
              {
                valor: MIS_PLATAFORMAS,
                etiqueta: "Mis plataformas",
                recuento: contar("plataforma", MIS_PLATAFORMAS),
                soloConSeleccion: true,
              },
              ...plataformas.map((p) => ({
                valor: p.slug,
                etiqueta: p.nombre,
                recuento: contar("plataforma", p.slug),
              })),
            ]}
          />
          <InvitacionMisPlataformas
            className={s.invitacion}
            texto="Marca tus plataformas y filtra por ellas"
          />
        </div>
        {activos > 0 ? (
          <button type="button" className={cx("enlace", s.quitar)} onClick={limpiar}>
            Quitar filtros
          </button>
        ) : null}
      </section>

      <p className="sr-only" role="status" aria-live="polite">
        {tocado ? `${resumen}.` : ""}
      </p>

      {grupos.length === 0 ? (
        <EmptyState
          compacto
          titulo="Ningún resultado con estos filtros"
          explicacion={`Hay ${resultados.length} ${resultados.length === 1 ? "resultado" : "resultados"} para tu búsqueda, pero ninguno cumple los filtros elegidos.`}
        >
          <button type="button" onClick={limpiar}>
            Quitar filtros
          </button>
        </EmptyState>
      ) : (
        grupos.map((g) => (
          <section
            key={g.obra}
            className={s.grupo}
            aria-labelledby={`resultados-${g.obra}`}
          >
            <h2 id={`resultados-${g.obra}`} className={s.h2}>
              {g.titulo}{" "}
              <span className={cx("cifras", s.cuantos)}>{g.filas.length}</span>
            </h2>
            <ul role="list" className={s.filas}>
              {g.filas.map((r) => (
                <li key={r.clave}>{r.nodo}</li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
