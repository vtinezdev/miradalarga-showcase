import { FilaDeMovimiento } from "@/components/ui/FilaDeMovimiento.tsx";
import { FreshnessStamp } from "@/components/ui/FreshnessStamp.tsx";
import { PageHeader } from "@/components/ui/PageHeader.tsx";
import type { VistaDeRadar } from "@/features/catalogo/consultas-radar.ts";
import { diaEnMadrid, fechaConAnio } from "@/lib/fechas.ts";
import { FUENTE_DE_DISPONIBILIDAD } from "@/lib/sitio.ts";
import { RadarDelCatalogo, type FilaDelRadar } from "./RadarDelCatalogo.tsx";

/**
 * `/radar` (SCREENS.md §4). El servidor pinta cada fila una vez; la isla decide
 * cuáles se ven según los filtros de la URL. «Hoy» es el día de la edición, que
 * el servidor conoce: el nombre relativo lo pone el navegador.
 */
export function Radar({ vista }: { vista: VistaDeRadar }) {
  const filas: FilaDelRadar[] = vista.filas.map((f) => ({
    clave: `${f.movimiento.tipo}-${f.titulo.id}-${f.movimiento.plataforma.id}-${f.movimiento.fecha}`,
    tipo: f.movimiento.tipo,
    plataforma: f.movimiento.plataforma.id,
    obra: f.titulo.tipo,
    dia: diaEnMadrid(f.movimiento.fecha),
    enListas: f.enListas,
    nodo: <FilaDeMovimiento fila={f} />,
  }));
  return (
    <>
      <PageHeader
        titulo="Radar del catálogo"
        entradilla={
          <p>
            Qué llega, qué se va y qué se anuncia en las seis plataformas que seguimos.
            Actualizado cada día; registramos cambios desde el{" "}
            <time dateTime={vista.inicioDelRegistro}>
              {fechaConAnio(vista.inicioDelRegistro)}
            </time>
            .
          </p>
        }
      >
        <FreshnessStamp
          instante={vista.comprobadoEn}
          fuente={FUENTE_DE_DISPONIBILIDAD}
        />
      </PageHeader>
      <RadarDelCatalogo
        filas={filas}
        hoy={diaEnMadrid(vista.comprobadoEn)}
        desde={vista.desde}
        hasta={vista.hasta}
        plataformas={vista.plataformas}
        capacidades={vista.capacidades}
      />
    </>
  );
}
