import type { Plataforma } from "@/features/catalogo/modelo.ts";
import { fechaConAnio, hora } from "@/lib/fechas.ts";
import { CONFIANZA } from "@/lib/navegacion.ts";
import { FUENTE_DE_DISPONIBILIDAD, LEMA, NOMBRE } from "@/lib/sitio.ts";
import s from "./Footer.module.css";
import { Enlace } from "./Enlace.tsx";

/**
 * Pie (DS §8.1): confianza, plataformas, **atribución de la fuente** y fecha de
 * la última sincronización. Con datos de desarrollo, lo dice sin rodeos.
 */
export function Footer({
  plataformas,
  comprobadoEn,
  datosDeDesarrollo,
}: {
  plataformas: Plataforma[];
  comprobadoEn: string;
  datosDeDesarrollo: boolean;
}) {
  return (
    <footer className={s.pie}>
      <div className={`contenedor ${s.rejilla}`}>
        <div className={s.marca}>
          <p className={s.nombre}>{NOMBRE}</p>
          <p className={s.lema}>{LEMA}.</p>
        </div>
        <nav aria-label="Plataformas" className={s.columna}>
          <p className="etiqueta">Plataformas</p>
          <ul role="list">
            {plataformas.map((p) => (
              <li key={p.id}>
                <Enlace href={`/plataformas/${p.slug}`}>{p.nombre}</Enlace>
              </li>
            ))}
          </ul>
        </nav>
        <nav aria-label="Sobre Mirada Larga" className={s.columna}>
          <p className="etiqueta">Mirada Larga</p>
          <ul role="list">
            {CONFIANZA.map((c) => (
              <li key={c.href}>
                <Enlace href={c.href}>{c.etiqueta}</Enlace>
              </li>
            ))}
          </ul>
        </nav>
        <div className={s.atribucion}>
          <p>
            Datos de disponibilidad: {FUENTE_DE_DISPONIBILIDAD}. Última sincronización:{" "}
            <time dateTime={comprobadoEn}>
              {fechaConAnio(comprobadoEn)}, {hora(comprobadoEn)}
            </time>
            .
          </p>
          <p>Las valoraciones que mostramos son externas y se atribuyen a su fuente.</p>
          {datosDeDesarrollo ? (
            <p className={s.desarrollo}>
              Entorno de desarrollo: los títulos, fechas y ofertas de esta página son
              ficticios.
            </p>
          ) : null}
        </div>
      </div>
    </footer>
  );
}
