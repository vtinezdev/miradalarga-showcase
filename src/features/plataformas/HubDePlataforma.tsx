import { AlternarMiPlataforma } from "@/components/ui/AlternarMiPlataforma.tsx";
import { ColumnasDeRadar } from "@/components/ui/ColumnasDeRadar.tsx";
import { DatosEstructurados } from "@/components/ui/DatosEstructurados.tsx";
import { Enlace } from "@/components/ui/Enlace.tsx";
import { MarcaMia } from "@/components/ui/MarcaMia.tsx";
import { FreshnessStamp } from "@/components/ui/FreshnessStamp.tsx";
import { PageHeader } from "@/components/ui/PageHeader.tsx";
import { PestanasResponsive } from "@/components/ui/PestanasResponsive.tsx";
import { RankedList } from "@/components/ui/RankedList.tsx";
import { SectionHeader } from "@/components/ui/SectionHeader.tsx";
import { SectionIndex } from "@/components/ui/SectionIndex.tsx";
import { TitleRow } from "@/components/ui/TitleRow.tsx";
import type { HubDePlataforma as Datos } from "@/features/catalogo/consultas-hubs.ts";
import { contarObras, rutaDePlataforma } from "@/features/catalogo/formato.ts";
import { migasDePan } from "@/lib/datos-estructurados.ts";
import { cx } from "@/lib/cx.ts";
import { FUENTE_DE_DISPONIBILIDAD } from "@/lib/sitio.ts";
import s from "./Plataformas.module.css";

/**
 * `/plataformas/{slug}` (SCREENS.md §7): «Qué ver en Netflix». Cada sección
 * existe **solo si tiene dato** —no todas las plataformas pueden decirnos lo
 * mismo—, y el índice local solo enlaza las que existen. Lo editorial (lo mejor
 * según nuestras listas) va antes que lo calculado, y nunca se mezclan.
 */
export function HubDePlataforma({
  datos,
  plataformasValidas,
}: {
  datos: Datos;
  plataformasValidas: string[];
}) {
  const { plataforma, recuento, deNuestrasListas, radar, mejorValoradas } = datos;
  const nombre = plataforma.nombre;
  const rankings = [
    { id: "peliculas", titulo: "Películas", posiciones: mejorValoradas.peliculas },
    { id: "series", titulo: "Series", posiciones: mejorValoradas.series },
  ].filter((r) => r.posiciones.length > 0);
  const secciones = [
    deNuestrasListas.length > 0 && { id: "lo-mejor", etiqueta: "Lo mejor" },
    { id: "radar", etiqueta: "Radar" },
    rankings.length > 0 && { id: "mejor-valoradas", etiqueta: "Mejor valoradas" },
    { id: "otras-plataformas", etiqueta: "Otras plataformas" },
  ].filter((x): x is { id: string; etiqueta: string } => Boolean(x));

  return (
    <>
      <DatosEstructurados
        datos={[
          migasDePan([
            { nombre: "Inicio", ruta: "/" },
            { nombre: "Plataformas", ruta: "/plataformas" },
            { nombre, ruta: rutaDePlataforma(plataforma) },
          ]),
        ]}
      />
      <PageHeader
        antetitulo="Plataforma"
        titulo={`Qué ver en ${nombre}`}
        migas={[
          { etiqueta: "Inicio", href: "/" },
          { etiqueta: "Plataformas", href: "/plataformas" },
          { etiqueta: nombre },
        ]}
        entradilla={
          <p>
            Seguimos {contarObras(recuento.pelicula, "pelicula")} y{" "}
            {contarObras(recuento.serie, "serie")} disponibles hoy en {nombre} en
            España. Primero, lo que recomendamos; después, lo que llega y lo que se va.
          </p>
        }
      >
        <AlternarMiPlataforma plataforma={plataforma} validos={plataformasValidas} />
        <FreshnessStamp
          instante={datos.comprobadoEn}
          fuente={FUENTE_DE_DISPONIBILIDAD}
        />
      </PageHeader>

      <SectionIndex secciones={secciones} />

      {deNuestrasListas.length > 0 ? (
        <section
          className={cx("contenedor", s.seccion)}
          aria-labelledby="lo-mejor"
          data-folio={`Lo mejor de ${nombre}`}
        >
          <SectionHeader
            id="lo-mejor"
            tipo="editorial"
            antetitulo="Listas firmadas"
            titulo={`Lo mejor de ${nombre}, según nuestras listas`}
            enlace={{ etiqueta: "Ver todas las listas", href: "/listas" }}
          />
          <ul role="list" className={s.filasEditoriales}>
            {deNuestrasListas.map(({ titulo, entrada, lista }) => (
              <li key={titulo.id}>
                <TitleRow
                  titulo={titulo}
                  nota={
                    <>
                      <span className={s.veredicto}>
                        {primeraFrase(entrada.veredicto)}
                      </span>{" "}
                      <span className={s.deLista}>De «{lista.titulo}»</span>
                    </>
                  }
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section
        className={cx("contenedor", s.seccion)}
        aria-labelledby="radar"
        data-folio={`Radar de ${nombre}`}
      >
        <SectionHeader
          id="radar"
          titulo={`Radar de ${nombre}`}
          descripcion="Lo que ha llegado en los últimos 14 días y lo que se va o se anuncia para los próximos 31. Primero, lo que está en nuestras listas."
          enlace={{
            etiqueta: `Todo el radar de ${nombre}`,
            href: `/radar?plataforma=${plataforma.slug}`,
          }}
        />
        <ColumnasDeRadar columnas={radar} etiqueta={`Radar de ${nombre}`} />
      </section>

      {rankings.length > 0 ? (
        <section
          className={cx("contenedor", s.seccion)}
          aria-labelledby="mejor-valoradas"
          data-folio="Mejor valoradas"
        >
          <SectionHeader
            id="mejor-valoradas"
            tipo="automatico"
            titulo={`Mejor valoradas en ${nombre}`}
            descripcion="Ranking automático, ordenado por valoración externa. Solo títulos disponibles hoy en esta plataforma."
            enlace={{ etiqueta: "Así lo calculamos", href: "/metodologia" }}
          />
          {rankings.length === 1 && rankings[0] ? (
            <div className={s.rankingUnico}>
              <h3 className={s.h3}>{rankings[0].titulo}</h3>
              <RankedList
                posiciones={rankings[0].posiciones}
                etiqueta={`${rankings[0].titulo} mejor valoradas en ${nombre}`}
              />
            </div>
          ) : (
            <PestanasResponsive
              etiqueta={`Mejor valoradas en ${nombre}`}
              hasta="48rem"
              paneles={rankings.map((r) => ({
                id: r.id,
                titulo: r.titulo,
                contenido: (
                  <RankedList
                    posiciones={r.posiciones}
                    etiqueta={`${r.titulo} mejor valoradas en ${nombre}`}
                  />
                ),
              }))}
            />
          )}
        </section>
      ) : null}

      <nav
        className={cx("contenedor", s.seccion)}
        aria-labelledby="otras-plataformas"
        data-folio="Otras plataformas"
      >
        <SectionHeader id="otras-plataformas" titulo="Otras plataformas" />
        <ul role="list" className={s.otras}>
          {datos.otras.map((p) => (
            <li key={p.id}>
              <Enlace
                href={rutaDePlataforma(p)}
                data-plataforma={p.id}
                className={s.otra}
              >
                <MarcaMia posicion="punto" />
                Qué ver en {p.nombre}
                <MarcaMia posicion="texto" />
              </Enlace>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}

function primeraFrase(texto: string): string {
  const fin = texto.search(/[.!?](\s|$)/);
  return fin === -1 ? texto : texto.slice(0, fin + 1);
}
