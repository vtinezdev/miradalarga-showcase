import { AlternarMiPlataforma } from "@/components/ui/AlternarMiPlataforma.tsx";
import { Enlace } from "@/components/ui/Enlace.tsx";
import { MarcaMia } from "@/components/ui/MarcaMia.tsx";
import { FreshnessStamp } from "@/components/ui/FreshnessStamp.tsx";
import { IconoDeMovimiento } from "@/components/ui/CatalogEvent.tsx";
import { IconoFlecha } from "@/components/ui/iconos.tsx";
import { PageHeader } from "@/components/ui/PageHeader.tsx";
import type { IndiceDePlataformas as Datos } from "@/features/catalogo/consultas-hubs.ts";
import {
  contarObras,
  rutaDeFicha,
  rutaDePlataforma,
} from "@/features/catalogo/formato.ts";
import { cx } from "@/lib/cx.ts";
import { FUENTE_DE_DISPONIBILIDAD } from "@/lib/sitio.ts";
import s from "./Plataformas.module.css";

/**
 * `/plataformas` (SCREENS.md §7): las seis como **filas grandes** de un índice,
 * no como una cuadrícula de logotipos. Cada una dice cuánto seguimos de ella,
 * qué se mueve, qué recomendamos de lo que tiene y qué no podemos saber de ella.
 * Nuestra tipografía, nunca su marca (BRAND.md §7).
 *
 * Mis plataformas: las tuyas llevan el punto latón **antes de hidratar** (CSS
 * del atributo de `<html>`) y cada fila permite añadirla o quitarla. No se
 * reordenan: resaltar es automático; mover, no.
 */
export function IndiceDePlataformas({ datos }: { datos: Datos }) {
  const validos = datos.plataformas.map((p) => p.plataforma.id);
  return (
    <>
      <PageHeader
        titulo="Qué ver en cada plataforma"
        entradilla={
          <p>
            Seguimos seis plataformas de streaming en España. De cada una, lo que
            recomendamos, lo que llega y lo que se va, con fecha de comprobación.
          </p>
        }
      >
        <FreshnessStamp
          instante={datos.comprobadoEn}
          fuente={FUENTE_DE_DISPONIBILIDAD}
        />
      </PageHeader>

      <section className={cx("contenedor", s.indice)} aria-labelledby="las-seis">
        <h2 id="las-seis" className="sr-only">
          Las seis plataformas
        </h2>
        <ul role="list" className={s.filas}>
          {datos.plataformas.map((p) => (
            <li key={p.plataforma.id}>
              <article className={s.fila} data-plataforma={p.plataforma.id}>
                <h3 className={s.nombre}>
                  <Enlace
                    href={rutaDePlataforma(p.plataforma)}
                    className={s.enlaceNombre}
                  >
                    <MarcaMia posicion="punto" />
                    {p.plataforma.nombre}
                    <MarcaMia posicion="texto" />
                    <IconoFlecha tamano="m" className={s.flecha} />
                  </Enlace>
                </h3>
                <div className={s.datos}>
                  <p className={s.recuento}>
                    {contarObras(p.recuento.pelicula, "pelicula")} y{" "}
                    {contarObras(p.recuento.serie, "serie")} disponibles hoy
                  </p>
                  <ul role="list" className={s.movimiento}>
                    <li data-tipo="llega">
                      <IconoDeMovimiento tipo="llega" />
                      {p.llegadasRecientes}{" "}
                      {p.llegadasRecientes === 1 ? "llegada" : "llegadas"} en 14 días
                    </li>
                    {p.limites.length === 0 || p.salidasProximas > 0 ? (
                      <li data-tipo="se-va">
                        <IconoDeMovimiento tipo="se-va" />
                        {p.salidasProximas}{" "}
                        {p.salidasProximas === 1
                          ? "salida anunciada"
                          : "salidas anunciadas"}
                      </li>
                    ) : null}
                  </ul>
                  {p.deNuestrasListas.length > 0 ? (
                    <p className={s.destacados}>
                      <span className={s.antetitulo}>De nuestras listas: </span>
                      {p.deNuestrasListas.map((t, i) => (
                        <span key={t.id}>
                          {i > 0 ? ", " : null}
                          <Enlace href={rutaDeFicha(t)}>{t.titulo}</Enlace>
                        </span>
                      ))}
                    </p>
                  ) : null}
                  {p.limites.length > 0 ? (
                    <ul role="list" className={s.limites}>
                      {p.limites.map((l) => (
                        <li key={l}>{l}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                <div className={s.accion}>
                  <AlternarMiPlataforma plataforma={p.plataforma} validos={validos} />
                </div>
              </article>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
