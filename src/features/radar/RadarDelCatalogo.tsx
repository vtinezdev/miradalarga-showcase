"use client";

import { useMemo, type ReactNode } from "react";
import { IconoDeMovimiento } from "@/components/ui/CatalogEvent.tsx";
import { EmptyState } from "@/components/ui/EmptyState.tsx";
import { EtiquetaDeDia } from "@/components/ui/EtiquetaDeDia.tsx";
import { FilterChips } from "@/components/ui/FilterChips.tsx";
import { InvitacionMisPlataformas } from "@/components/ui/InvitacionMisPlataformas.tsx";
import { PistaTemporal } from "@/components/ui/PistaTemporal.tsx";
import regla from "@/components/ui/ReglaTemporal.module.css";
import type { CapacidadesDelRadar } from "@/features/catalogo/consultas-radar.ts";
import { enumerar, mensajeDeCapacidad } from "@/features/catalogo/formato.ts";
import type { Plataforma, TipoDeMovimiento } from "@/features/catalogo/modelo.ts";
import { useFiltrosEnUrl } from "@/features/filtros/url.ts";
import { abrirMisPlataformas } from "@/features/mis-plataformas/eventos.ts";
import { useMisPlataformas } from "@/features/mis-plataformas/estado.ts";
import { fechaCorta } from "@/lib/fechas.ts";
import { cx } from "@/lib/cx.ts";
import {
  ETIQUETA_DE_TIPO,
  MIS_PLATAFORMAS,
  PASADOS,
  TIPOS,
  cumple,
  describirFiltros,
  facetasDelRadar,
  porDia,
  recuentos,
  type Filtrable,
} from "./filtros.ts";
import s from "./RadarDelCatalogo.module.css";

export interface FilaDelRadar extends Filtrable {
  clave: string;
  /** `2026-09-28`, el día en Madrid. */
  dia: string;
  enListas: boolean;
  /** La fila ya pintada por el servidor. */
  nodo: ReactNode;
}

/** Dentro de un día: lo editorial primero y después por tipo. */
const ORDEN: Record<TipoDeMovimiento, number> = {
  llega: 0,
  "se-fue": 1,
  cambio: 2,
  "se-va": 3,
  proximamente: 4,
};

const CUENTA: Record<TipoDeMovimiento, [string, string]> = {
  llega: ["llega", "llegan"],
  "se-va": ["se va", "se van"],
  proximamente: ["anunciado", "anunciados"],
  "se-fue": ["se fue", "se fueron"],
  cambio: ["cambio", "cambios"],
};

const DESTACADOS = 4;

/**
 * El radar del catálogo (SCREENS.md §4): un **diario**, no un panel.
 *
 * Todo el contenido llega pintado del servidor (la página es estática); esta
 * isla solo decide qué filas se ven según los filtros de la URL y monta, sobre
 * ellas, tres piezas:
 *
 * 1. La **regla temporal** como índice (firma 5): pasado ← hoy → futuro, un día
 *    por columna con cuánto se mueve de cada tipo; cada día lleva a su sitio en
 *    el diario. Es una capa de navegación sobre la lista, no su sustituta.
 * 2. **De nuestras listas**: los movimientos de títulos que están en listas
 *    editoriales, antes que el resto (el criterio filtra el dato).
 * 3. El **diario** vertical: lo que ha pasado (del más reciente hacia atrás) y
 *    lo que viene (del más próximo hacia delante).
 *
 * Sin JavaScript se lee todo el radar sin filtrar; con él, filtrar no pide nada
 * al servidor.
 */
export function RadarDelCatalogo({
  filas,
  hoy,
  desde,
  hasta,
  plataformas,
  capacidades,
}: {
  filas: readonly FilaDelRadar[];
  hoy: string;
  desde: string;
  hasta: string;
  plataformas: readonly Plataforma[];
  capacidades: CapacidadesDelRadar;
}) {
  const facetas = useMemo(() => facetasDelRadar(plataformas), [plataformas]);
  const { filtros, cambiar, limpiar, activos, tocado } = useFiltrosEnUrl(facetas);
  const validos = useMemo(() => plataformas.map((p) => p.id), [plataformas]);
  const { seleccion } = useMisPlataformas(validos);
  const contexto = useMemo(
    () => ({
      idPorSlug: new Map(plataformas.map((p) => [p.slug, p.id])),
      mias: new Set(seleccion),
    }),
    [plataformas, seleccion],
  );

  const visibles = filas.filter((f) => cumple(f, filtros, contexto));
  const cuenta = (clave: string, valores: readonly string[]) =>
    recuentos(filas, filtros, contexto, clave, valores);
  const porTipo = cuenta("tipo", TIPOS);
  const porPlataforma = cuenta("plataforma", [
    ...plataformas.map((p) => p.slug),
    MIS_PLATAFORMAS,
  ]);
  const porObra = cuenta("obra", ["peliculas", "series"]);

  const plataforma = plataformas.find((p) => p.slug === filtros.plataforma);
  const descripcion = describirFiltros(filtros, plataformas);
  const total = `${visibles.length} ${visibles.length === 1 ? "movimiento" : "movimientos"}`;

  const ordenar = (a: FilaDelRadar, b: FilaDelRadar) =>
    Number(b.enListas) - Number(a.enListas) || ORDEN[a.tipo] - ORDEN[b.tipo];
  const pasado = porDia(
    visibles.filter((f) => PASADOS.has(f.tipo)),
    "desc",
  ).map((d) => ({ ...d, filas: [...d.filas].sort(ordenar) }));
  const futuro = porDia(
    visibles.filter((f) => !PASADOS.has(f.tipo)),
    "asc",
  ).map((d) => ({ ...d, filas: [...d.filas].sort(ordenar) }));
  const destacados = visibles
    .filter((f) => f.enListas)
    .sort((a, b) => distancia(a.dia, hoy) - distancia(b.dia, hoy))
    .slice(0, DESTACADOS);

  return (
    <div className={cx("contenedor", s.radar)}>
      <section className={s.filtros} aria-labelledby="filtrar">
        <h2 id="filtrar" className="sr-only">
          Filtrar el radar
        </h2>
        <FilterChips
          legend="Tipo"
          valor={filtros.tipo ?? ""}
          alCambiar={(v) => cambiar("tipo", v)}
          opciones={[
            { valor: "", etiqueta: "Todo", recuento: porTipo[""] },
            ...(["llega", "se-va", "proximamente", "se-fue"] as const).map((t) => ({
              valor: t,
              etiqueta: ETIQUETA_DE_TIPO[t],
              recuento: porTipo[t],
            })),
          ]}
          extra={{
            etiqueta: "Más",
            opciones: [
              {
                valor: "cambio",
                etiqueta: ETIQUETA_DE_TIPO.cambio,
                recuento: porTipo.cambio,
              },
            ],
          }}
        />
        <div className={s.grupoPlataforma}>
          <FilterChips
            legend="Plataforma"
            plegable
            valor={filtros.plataforma ?? ""}
            alCambiar={(v) => cambiar("plataforma", v)}
            opciones={[
              { valor: "", etiqueta: "Todas", recuento: porPlataforma[""] },
              {
                valor: MIS_PLATAFORMAS,
                etiqueta: "Mis plataformas",
                recuento: porPlataforma[MIS_PLATAFORMAS],
                soloConSeleccion: true,
              },
              ...plataformas.map((p) => ({
                valor: p.slug,
                etiqueta: p.nombre,
                recuento: porPlataforma[p.slug],
              })),
            ]}
          />
          <InvitacionMisPlataformas
            className={s.invitacion}
            texto="Marca tus plataformas y fíltralo por ellas"
          />
        </div>
        <FilterChips
          legend="Obra"
          valor={filtros.obra ?? ""}
          alCambiar={(v) => cambiar("obra", v)}
          opciones={[
            { valor: "", etiqueta: "Todo", recuento: porObra[""] },
            { valor: "peliculas", etiqueta: "Películas", recuento: porObra.peliculas },
            { valor: "series", etiqueta: "Series", recuento: porObra.series },
          ]}
        />
      </section>

      <div className={s.cuerpo}>
        <div className={s.resumen}>
          <p>
            <strong className="cifras">{total}</strong>
            {descripcion ? ` ${descripcion}` : " entre el "}
            {descripcion ? null : (
              <>
                <time dateTime={desde}>{fechaCorta(desde)}</time> y el{" "}
                <time dateTime={hasta}>{fechaCorta(hasta)}</time>
              </>
            )}
          </p>
          {activos > 0 ? (
            <button type="button" className={cx("enlace", s.quitar)} onClick={limpiar}>
              Quitar filtros
            </button>
          ) : null}
        </div>
        <p className="sr-only" role="status" aria-live="polite">
          {tocado ? `${total}${descripcion ? `, ${descripcion}` : ""}.` : ""}
        </p>

        {visibles.length === 0 ? (
          <Vacio
            filtros={filtros}
            plataforma={plataforma}
            capacidades={capacidades}
            sinSeleccion={seleccion.length === 0}
            descripcion={descripcion}
            limpiar={limpiar}
          />
        ) : (
          <>
            <nav className={s.indice} aria-label="Días del radar">
              <div className={regla.regla}>
                <PistaTemporal etiqueta="Movimientos por día, del pasado al futuro">
                  {diasDeLaRegla(visibles, hoy).map(({ dia, porTipo: conteo }) => {
                    const momento =
                      dia < hoy ? "pasado" : dia === hoy ? "hoy" : "futuro";
                    const destino = conteo.some(([t]) => PASADOS.has(t))
                      ? `#dia-pasado-${dia}`
                      : conteo.length > 0
                        ? `#dia-futuro-${dia}`
                        : null;
                    return (
                      <li
                        key={dia}
                        className={cx(regla.dia, regla[momento], s.dia)}
                        data-hoy={momento === "hoy" ? "" : undefined}
                      >
                        <span className={regla.marca} aria-hidden="true" />
                        <p className={cx(regla.fecha, s.fechaIndice)}>
                          {destino ? (
                            <a href={destino} className={s.irAlDia}>
                              <time dateTime={dia}>
                                <EtiquetaDeDia dia={dia} />
                              </time>
                            </a>
                          ) : (
                            <time dateTime={dia}>
                              <EtiquetaDeDia dia={dia} />
                            </time>
                          )}
                        </p>
                        {conteo.length > 0 ? (
                          <ul role="list" className={s.conteos}>
                            {conteo.map(([tipo, n]) => (
                              <li key={tipo} data-tipo={tipo} className={s.conteo}>
                                <IconoDeMovimiento tipo={tipo} />
                                <span>
                                  <span className="cifras">{n}</span>{" "}
                                  {CUENTA[tipo][n === 1 ? 0 : 1]}
                                </span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className={regla.vacio}>Nada registrado este día.</p>
                        )}
                      </li>
                    );
                  })}
                </PistaTemporal>
              </div>
            </nav>

            {destacados.length > 0 ? (
              <section className={s.destacado} aria-labelledby="de-nuestras-listas">
                <h2 id="de-nuestras-listas" className={s.h2}>
                  De nuestras listas
                </h2>
                <p className={s.nota}>
                  Movimientos de títulos que recomendamos en alguna lista editorial.
                </p>
                <ul role="list" className={s.filas}>
                  {destacados.map((f) => (
                    <li key={`d-${f.clave}`}>{f.nodo}</li>
                  ))}
                </ul>
              </section>
            ) : null}

            {pasado.length > 0 ? (
              <section className={s.tramo} aria-labelledby="lo-que-ha-pasado">
                <h2 id="lo-que-ha-pasado" className={s.h2}>
                  Lo que ha pasado
                </h2>
                <p className={s.nota}>
                  Llegadas, salidas y cambios, del más reciente hacia atrás.
                </p>
                {pasado.map((d) => (
                  <Dia
                    key={d.dia}
                    id={`dia-pasado-${d.dia}`}
                    dia={d.dia}
                    filas={d.filas}
                  />
                ))}
              </section>
            ) : null}

            {futuro.length > 0 ||
            !filtros.tipo ||
            !PASADOS.has(filtros.tipo as TipoDeMovimiento) ? (
              <section className={s.tramo} aria-labelledby="lo-que-viene">
                <h2 id="lo-que-viene" className={s.h2}>
                  Lo que viene
                </h2>
                <div className={s.nota}>
                  {notasDeCobertura(plataforma, plataformas, capacidades).map((n) => (
                    <p key={n}>{n}</p>
                  ))}
                </div>
                {futuro.length > 0 ? (
                  futuro.map((d) => (
                    <Dia
                      key={d.dia}
                      id={`dia-futuro-${d.dia}`}
                      dia={d.dia}
                      filas={d.filas}
                    />
                  ))
                ) : (
                  <p className={s.sinFuturo}>
                    Con estos filtros, ninguna salida ni llegada anunciada en los
                    próximos 31 días.
                  </p>
                )}
              </section>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function Dia({ id, dia, filas }: { id: string; dia: string; filas: FilaDelRadar[] }) {
  return (
    <section id={id} className={s.diaDelDiario} aria-labelledby={`${id}-titulo`}>
      <h3 id={`${id}-titulo`} className={s.h3}>
        <time dateTime={dia}>
          <EtiquetaDeDia dia={dia} conFecha />
        </time>
      </h3>
      <ul role="list" className={s.filas}>
        {filas.map((f) => (
          <li key={f.clave}>{f.nodo}</li>
        ))}
      </ul>
    </section>
  );
}

function Vacio({
  filtros,
  plataforma,
  capacidades,
  sinSeleccion,
  descripcion,
  limpiar,
}: {
  filtros: Record<string, string>;
  plataforma: Plataforma | undefined;
  capacidades: CapacidadesDelRadar;
  sinSeleccion: boolean;
  descripcion: string;
  limpiar: () => void;
}) {
  const quitar = (
    <button type="button" onClick={limpiar}>
      Quitar filtros
    </button>
  );
  if (filtros.plataforma === MIS_PLATAFORMAS && sinSeleccion) {
    return (
      <EmptyState
        compacto
        motivo="sin-datos"
        titulo="Todavía no has marcado tus plataformas"
        explicacion="Márcalas y el radar te enseñará solo lo que se mueve en ellas. Se guardan en este navegador, sin cuenta."
      >
        <button type="button" onClick={abrirMisPlataformas} aria-haspopup="dialog">
          Marcar mis plataformas
        </button>
      </EmptyState>
    );
  }
  const capacidad =
    filtros.tipo === "se-va"
      ? "expiring"
      : filtros.tipo === "proximamente"
        ? "upcoming"
        : null;
  if (plataforma && capacidad) {
    const estado = capacidades[plataforma.id]?.[capacidad] ?? "unknown";
    return (
      <EmptyState
        compacto
        motivo={
          estado === "supported_with_data"
            ? "sin-resultados"
            : estado === "supported_no_data_in_sample"
              ? "sin-datos"
              : "capacidad"
        }
        titulo={
          capacidad === "expiring"
            ? `Sin salidas anunciadas en ${plataforma.nombre}`
            : `Sin llegadas anunciadas en ${plataforma.nombre}`
        }
        explicacion={mensajeDeCapacidad(capacidad, estado, plataforma.nombre)}
      >
        {quitar}
      </EmptyState>
    );
  }
  return (
    <EmptyState
      compacto
      titulo="Nada se mueve con estos filtros"
      explicacion={`Ningún movimiento ${descripcion} en los días que cubre el radar. Prueba con otra plataforma o quita algún filtro.`}
    >
      {quitar}
    </EmptyState>
  );
}

/** Qué no podemos publicar en «Lo que viene», dicho con la frase de su estado. */
function notasDeCobertura(
  plataforma: Plataforma | undefined,
  plataformas: readonly Plataforma[],
  capacidades: CapacidadesDelRadar,
): string[] {
  if (plataforma) {
    return (["expiring", "upcoming"] as const).flatMap((c) => {
      const estado = capacidades[plataforma.id]?.[c] ?? "unknown";
      return estado === "supported_with_data"
        ? []
        : [mensajeDeCapacidad(c, estado, plataforma.nombre)];
    });
  }
  const con = (c: "expiring" | "upcoming") =>
    enumerar(
      plataformas
        .filter((p) => capacidades[p.id]?.[c] === "supported_with_data")
        .map((p) => p.nombre),
    );
  return [
    `Solo publicamos salidas con fecha de ${con("expiring")}, y llegadas anunciadas de ${con("upcoming")}: las demás no las anuncian o todavía no las medimos.`,
  ];
}

/** Los días de la regla: los que tienen movimientos visibles, y hoy siempre. */
function diasDeLaRegla(
  filas: readonly FilaDelRadar[],
  hoy: string,
): { dia: string; porTipo: [TipoDeMovimiento, number][] }[] {
  const dias = new Map<string, Map<TipoDeMovimiento, number>>([[hoy, new Map()]]);
  for (const f of filas) {
    const conteo = dias.get(f.dia) ?? new Map<TipoDeMovimiento, number>();
    conteo.set(f.tipo, (conteo.get(f.tipo) ?? 0) + 1);
    dias.set(f.dia, conteo);
  }
  return [...dias.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dia, conteo]) => ({
      dia,
      porTipo: TIPOS.filter((t) => conteo.has(t)).map((t) => [t, conteo.get(t)!]),
    }));
}

function distancia(dia: string, hoy: string): number {
  return Math.abs(Date.parse(dia) - Date.parse(hoy));
}
