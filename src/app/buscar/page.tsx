import type { Metadata } from "next";
import { limpiarConsulta } from "@/features/catalogo/busqueda.ts";
import { obtenerBusqueda } from "@/features/catalogo/consultas-busqueda.ts";
import { Busqueda } from "@/features/busqueda/Busqueda.tsx";

// Dinámica a propósito: cada búsqueda enviada es una invocación del Worker (sin
// autocompletado en vivo, ADR 0002). `noindex` siempre y bloqueada en
// `robots.txt` (docs/SEO.md). Solo lee nuestro catálogo: nunca sale a una API
// externa, ni cuando no encuentra nada (CLAUDE.md, regla 1).
export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const consulta = limpiarConsulta((await searchParams).q);
  return {
    title: consulta ? `Buscar «${consulta}»` : "Buscar",
    description: "Busca una película o serie y mira dónde verla hoy en España.",
    robots: { index: false, follow: true },
    alternates: { canonical: "/buscar" },
  };
}

export default async function Page({ searchParams }: Props) {
  const parametros = await searchParams;
  const vista = await obtenerBusqueda(limpiarConsulta(parametros.q));
  const query = new URLSearchParams();
  for (const clave of ["q", "obra", "plataforma"]) {
    const valor = parametros[clave];
    if (typeof valor === "string") query.set(clave, valor);
  }
  const texto = query.toString();
  return <Busqueda vista={vista} filtrosIniciales={texto ? `?${texto}` : ""} />;
}
