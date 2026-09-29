import { EditorialCard } from "@/components/ui/EditorialCard.tsx";
import { EmptyState } from "@/components/ui/EmptyState.tsx";
import { Enlace } from "@/components/ui/Enlace.tsx";
import { SearchInput } from "@/components/ui/SearchInput.tsx";
import { SectionHeader } from "@/components/ui/SectionHeader.tsx";
import { TitleRow } from "@/components/ui/TitleRow.tsx";
import { resaltar } from "@/features/catalogo/busqueda.ts";
import type { VistaDeBusqueda } from "@/features/catalogo/consultas-busqueda.ts";
import { MAXIMO_DE_RESULTADOS } from "@/features/catalogo/consultas-busqueda.ts";
import { ResultadosFiltrables } from "./ResultadosFiltrables.tsx";
import s from "./Busqueda.module.css";

const ACCESOS = [
  { href: "/listas", etiqueta: "Listas firmadas" },
  { href: "/peliculas", etiqueta: "Películas" },
  { href: "/series", etiqueta: "Series" },
  { href: "/radar", etiqueta: "Radar del catálogo" },
];

/**
 * `/buscar` (SCREENS.md §6): el campo es la página. Cuatro estados: sin
 * consulta (por dónde empezar), consulta demasiado corta, resultados agrupados
 * por Películas y Series, y sin resultados —un mensaje honesto, nunca una
 * llamada externa para «encontrarlo» (CLAUDE.md, regla 1)—.
 */
export function Busqueda({
  vista,
  filtrosIniciales,
}: {
  vista: VistaDeBusqueda;
  /** La query que vio el servidor, para que el HTML llegue ya filtrado. */
  filtrosIniciales: string;
}) {
  const { consulta, estado } = vista;
  return (
    <div className={`contenedor ${s.busqueda}`}>
      <h1 className="sr-only">
        {estado === "resultados" || estado === "sin-resultados"
          ? `Buscar «${consulta}»`
          : "Buscar"}
      </h1>
      <SearchInput
        id="buscar"
        grande
        valorInicial={consulta}
        autoFocus={estado === "sin-consulta"}
        className={s.campo}
      />

      {estado === "sin-consulta" ? (
        <p className={s.ayuda}>
          Busca por título, en español o en su idioma original. Buscamos solo en el
          catálogo que seguimos: seis plataformas en España.
        </p>
      ) : null}
      {estado === "corta" ? (
        <p className={s.ayuda} role="status">
          Escribe al menos dos letras para buscar.
        </p>
      ) : null}

      {estado === "resultados" ? (
        <>
          <p className={s.recuento} role="status">
            <strong className="cifras">{vista.total}</strong>{" "}
            {vista.total === 1 ? "resultado" : "resultados"} para «{consulta}»
            {vista.total > MAXIMO_DE_RESULTADOS
              ? `. Mostramos los ${MAXIMO_DE_RESULTADOS} primeros: afina la búsqueda para ver el resto.`
              : ""}
          </p>
          <ResultadosFiltrables
            inicial={filtrosIniciales}
            plataformas={vista.plataformas}
            resultados={vista.resultados.map((r) => ({
              clave: r.titulo.id,
              obra: r.titulo.tipo,
              plataformas: [
                ...new Set(r.titulo.disponibilidad.map((o) => o.plataforma.id)),
              ],
              nodo: (
                <TitleRow
                  titulo={r.titulo}
                  resaltado={
                    r.tituloOriginal ? undefined : (
                      <Resaltado texto={r.titulo.titulo} consulta={consulta} />
                    )
                  }
                  nota={
                    <Nota
                      tituloOriginal={r.tituloOriginal}
                      consulta={consulta}
                      enListas={r.enListas}
                    />
                  }
                />
              ),
            }))}
          />
        </>
      ) : null}

      {estado === "sin-resultados" ? (
        <EmptyState
          titulo={`No tenemos «${consulta}» en el catálogo`}
          explicacion={
            <>
              <p>
                Seguimos unos miles de títulos elegidos en seis plataformas, no todo lo
                que existe.
              </p>
              <p>
                Revisa la ortografía o prueba con el título original: buscamos en los
                dos.
              </p>
            </>
          }
          acciones={ACCESOS}
        />
      ) : null}

      {estado !== "resultados" && vista.sugeridas.length > 0 ? (
        <section className={s.sugeridas} aria-labelledby="por-donde-empezar">
          <SectionHeader
            id="por-donde-empezar"
            tipo="editorial"
            antetitulo="Listas firmadas"
            titulo={
              estado === "sin-resultados" ? "O empieza por aquí" : "Por dónde empezar"
            }
            enlace={{ etiqueta: "Ver todas las listas", href: "/listas" }}
          />
          {estado === "sin-consulta" || estado === "corta" ? (
            <nav aria-label="Secciones" className={s.accesos}>
              <ul role="list">
                {ACCESOS.map((a) => (
                  <li key={a.href}>
                    <Enlace href={a.href}>{a.etiqueta}</Enlace>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
          <ul role="list" className={s.listas}>
            {vista.sugeridas.map((l) => (
              <li key={l.id}>
                <EditorialCard
                  lista={l}
                  tamano="secundaria"
                  plataformasValidas={vista.plataformas.map((p) => p.id)}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function Resaltado({ texto, consulta }: { texto: string; consulta: string }) {
  return (
    <>
      {resaltar(texto, consulta).map((t, i) =>
        t.resaltado ? <mark key={i}>{t.texto}</mark> : <span key={i}>{t.texto}</span>,
      )}
    </>
  );
}

function Nota({
  tituloOriginal,
  consulta,
  enListas,
}: {
  tituloOriginal: string | undefined;
  consulta: string;
  enListas: number;
}) {
  if (!tituloOriginal && enListas === 0) return null;
  return (
    <>
      {tituloOriginal ? (
        <span>
          Título original: <Resaltado texto={tituloOriginal} consulta={consulta} />
        </span>
      ) : null}
      {tituloOriginal && enListas > 0 ? " · " : null}
      {enListas > 0 ? (
        <span className={s.enListas}>
          En {enListas} {enListas === 1 ? "lista" : "listas"}
        </span>
      ) : null}
    </>
  );
}
