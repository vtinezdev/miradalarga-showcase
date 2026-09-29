import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { obtenerMarco } from "@/features/catalogo/consultas.ts";
import {
  obtenerLista,
  obtenerSlugsDeListas,
} from "@/features/catalogo/consultas-listas.ts";
import { PaginaDeLista } from "@/features/listas/PaginaDeLista.tsx";
import { metadatosDeLista } from "@/features/listas/seo.ts";

// Segment config explícito (CLAUDE.md, regla 10). Las listas son pocas (20–30
// en el MVP) y todas se pre-renderizan: no es el catálogo (regla 11). Un slug
// desconocido es un 404 real.
export const dynamic = "force-static";
export const dynamicParams = false;

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams() {
  return (await obtenerSlugsDeListas()).map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const vista = await obtenerLista((await params).slug);
  return vista ? metadatosDeLista(vista) : {};
}

export default async function Page({ params }: Props) {
  const { slug } = await params;
  const [vista, marco] = await Promise.all([obtenerLista(slug), obtenerMarco()]);
  if (!vista) notFound();
  return (
    <PaginaDeLista
      vista={vista}
      plataformasValidas={marco.plataformas.map((p) => p.id)}
    />
  );
}
