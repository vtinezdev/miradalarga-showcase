import { ColumnasDeRadar } from "@/components/ui/ColumnasDeRadar.tsx";
import { DatosEstructurados } from "@/components/ui/DatosEstructurados.tsx";
import { EditorialCard } from "@/components/ui/EditorialCard.tsx";
import { Enlace } from "@/components/ui/Enlace.tsx";
import { MarcaMia } from "@/components/ui/MarcaMia.tsx";
import { FreshnessStamp } from "@/components/ui/FreshnessStamp.tsx";
import { PageHeader } from "@/components/ui/PageHeader.tsx";
import { RailEditorial } from "@/components/ui/RailEditorial.tsx";
import { RankedList } from "@/components/ui/RankedList.tsx";
import { SearchInput } from "@/components/ui/SearchInput.tsx";
import { SectionHeader } from "@/components/ui/SectionHeader.tsx";
import { SectionIndex } from "@/components/ui/SectionIndex.tsx";
import { TitleRow } from "@/components/ui/TitleRow.tsx";
import type { HubDeTipo as Datos } from "@/features/catalogo/consultas-hubs.ts";
import {
  contarObras,
  rutaDeFicha,
  rutaDePlataforma,
} from "@/features/catalogo/formato.ts";
import { migasDePan } from "@/lib/datos-estructurados.ts";
import { cx } from "@/lib/cx.ts";
import { FUENTE_DE_DISPONIBILIDAD } from "@/lib/sitio.ts";
import s from "./HubDeTipo.module.css";

const TEXTOS = {
  pelicula: {
    titulo: "Películas",
    ruta: "/peliculas",
    obra: "peliculas",
    entradilla: "Qué películas merece la pena ver y dónde están hoy.",
    plural: "películas",
  },
  serie: {
    titulo: "Series",
    ruta: "/series",
    obra: "series",
    entradilla: "Qué series merece la pena empezar y dónde están hoy.",
    plural: "series",
  },
} as const;

/**
 * Hubs de tipo (SCREENS.md §8): la misma plantilla que el de plataforma, sin
 * plataforma fijada. Un hub de descubrimiento que **termina**, no un catálogo
 * infinito: listas del tipo, radar, mejor valoradas, por plataforma y por
 * género. Son el padre de la miga de pan de cada ficha.
 *
 * Las series añaden un bloque que las películas no necesitan: las de una sola
 * temporada, que se empiezan y se terminan (un dato, no un criterio).
 */
export function HubDeTipo({
  datos,
  plataformasValidas,
}: {
  datos: Datos;
  plataformasValidas: string[];
}) {
  const t = TEXTOS[datos.tipo];
  const secciones = [
    datos.listas.length > 0 && { id: "selecciones", etiqueta: "Selecciones" },
    datos.unaTemporada.length > 0 && { id: "una-temporada", etiqueta: "Una temporada" },
    { id: "radar", etiqueta: "Radar" },
    datos.mejorValoradas.length > 0 && {
      id: "mejor-valoradas",
      etiqueta: "Mejor valoradas",
    },
    { id: "por-plataforma", etiqueta: "Por plataforma" },
    datos.generos.length > 0 && { id: "por-genero", etiqueta: "Por género" },
  ].filter((x): x is { id: string; etiqueta: string } => Boolean(x));

  return (
    <>
      <DatosEstructurados
        datos={[
          migasDePan([
            { nombre: "Inicio", ruta: "/" },
            { nombre: t.titulo, ruta: t.ruta },
          ]),
        ]}
      />
      <PageHeader
        titulo={t.titulo}
        entradilla={
          <p>
            {t.entradilla} Seguimos {contarObras(datos.total, datos.tipo)} disponibles
            en las seis plataformas.
          </p>
        }
      >
        <FreshnessStamp
          instante={datos.comprobadoEn}
          fuente={FUENTE_DE_DISPONIBILIDAD}
        />
      </PageHeader>
      <div className={cx("contenedor", s.buscador)}>
        <SearchInput id={`buscar-${t.obra}`} />
      </div>

      <SectionIndex secciones={secciones} />

      {datos.listas.length > 0 ? (
        <section
          className={cx("contenedor", s.seccion)}
          aria-labelledby="selecciones"
          data-folio="Selecciones"
        >
          <SectionHeader
            id="selecciones"
            tipo="editorial"
            antetitulo="Listas firmadas"
            titulo={`Listas con ${t.plural}`}
            enlace={{ etiqueta: "Ver todas las listas", href: "/listas" }}
          />
          <RailEditorial
            etiqueta={`Listas con ${t.plural}`}
            elementos={datos.listas.map((l, i) => ({
              id: l.id,
              principal: i === 0,
              nodo: (
                <EditorialCard
                  lista={l}
                  tamano={i === 0 ? "principal" : "columna"}
                  plataformasValidas={plataformasValidas}
                />
              ),
            }))}
          />
        </section>
      ) : null}

      {datos.unaTemporada.length > 0 ? (
        <section
          className={cx("contenedor", s.seccion)}
          aria-labelledby="una-temporada"
          data-folio="Una sola temporada"
        >
          <SectionHeader
            id="una-temporada"
            titulo="De una sola temporada"
            descripcion="Series con una única temporada publicada: se empiezan y se terminan. Es un dato, no una recomendación; en orden alfabético."
          />
          <ul role="list" className={s.rejilla}>
            {datos.unaTemporada.map((titulo) => (
              <li key={titulo.id}>
                <TitleRow titulo={titulo} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section
        className={cx("contenedor", s.seccion)}
        aria-labelledby="radar"
        data-folio={`Radar de ${t.plural}`}
      >
        <SectionHeader
          id="radar"
          titulo={`Radar de ${t.plural}`}
          descripcion="Lo que ha llegado en los últimos 14 días y lo que se va o se anuncia para los próximos 31. Primero, lo que está en nuestras listas."
          enlace={{
            etiqueta: `Todo el radar de ${t.plural}`,
            href: `/radar?obra=${t.obra}`,
          }}
        />
        <ColumnasDeRadar columnas={datos.radar} etiqueta={`Radar de ${t.plural}`} />
      </section>

      {datos.mejorValoradas.length > 0 ? (
        <section
          className={cx("contenedor", s.seccion)}
          aria-labelledby="mejor-valoradas"
          data-folio="Mejor valoradas"
        >
          <SectionHeader
            id="mejor-valoradas"
            tipo="automatico"
            titulo={`${t.titulo} mejor valoradas`}
            descripcion="Ranking automático, ordenado por valoración externa. Solo títulos disponibles hoy en España."
            enlace={{ etiqueta: "Así lo calculamos", href: "/metodologia" }}
          />
          <div className={s.ranking}>
            <RankedList
              posiciones={datos.mejorValoradas}
              etiqueta={`${t.titulo} mejor valoradas`}
            />
          </div>
        </section>
      ) : null}

      <nav
        className={cx("contenedor", s.seccion)}
        aria-labelledby="por-plataforma"
        data-folio="Por plataforma"
      >
        <SectionHeader id="por-plataforma" titulo="Por plataforma" />
        <ul role="list" className={s.plataformas}>
          {datos.porPlataforma.map(({ plataforma, recuento }) => (
            <li key={plataforma.id}>
              <Enlace
                href={rutaDePlataforma(plataforma)}
                data-plataforma={plataforma.id}
                className={s.plataforma}
              >
                <MarcaMia posicion="punto" />
                <span className={s.nombre}>{plataforma.nombre}</span>
                <MarcaMia posicion="texto" />
                <span className={s.cuantas}>{contarObras(recuento, datos.tipo)}</span>
              </Enlace>
            </li>
          ))}
        </ul>
      </nav>

      {datos.generos.length > 0 ? (
        <section
          className={cx("contenedor", s.seccion)}
          aria-labelledby="por-genero"
          data-folio="Por género"
        >
          <SectionHeader
            id="por-genero"
            titulo="Por género"
            descripcion="Una muestra de cada género, en orden alfabético: no es un ranking."
          />
          <ul role="list" className={s.generos}>
            {datos.generos.map((g) => (
              <li key={g.nombre} className={s.genero}>
                <h3 className={s.nombreGenero}>
                  {g.nombre}{" "}
                  <span className={cx("cifras", s.cuantas)}>
                    {contarObras(g.recuento, datos.tipo)}
                  </span>
                </h3>
                <ul role="list" className={s.titulosDeGenero}>
                  {g.titulos.map((x) => (
                    <li key={x.id}>
                      <Enlace href={rutaDeFicha(x)}>{x.titulo}</Enlace>
                    </li>
                  ))}
                  {g.recuento > g.titulos.length ? (
                    <li className={s.resto}>y {g.recuento - g.titulos.length} más</li>
                  ) : null}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
