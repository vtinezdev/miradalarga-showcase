import type { CSSProperties } from "react";
import indice from "@/components/ui/IndiceInvertido.module.css";
import { DatosEstructurados } from "@/components/ui/DatosEstructurados.tsx";
import { Enlace } from "@/components/ui/Enlace.tsx";
import { PageHeader } from "@/components/ui/PageHeader.tsx";
import { RecuentoMisPlataformas } from "@/components/ui/RecuentoMisPlataformas.tsx";
import { Signature } from "@/components/ui/Signature.tsx";
import { TitleImage } from "@/components/ui/TitleImage.tsx";
import type { IndiceDeListas as Datos } from "@/features/catalogo/consultas-listas.ts";
import { contarTitulos, rutaDeLista } from "@/features/catalogo/formato.ts";
import { fechaCorta } from "@/lib/fechas.ts";
import { URL_BASE } from "@/lib/sitio.ts";
import { cx } from "@/lib/cx.ts";
import s from "./IndiceDeListas.module.css";

/**
 * `/listas`: responde «¿qué selecciones ha hecho Mirada Larga?». No es una
 * parrilla de tarjetas: es el **sumario de una edición**, numerado, de la lista
 * revisada más recientemente a la más antigua, con firma, fecha y estado vivo.
 * Cada entrada es un **índice invertido** (firma 3): al señalarla se vuelve
 * papel y el número toma cuerpo.
 */
export function IndiceDeListas({
  datos,
  plataformasValidas,
}: {
  datos: Datos;
  plataformasValidas: string[];
}) {
  const ultima = datos.listas[0]?.revisada;
  return (
    <>
      <DatosEstructurados
        datos={[
          {
            "@context": "https://schema.org",
            "@type": "ItemList",
            name: "Listas firmadas de Mirada Larga",
            numberOfItems: datos.listas.length,
            itemListElement: datos.listas.map((l, i) => ({
              "@type": "ListItem",
              position: i + 1,
              name: l.titulo,
              url: `${URL_BASE}${rutaDeLista(l.slug)}`,
            })),
          },
        ]}
      />
      <PageHeader
        tipo="editorial"
        antetitulo="Listas firmadas"
        titulo="Listas"
        entradilla={
          <p>
            Selecciones hechas a mano, firmadas y revisadas. Cada título lleva un
            veredicto: por qué merece la pena y para quién no es.
          </p>
        }
      >
        <span>
          {datos.listas.length} listas firmadas por {datos.autores}{" "}
          {datos.autores === 1 ? "persona" : "personas"}
          {ultima ? (
            <>
              {" "}
              · última revisión el <time dateTime={ultima}>{fechaCorta(ultima)}</time>
            </>
          ) : null}
        </span>
      </PageHeader>

      <section
        className={cx("contenedor", s.seccion)}
        aria-labelledby="indice-de-listas"
      >
        <h2 id="indice-de-listas" className="sr-only">
          Índice de listas
        </h2>
        <ol role="list" className={s.indice}>
          {datos.listas.map((l, i) => (
            <li key={l.id} style={{ "--i": i } as CSSProperties}>
              <article className={cx(s.entrada, indice.invertible)}>
                <span className={cx(s.numero, indice.ordinal)} aria-hidden="true">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div className={s.textos}>
                  {l.id === datos.destacadaId ? (
                    <p className={cx("etiqueta", s.destacada)}>
                      Selección de la semana
                    </p>
                  ) : null}
                  <h3 className={s.titulo}>
                    <Enlace href={rutaDeLista(l.slug)}>{l.titulo}</Enlace>
                  </h3>
                  <p className={s.entradilla}>{l.entradilla}</p>
                  <p className={s.estado}>
                    {contarTitulos(l.numeroDeTitulos)} · {l.disponiblesHoy} disponibles
                    hoy
                    <RecuentoMisPlataformas
                      plataformasPorTitulo={l.plataformasPorTitulo}
                      validos={plataformasValidas}
                    />
                  </p>
                  <Signature
                    autor={l.autor}
                    revisada={l.revisada}
                    className={s.firma}
                  />
                </div>
                <div className={s.portada} aria-hidden="true">
                  {l.portada.map((t) => (
                    <TitleImage
                      key={t.id}
                      className={s.poster}
                      titulo={t}
                      imagen={t.imagenes.poster}
                      proporcion="poster"
                      sizes="72px"
                    />
                  ))}
                </div>
              </article>
            </li>
          ))}
        </ol>
      </section>

      <aside
        className={cx("contenedor", s.criterio)}
        aria-labelledby="como-las-hacemos"
      >
        <h2 id="como-las-hacemos" className={s.h2}>
          Cómo hacemos las listas
        </h2>
        <p>
          Cada lista la firma una persona que ha visto enteros todos sus títulos.
          Ninguno entra por su valoración externa ni por su popularidad, y ninguna
          plataforma paga por aparecer. Las revisamos a menudo: si un título deja de
          estar disponible, se queda en su sitio, atenuado y con la fecha en que salió.
        </p>
        <p>
          Los rankings automáticos son otra cosa, con su propia metodología:{" "}
          <Enlace href="/metodologia" className="enlace">
            así los calculamos
          </Enlace>
          .
        </p>
      </aside>
    </>
  );
}
