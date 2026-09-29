import { EditorialCard } from "@/components/ui/EditorialCard.tsx";
import { EditorialHero } from "@/components/ui/EditorialHero.tsx";
import { FechaRelativa } from "@/components/ui/FechaRelativa.tsx";
import { PestanasResponsive } from "@/components/ui/PestanasResponsive.tsx";
import { PlatformSelector } from "@/components/ui/PlatformSelector.tsx";
import { RailEditorial } from "@/components/ui/RailEditorial.tsx";
import { RankedList } from "@/components/ui/RankedList.tsx";
import { ReglaTemporal } from "@/components/ui/ReglaTemporal.tsx";
import { SearchInput } from "@/components/ui/SearchInput.tsx";
import { SectionHeader } from "@/components/ui/SectionHeader.tsx";
import type { Portada as DatosDePortada } from "@/features/catalogo/consultas.ts";
import type { Plataforma } from "@/features/catalogo/modelo.ts";
import { fechaDeEdicion } from "@/lib/fechas.ts";
import { LEMA } from "@/lib/sitio.ts";
import s from "./Portada.module.css";
import { Enlace } from "@/components/ui/Enlace.tsx";

/**
 * Portada (SCREENS.md §1). Orden aprobado:
 *
 * 0 cabecera de edición (h1 = lema) · 1 selección principal · 2 utilidad
 * (buscador, Mis plataformas, accesos) · 3 selecciones editoriales · 4 radar ·
 * 5 mejor valoradas · 6 explora.
 *
 * Una edición que **termina**: ni paginación ni scroll infinito. Funciona igual
 * de bien sin ninguna imagen (ADR 0008).
 *
 * Dos piezas horizontales, cada una con función editorial: el **rail** de
 * listas firmadas (recorrerlas, con la principal destacada) y la **regla
 * temporal** del radar (pasado ← hoy → futuro). Nada más va en horizontal.
 * Cada sección declara su `data-folio` para el titulillo de la cabecera.
 */
export function Portada({ datos }: { datos: DatosDePortada }) {
  const validos = datos.plataformas.map((p) => p.id);
  return (
    <>
      <CabeceraDeEdicion comprobadoEn={datos.comprobadoEn} />

      {datos.destacada ? (
        <EditorialHero
          id="seleccion-principal"
          lista={datos.destacada.lista}
          entradas={datos.destacada.entradas}
        />
      ) : null}

      <section className={`contenedor ${s.utilidad}`} aria-labelledby="encuentra">
        <SectionHeader id="encuentra" titulo="Encuentra qué ver" oculto />
        <SearchInput id="buscar-portada" className={s.buscador} />
        <PlatformSelector
          plataformas={datos.plataformas}
          variante="en-linea"
          llegadasDeLaSemana={datos.llegadasDeLaSemana}
        />
        <nav aria-label="Accesos rápidos" className={s.accesos}>
          <ul role="list">
            <li>
              <Enlace href="/peliculas">Películas</Enlace>
            </li>
            <li>
              <Enlace href="/series">Series</Enlace>
            </li>
            <li>
              <Enlace href="/radar?tipo=llega">Lo que acaba de llegar</Enlace>
            </li>
            <li>
              <Enlace href="/radar?tipo=se-va">Últimos días</Enlace>
            </li>
          </ul>
        </nav>
      </section>

      {datos.selecciones.length > 0 ? (
        <section
          className={`contenedor ${s.seccion}`}
          aria-labelledby="selecciones"
          data-folio="Qué merece la pena ver"
        >
          <SectionHeader
            id="selecciones"
            tipo="editorial"
            antetitulo="Listas firmadas"
            titulo="Qué merece la pena ver"
            enlace={{
              etiqueta: `Ver las ${datos.totalDeListas} listas`,
              href: "/listas",
            }}
          />
          <RailEditorial
            etiqueta="Listas firmadas"
            elementos={datos.selecciones.map((l, i) => ({
              id: l.id,
              principal: i === 0,
              nodo: (
                <EditorialCard
                  lista={l}
                  tamano={i === 0 ? "principal" : "columna"}
                  plataformasValidas={validos}
                />
              ),
            }))}
          />
        </section>
      ) : null}

      <section
        className={`contenedor ${s.seccion}`}
        aria-labelledby="radar"
        data-folio="Radar del catálogo"
      >
        <SectionHeader
          id="radar"
          titulo="Radar del catálogo"
          descripcion="Qué llega, qué se va y qué se anuncia, día a día. Dentro de cada día, primero lo que está en nuestras listas."
          enlace={{ etiqueta: "Ver todo el radar", href: "/radar" }}
        />
        <ReglaTemporal
          etiqueta="Movimientos del catálogo por día, del pasado al futuro"
          referencia={datos.comprobadoEn}
          filas={[
            ...datos.radar.llega,
            ...datos.radar.seFue,
            ...datos.radar.cambios,
            ...datos.radar.seVa,
            ...datos.radar.proximamente,
          ]}
          notas={
            <>
              <p>
                {coberturaTexto(
                  "Solo publicamos salidas con fecha de",
                  datos.cobertura.salidas,
                )}
              </p>
              <p>
                {coberturaTexto(
                  "Solo publicamos llegadas anunciadas de",
                  datos.cobertura.llegadasAnunciadas,
                )}
              </p>
            </>
          }
        />
      </section>

      <section
        className={`contenedor ${s.seccion}`}
        aria-labelledby="mejor-valoradas"
        data-folio="Mejor valoradas"
      >
        <SectionHeader
          id="mejor-valoradas"
          tipo="automatico"
          titulo="Mejor valoradas"
          descripcion="Ranking automático, ordenado por valoración externa. Solo títulos disponibles hoy en España."
          enlace={{ etiqueta: "Así lo calculamos", href: "/metodologia" }}
        />
        <PestanasResponsive
          etiqueta="Mejor valoradas"
          hasta="48rem"
          paneles={[
            {
              id: "peliculas",
              titulo: "Películas",
              contenido: (
                <RankedList
                  posiciones={datos.mejorValoradas.peliculas}
                  etiqueta="Películas mejor valoradas"
                />
              ),
            },
            {
              id: "series",
              titulo: "Series",
              contenido: (
                <RankedList
                  posiciones={datos.mejorValoradas.series}
                  etiqueta="Series mejor valoradas"
                />
              ),
            },
          ]}
        />
      </section>

      <section
        className={`contenedor ${s.seccion}`}
        aria-labelledby="explora"
        data-folio="Explora"
      >
        <SectionHeader id="explora" titulo="Explora por plataforma" />
        <ul role="list" className={s.plataformas}>
          {datos.plataformas.map((p) => (
            <li key={p.id}>
              <Enlace
                href={`/plataformas/${p.slug}`}
                data-plataforma={p.id}
                className={s.plataforma}
              >
                <span className={s.puntoMio} aria-hidden="true" />
                Qué ver en {p.nombre}
              </Enlace>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function CabeceraDeEdicion({ comprobadoEn }: { comprobadoEn: string }) {
  return (
    <div className={`contenedor ${s.edicion}`}>
      <h1 className={s.lema}>{LEMA}</h1>
      <p className={s.fecha}>
        <time dateTime={comprobadoEn}>{fechaDeEdicion(comprobadoEn)}</time>
        <span aria-hidden="true"> · </span>
        <span>
          Catálogo comprobado{" "}
          <time dateTime={comprobadoEn}>
            <FechaRelativa instante={comprobadoEn} />
          </time>
        </span>
      </p>
    </div>
  );
}

/** «Solo publicamos salidas con fecha de Netflix, Max y SkyShowtime.» */
function coberturaTexto(prefijo: string, plataformas: Plataforma[]): string {
  const nombres = plataformas.map((p) => p.nombre);
  const lista =
    nombres.length > 1
      ? `${nombres.slice(0, -1).join(", ")} y ${nombres.at(-1)}`
      : (nombres[0] ?? "");
  return `${prefijo} ${lista}: las demás no las anuncian o todavía no las medimos.`;
}
