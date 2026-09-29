"use client";

import { useMisPlataformas } from "@/features/mis-plataformas/estado.ts";

/**
 * «· 3 en tus plataformas». Solo existe en el cliente y solo con selección: en
 * el servidor no se sabe qué plataformas tienes, y no se inventa.
 */
export function RecuentoMisPlataformas({
  plataformasPorTitulo,
  validos,
}: {
  plataformasPorTitulo: string[][];
  validos: string[];
}) {
  const { seleccion } = useMisPlataformas(validos);
  if (seleccion.length === 0) return null;
  const mias = new Set(seleccion);
  const cuantos = plataformasPorTitulo.filter((ids) =>
    ids.some((id) => mias.has(id)),
  ).length;
  return <> · {cuantos} en tus plataformas</>;
}
