import type { Anuncio, Movimiento, Oferta } from "@/features/catalogo/modelo.ts";
import { agruparOfertas } from "@/features/catalogo/reglas.ts";
import { FUENTE_DE_DISPONIBILIDAD } from "@/lib/sitio.ts";
import { AvailabilityRow } from "./AvailabilityRow.tsx";
import { CatalogEvent } from "./CatalogEvent.tsx";
import { FreshnessStamp } from "./FreshnessStamp.tsx";
import { InvitacionMisPlataformas } from "./InvitacionMisPlataformas.tsx";
import { OfertasOrdenadas } from "./OfertasOrdenadas.tsx";
import s from "./AvailabilityPanel.module.css";

/**
 * «Dónde verla»: la respuesta de los diez segundos (PRODUCT.md §5).
 *
 * Servidor por defecto; la única isla es el reordenado por Mis plataformas.
 * Pie fijo con la fecha de comprobación y la fuente (docs/SEO.md, E-E-A-T).
 */
export function AvailabilityPanel({
  id,
  tituloDeLaObra,
  ofertas,
  anuncios,
  ultimaSalida,
  comprobadoEn,
  plataformasValidas,
}: {
  id: string;
  tituloDeLaObra: string;
  ofertas: readonly Oferta[];
  anuncios: readonly Anuncio[];
  ultimaSalida: Movimiento | undefined;
  comprobadoEn: string;
  plataformasValidas: string[];
}) {
  const grupos = agruparOfertas(ofertas);
  return (
    <section className={s.panel} aria-labelledby={id} data-folio="Dónde verla">
      <h2 id={id} className={s.titulo}>
        Dónde ver {tituloDeLaObra}
      </h2>

      {grupos.length > 0 ? (
        <OfertasOrdenadas
          className={s.grupos}
          validos={plataformasValidas}
          grupos={grupos.map((g) => ({
            plataformaId: g.plataforma.id,
            nodo: <AvailabilityRow plataforma={g.plataforma} ofertas={g.ofertas} />,
          }))}
        />
      ) : (
        <div className={s.vacio}>
          <p>Ahora mismo no está en ninguna de las seis plataformas que seguimos.</p>
          {ultimaSalida ? (
            <CatalogEvent movimiento={ultimaSalida} contexto="ficha" />
          ) : null}
        </div>
      )}

      {anuncios.length > 0 ? (
        <ul role="list" className={s.anuncios} aria-label="Llegadas anunciadas">
          {anuncios.map((a) => (
            <li key={`${a.plataforma.id}-${a.tipo}`}>
              <CatalogEvent
                movimiento={{
                  tipo: "proximamente",
                  tituloId: "",
                  plataforma: a.plataforma,
                  fecha: a.fecha,
                }}
              />
            </li>
          ))}
        </ul>
      ) : null}

      <footer className={s.pie}>
        <FreshnessStamp instante={comprobadoEn} fuente={FUENTE_DE_DISPONIBILIDAD} />
        {grupos.length > 0 ? (
          <InvitacionMisPlataformas texto="¿Cuáles tienes? Márcalas y te lo decimos" />
        ) : null}
      </footer>
    </section>
  );
}
