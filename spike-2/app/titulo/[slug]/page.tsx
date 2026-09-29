import { notFound } from "next/navigation";

// RUTA DINAMICA con params. generateStaticParams + generateMetadata:
// los dos puntos que el plan §6 (D6) quiere observar en Workers.
const SLUGS = ["uno", "dos", "tres"] as const;

export function generateStaticParams() {
  return SLUGS.map((slug) => ({ slug }));
}

export const dynamicParams = true;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return {
    title: `Titulo ${slug}`,
    description: `Ficha desechable del slug ${slug}.`,
    openGraph: { title: `Titulo ${slug}` },
    alternates: { canonical: `/titulo/${slug}` },
  };
}

export default async function Pagina({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (slug.length > 40) notFound();
  return (
    <section>
      <h1>Titulo: {slug}</h1>
      <p data-prueba="titulo-generada-en">{new Date().toISOString()}</p>
      <p>Prerenderizado en build: {SLUGS.includes(slug as (typeof SLUGS)[number]) ? "se esperaba si" : "no (dynamicParams)"}</p>
    </section>
  );
}
