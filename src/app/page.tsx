import type { Metadata } from "next";
import { obtenerPortada } from "@/features/catalogo/consultas.ts";
import { Portada } from "@/features/portada/Portada.tsx";
import { DESCRIPCION, LEMA, NOMBRE } from "@/lib/sitio.ts";

// Estática (CLAUDE.md, regla 10): vinext no lo infiere y sin declararlo la ruta
// quedaría `? Unknown` y se renderizaría en cada petición. Cuando lea de Neon,
// los jobs la invalidarán con `revalidateTag` (ADR 0002).
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: { absolute: `${NOMBRE}: ${LEMA.toLowerCase()}` },
  description: DESCRIPCION,
  alternates: { canonical: "/" },
};

export default async function Page() {
  const datos = await obtenerPortada();
  return (
    <>
      <script
        type="application/ld+json"
        // Datos estructurados del sitio (docs/SEO.md): `WebSite` + `SearchAction`
        // hacia `/buscar`, que ya existe.
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "WebSite",
            name: NOMBRE,
            description: DESCRIPCION,
            inLanguage: "es-ES",
            url: "https://miradalarga.com/",
            potentialAction: {
              "@type": "SearchAction",
              target: {
                "@type": "EntryPoint",
                urlTemplate: "https://miradalarga.com/buscar?q={search_term_string}",
              },
              "query-input": "required name=search_term_string",
            },
          }),
        }}
      />
      <Portada datos={datos} />
    </>
  );
}
