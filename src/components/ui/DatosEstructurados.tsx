import { jsonEnScript } from "@/lib/datos-estructurados.ts";

/** Datos estructurados JSON-LD de una página (docs/SEO.md). Nunca `aggregateRating`. */
export function DatosEstructurados({ datos }: { datos: readonly object[] }) {
  return (
    <>
      {datos.map((dato, i) => (
        <script
          key={i}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonEnScript(dato) }}
        />
      ))}
    </>
  );
}
