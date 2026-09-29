"use client";

import { useSyncExternalStore } from "react";
import { diaCercano, diaConSemana, mediodia } from "@/lib/fechas.ts";

// La fecha de hoy no avisa cuando cambia: basta con leerla al hidratar.
function sinSuscripcion() {
  return () => {
    /* nada que desuscribir */
  };
}

const MAYUSCULA = { hoy: "Hoy", ayer: "Ayer", mañana: "Mañana" } as const;

/**
 * El nombre de un día de la regla del radar: «Hoy», «Ayer», «Mañana» o «sáb 27
 * sep». Como `FechaRelativa`, el servidor escribe siempre la forma absoluta (el
 * HTML se cachea) y el navegador, que sabe qué día es, pone la relativa.
 */
export function EtiquetaDeDia({
  dia,
  conFecha = false,
}: {
  dia: string;
  /** «Hoy, dom 28 sep» en vez de «Hoy»: para el titular de un día del diario. */
  conFecha?: boolean;
}) {
  const absoluta = diaConSemana(mediodia(dia));
  return useSyncExternalStore(
    sinSuscripcion,
    () => {
      const cercano = diaCercano(dia, new Date());
      if (!cercano) return absoluta;
      return conFecha ? `${MAYUSCULA[cercano]}, ${absoluta}` : MAYUSCULA[cercano];
    },
    () => absoluta,
  );
}
