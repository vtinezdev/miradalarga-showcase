import type { ReactNode } from "react";
import { AvailabilityPanel } from "@/components/ui/AvailabilityPanel.tsx";
import { Breadcrumbs } from "@/components/ui/Breadcrumbs.tsx";
import { CatalogEvent } from "@/components/ui/CatalogEvent.tsx";
import { EditorialCard } from "@/components/ui/EditorialCard.tsx";
import { PosterCard } from "@/components/ui/PosterCard.tsx";
import { SectionHeader } from "@/components/ui/SectionHeader.tsx";
import { Signature } from "@/components/ui/Signature.tsx";
import { TitleImage } from "@/components/ui/TitleImage.tsx";
import type { VistaDeFicha } from "@/features/catalogo/consultas.ts";
import type {
  FichaDeTitulo as Ficha,
  TituloResumen,
} from "@/features/catalogo/modelo.ts";
import {
  anios,
  duracion,
  rutaDeLista,
  temporadas,
  tipoDeObra,
} from "@/features/catalogo/formato.ts";
import { fechaConAnio } from "@/lib/fechas.ts";
import { cx } from "@/lib/cx.ts";
import { datosEstructuradosDeFicha, jsonEnScript } from "./seo.ts";
import s from "./FichaDeTitulo.module.css";
import { Enlace } from "@/components/ui/Enlace.tsx";

/**
 * Ficha de título (SCREENS.md §2), la misma para películas y series.
 *
 * En diez segundos: qué es → **dónde verla** → si merece la pena. «Dónde verla»
 * va justo después de la cabecera en el HTML, así que el orden de lectura y de
 * tabulación es el mismo en móvil y en escritorio.
 *
 * Todo bloque sin dato **desaparece**: sin veredicto automático, sin sinopsis
 * traducida, sin «N/D» (CLAUDE.md, regla 7).
 */
export function FichaDeTitulo({
  vista,
  plataformasValidas,
}: {
  vista: VistaDeFicha;
  plataformasValidas: string[];
}) {
  const { ficha, veredicto, listas, relacionados, inicioDelRegistro } = vista;
  const conImagen = ficha.imagenes.fondo !== undefined;
  const seccion =
    ficha.tipo === "pelicula"
      ? { etiqueta: "Películas", href: "/peliculas" }
      : { etiqueta: "Series", href: "/series" };
  const ultimaSalida = ficha.movimientos.find((m) => m.tipo === "se-fue");

  return (
    <article className={s.ficha}>
      {datosEstructuradosDeFicha(vista).map((dato, i) => (
        <script
          key={i}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonEnScript(dato) }}
        />
      ))}

      {conImagen ? (
        <div className={s.banda}>
          <TitleImage
            titulo={ficha}
            imagen={ficha.imagenes.fondo}
            proporcion="fondo"
            sizes="100vw"
            prioridad
          />
        </div>
      ) : null}

      <div
        className={cx("contenedor", s.rejilla, conImagen ? s.conImagen : s.tipografica)}
      >
        <Breadcrumbs
          elementos={[
            { etiqueta: "Inicio", href: "/" },
            seccion,
            { etiqueta: ficha.titulo },
          ]}
        />

        <header className={s.cabecera}>
          {ficha.imagenes.poster ? (
            <TitleImage
              className={s.poster}
              titulo={ficha}
              imagen={ficha.imagenes.poster}
              proporcion="poster"
              sizes="(min-width: 64rem) 160px, 96px"
              prioridad={!conImagen}
            />
          ) : null}
          <div className={s.identidad}>
            <p className="etiqueta">{datosEsenciales(ficha)}</p>
            <h1 className={s.titulo}>{ficha.titulo}</h1>
            {ficha.tituloOriginal && ficha.tituloOriginal !== ficha.titulo ? (
              <p className={s.original}>
                Título original:{" "}
                <span lang={ficha.idiomaOriginal}>{ficha.tituloOriginal}</span>
              </p>
            ) : null}
            {ficha.generos.length > 0 ? (
              <p className={s.generos}>{ficha.generos.slice(0, 3).join(" · ")}</p>
            ) : null}
            {conImagen ? null : <span className={s.horizonte} aria-hidden="true" />}
          </div>
        </header>

        <div className={s.disponibilidad}>
          <AvailabilityPanel
            id="donde-ver"
            tituloDeLaObra={ficha.titulo}
            ofertas={ficha.ofertas}
            anuncios={ficha.anuncios}
            ultimaSalida={ultimaSalida}
            comprobadoEn={ficha.comprobadoEn}
            plataformasValidas={plataformasValidas}
          />
        </div>

        <div className={s.cuerpo}>
          {veredicto ? (
            <section
              className={s.veredicto}
              aria-labelledby="veredicto"
              data-folio="Por qué la recomendamos"
            >
              <h2 id="veredicto" className={cx("etiqueta", s.antetituloEditorial)}>
                Por qué la recomendamos
              </h2>
              {veredicto.entrada.etiqueta ? (
                <p className={s.etiquetaEditorial}>{veredicto.entrada.etiqueta}</p>
              ) : null}
              <blockquote className={s.cita}>
                <p>{veredicto.entrada.veredicto}</p>
              </blockquote>
              <p className={s.origen}>
                De la lista{" "}
                <Enlace href={rutaDeLista(veredicto.lista.slug)}>
                  {veredicto.lista.titulo}
                </Enlace>
              </p>
              <Signature
                autor={veredicto.lista.autor}
                revisada={veredicto.lista.revisada}
              />
              {veredicto.tambienEn.length > 0 ? (
                <p className={s.tambien}>
                  También en{" "}
                  {veredicto.tambienEn.map((l, i) => (
                    <span key={l.id}>
                      {i > 0 ? ", " : ""}
                      <Enlace href={rutaDeLista(l.slug)}>{l.titulo}</Enlace>
                    </span>
                  ))}
                </p>
              ) : null}
            </section>
          ) : null}

          {ficha.sinopsis ? (
            <section
              aria-labelledby="sinopsis"
              className={s.bloque}
              data-folio="Sinopsis"
            >
              <h2 id="sinopsis" className={s.h2}>
                Sinopsis
              </h2>
              <div className={s.sinopsis}>
                {ficha.sinopsis.split("\n\n").map((parrafo, i) => (
                  <p key={i}>{parrafo}</p>
                ))}
              </div>
            </section>
          ) : null}

          <InformacionUtil ficha={ficha} />

          <section
            aria-labelledby="movimiento"
            className={s.bloque}
            data-folio="Movimiento en el catálogo"
          >
            <h2 id="movimiento" className={s.h2}>
              Movimiento en el catálogo
            </h2>
            {ficha.movimientos.length > 0 ? (
              <ul role="list" className={s.movimientos}>
                {ficha.movimientos.map((m) => (
                  <li key={`${m.tipo}-${m.plataforma.id}-${m.fecha}`}>
                    <CatalogEvent movimiento={m} contexto="ficha" />
                  </li>
                ))}
              </ul>
            ) : null}
            <p className={s.notaRegistro}>
              Registramos cambios desde el{" "}
              <time dateTime={inicioDelRegistro}>
                {fechaConAnio(inicioDelRegistro)}
              </time>
              .
            </p>
          </section>
        </div>
      </div>

      {listas.length > 0 ? (
        <section
          className={cx("contenedor", s.seccion)}
          aria-labelledby="en-listas"
          data-folio="Aparece en estas listas"
        >
          <SectionHeader
            id="en-listas"
            tipo="editorial"
            antetitulo="Listas firmadas"
            titulo="Aparece en estas listas"
          />
          <ul role="list" className={s.listas}>
            {listas.map((l) => (
              <li key={l.id}>
                <EditorialCard
                  lista={l}
                  tamano="secundaria"
                  plataformasValidas={plataformasValidas}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Relacionados
        tipo={ficha.tipo}
        mismoDirector={relacionados.mismoDirector}
        mismasListas={relacionados.mismasListas}
      />
    </article>
  );
}

/** «PELÍCULA · 2019 · 1 h 58 min» / «SERIE · 2016–2022 · 3 temporadas · 24 episodios». */
function datosEsenciales(ficha: Ficha): string {
  const partes = [tipoDeObra(ficha.tipo), anios(ficha)];
  if (ficha.tipo === "pelicula" && ficha.duracionMinutos !== undefined)
    partes.push(duracion(ficha.duracionMinutos));
  const t = temporadas(ficha.temporadas, ficha.episodios);
  if (ficha.tipo === "serie" && t) partes.push(t);
  return partes.join(" · ");
}

function InformacionUtil({ ficha }: { ficha: Ficha }) {
  const audio = [...new Set(ficha.ofertas.flatMap((o) => o.idiomas?.audio ?? []))];
  const filas: [string, ReactNode][] = [];
  if (ficha.direccion.length > 0) {
    filas.push([
      ficha.tipo === "pelicula" ? "Dirección" : "Creación",
      ficha.direccion.join(", "),
    ]);
  }
  if (ficha.reparto.length > 0)
    filas.push(["Reparto", ficha.reparto.slice(0, 6).join(", ")]);
  if (ficha.tituloOriginal && ficha.tituloOriginal !== ficha.titulo) {
    filas.push([
      "Título original",
      <span key="o" lang={ficha.idiomaOriginal}>
        {ficha.tituloOriginal}
      </span>,
    ]);
  }
  if (ficha.tipo === "pelicula" && ficha.duracionMinutos !== undefined) {
    filas.push(["Duración", duracion(ficha.duracionMinutos)]);
  }
  const t = temporadas(ficha.temporadas, ficha.episodios);
  if (ficha.tipo === "serie" && t) filas.push(["Temporadas", t]);
  if (ficha.valoracion) {
    filas.push([
      "Valoración externa",
      <span key="v">
        <span className="cifras">{ficha.valoracion.valor}/100</span>
        <span className={s.atribucion}>
          {" "}
          · fuente: {ficha.valoracion.fuente}. No es una valoración nuestra.
        </span>
      </span>,
    ]);
  }
  if (audio.length > 0) filas.push(["Audio disponible", audio.join(", ")]);
  if (filas.length === 0) return null;
  return (
    <section
      aria-labelledby="informacion"
      className={s.bloque}
      data-folio="Información útil"
    >
      <h2 id="informacion" className={s.h2}>
        Información útil
      </h2>
      <dl className={s.datos}>
        {filas.map(([termino, valor]) => (
          <div key={termino} className={s.dato}>
            <dt>{termino}</dt>
            <dd>{valor}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Relacionados({
  tipo,
  mismoDirector,
  mismasListas,
}: {
  tipo: Ficha["tipo"];
  mismoDirector: TituloResumen[];
  mismasListas: TituloResumen[];
}) {
  if (mismoDirector.length === 0 && mismasListas.length === 0) return null;
  return (
    <section
      className={cx("contenedor", s.seccion)}
      aria-labelledby="relacionados"
      data-folio="Relacionados"
    >
      <SectionHeader id="relacionados" titulo="Relacionados" />
      {mismoDirector.length > 0 ? (
        <div className={s.grupoRelacionado}>
          <h3 className={s.h3}>
            {tipo === "pelicula" ? "De la misma dirección" : "De la misma creación"}
          </h3>
          <ul role="list" className={s.posters}>
            {mismoDirector.map((t) => (
              <li key={t.id}>
                <PosterCard titulo={t} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {mismasListas.length > 0 ? (
        <div className={s.grupoRelacionado}>
          <h3 className={s.h3}>En las mismas listas</h3>
          <ul role="list" className={s.posters}>
            {mismasListas.map((t) => (
              <li key={t.id}>
                <PosterCard titulo={t} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
