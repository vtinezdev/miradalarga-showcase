import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { obtenerFicha, obtenerMarco } from "@/features/catalogo/consultas.ts";
import type { TipoDeObra } from "@/features/catalogo/modelo.ts";
import { FichaDeTitulo } from "./FichaDeTitulo.tsx";
import { metadatosDeFicha } from "./seo.ts";

/**
 * Las dos rutas de ficha (`/peliculas/[slug]` y `/series/[slug]`, docs/SEO.md)
 * son la misma pantalla con un tipo fijado. Cada `page.tsx` es una línea que
 * llama a estas funciones: una sola implementación, dos URLs canónicas.
 */

interface Params {
  params: Promise<{ slug: string }>;
}

export function metadatos(tipo: TipoDeObra) {
  return async ({ params }: Params): Promise<Metadata> => {
    const { slug } = await params;
    const vista = await obtenerFicha(tipo, slug);
    return vista ? metadatosDeFicha(vista) : {};
  };
}

export function pagina(tipo: TipoDeObra) {
  return async function Ficha({ params }: Params) {
    const { slug } = await params;
    // En paralelo: la ficha y el marco no dependen una del otro.
    const [vista, marco] = await Promise.all([
      obtenerFicha(tipo, slug),
      obtenerMarco(),
    ]);
    if (!vista) notFound();
    return (
      <FichaDeTitulo
        vista={vista}
        plataformasValidas={marco.plataformas.map((p) => p.id)}
      />
    );
  };
}
