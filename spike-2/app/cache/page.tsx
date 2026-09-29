import { unstable_cache } from "next/cache";

// Cache con etiqueta: es lo que §5 necesita (revalidateTag disparado por los jobs).
export const metadata = { title: "Cache" };

const leerConCache = unstable_cache(
  async () => ({ calculadoEn: new Date().toISOString() }),
  ["spike-cache"],
  { tags: ["spike"], revalidate: 3600 },
);

export default async function Pagina() {
  const dato = await leerConCache();
  return (
    <section>
      <h1>Cache etiquetada</h1>
      <p data-prueba="cache-calculado-en">{dato.calculadoEn}</p>
      <p data-prueba="cache-renderizado-en">{new Date().toISOString()}</p>
    </section>
  );
}
