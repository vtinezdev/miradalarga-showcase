import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { obtenerMarco } from "@/features/catalogo/consultas.ts";
import { obtenerHubDePlataforma } from "@/features/catalogo/consultas-hubs.ts";
import { HubDePlataforma } from "@/features/plataformas/HubDePlataforma.tsx";

// Segment config explícito (CLAUDE.md, regla 10): seis hubs, todos
// pre-renderizados (no es el catálogo, regla 11). Un slug desconocido, 404.
export const dynamic = "force-static";
export const dynamicParams = false;

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams() {
  const { plataformas } = await obtenerMarco();
  return plataformas.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const datos = await obtenerHubDePlataforma((await params).slug);
  if (!datos) return {};
  const nombre = datos.plataforma.nombre;
  return {
    title: `Qué ver en ${nombre}`,
    description: `Lo mejor de ${nombre} según nuestras listas firmadas, lo que acaba de llegar y lo que se va pronto de ${nombre} en España, con fecha de comprobación.`,
    alternates: { canonical: `/plataformas/${datos.plataforma.slug}` },
  };
}

export default async function Page({ params }: Props) {
  const { slug } = await params;
  const [datos, marco] = await Promise.all([
    obtenerHubDePlataforma(slug),
    obtenerMarco(),
  ]);
  if (!datos) notFound();
  return (
    <HubDePlataforma
      datos={datos}
      plataformasValidas={marco.plataformas.map((p) => p.id)}
    />
  );
}
