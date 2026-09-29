import { DatosEstructurados } from "@/components/ui/DatosEstructurados.tsx";
import { EditorialCard } from "@/components/ui/EditorialCard.tsx";
import { EditorialEntry } from "@/components/ui/EditorialEntry.tsx";
import { FreshnessStamp } from "@/components/ui/FreshnessStamp.tsx";
import { PageHeader } from "@/components/ui/PageHeader.tsx";
import { RailEditorial } from "@/components/ui/RailEditorial.tsx";
import { RecuentoMisPlataformas } from "@/components/ui/RecuentoMisPlataformas.tsx";
import { SectionHeader } from "@/components/ui/SectionHeader.tsx";
import { Signature } from "@/components/ui/Signature.tsx";
import { SoloEnMisPlataformas } from "@/components/ui/SoloEnMisPlataformas.tsx";
import type { VistaDeLista } from "@/features/catalogo/consultas-listas.ts";
import { contarTitulos } from "@/features/catalogo/formato.ts";
import { fechaConAnio } from "@/lib/fechas.ts";
import { cx } from "@/lib/cx.ts";
import { FUENTE_DE_DISPONIBILIDAD } from "@/lib/sitio.ts";
import { datosEstructuradosDeLista } from "./seo.ts";
import s from "./PaginaDeLista.module.css";

/**
 * Una lista editorial (SCREENS.md §5): contenido firmado, no un filtro de la
 * base. Cabecera con firma y estado vivo, introducción, «Cómo la hemos hecho»,
 * las entradas en el orden del autor —con su veredicto— y otras listas.
 *
 * El conmutador «Solo en mis plataformas» está apagado por defecto: el HTML
 * servido es la lista entera.
 */
export function PaginaDeLista({
  vista,
  plataformasValidas,
}: {
  vista: VistaDeLista;
  plataformasValidas: string[];
}) {
  const { lista, tarjeta, entradas, otras, comprobadoEn } = vista;
  const parrafos = lista.introduccion?.split(/\n{2,}/).filter(Boolean) ?? [];
  return (
    <article>
      <DatosEstructurados datos={datosEstructuradosDeLista(vista)} />

      <PageHeader
        tipo="editorial"
        tamano="lista"
        antetitulo="Lista editorial"
        titulo={lista.titulo}
        migas={[
          { etiqueta: "Inicio", href: "/" },
          { etiqueta: "Listas", href: "/listas" },
          { etiqueta: lista.titulo },
        ]}
        entradilla={<p>{lista.entradilla}</p>}
      >
        <Signature autor={lista.autor} revisada={lista.revisada} />
        <span>
          {contarTitulos(tarjeta.numeroDeTitulos)} · {tarjeta.disponiblesHoy}{" "}
          disponibles hoy
          <RecuentoMisPlataformas
            plataformasPorTitulo={tarjeta.plataformasPorTitulo}
            validos={plataformasValidas}
          />
        </span>
        <FreshnessStamp instante={comprobadoEn} fuente={FUENTE_DE_DISPONIBILIDAD} />
      </PageHeader>

      {parrafos.length > 0 || lista.criterio ? (
        <div className={cx("contenedor", s.introduccion)}>
          {parrafos.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
          {lista.criterio ? (
            <details className={s.criterio}>
              <summary>Cómo la hemos hecho</summary>
              <p>{lista.criterio}</p>
              <p className={s.publicada}>
                Publicada el{" "}
                <time dateTime={lista.publicada}>{fechaConAnio(lista.publicada)}</time>.
              </p>
            </details>
          ) : null}
        </div>
      ) : null}

      <section
        className={cx("contenedor", s.entradas)}
        aria-label="Títulos de la lista"
      >
        <SoloEnMisPlataformas
          etiqueta={`Títulos de «${lista.titulo}», en el orden de la lista`}
          validos={plataformasValidas}
          nombre="entradas"
          elementos={entradas.map(({ entrada, titulo }) => ({
            clave: `${entrada.orden}-${titulo.id}`,
            plataformas: [
              ...new Set(titulo.disponibilidad.map((o) => o.plataforma.id)),
            ],
            nodo: <EditorialEntry entrada={entrada} titulo={titulo} />,
          }))}
        />
      </section>

      {otras.length > 0 ? (
        <section
          className={cx("contenedor", s.otras)}
          aria-labelledby="otras-listas"
          data-folio="Otras listas"
        >
          <SectionHeader
            id="otras-listas"
            tipo="editorial"
            antetitulo="Listas firmadas"
            titulo="Otras listas"
            enlace={{ etiqueta: `Ver las ${otras.length + 1} listas`, href: "/listas" }}
          />
          <RailEditorial
            etiqueta="Otras listas"
            elementos={otras.map((l) => ({
              id: l.id,
              nodo: (
                <EditorialCard
                  lista={l}
                  tamano="columna"
                  plataformasValidas={plataformasValidas}
                />
              ),
            }))}
          />
        </section>
      ) : null}
    </article>
  );
}
