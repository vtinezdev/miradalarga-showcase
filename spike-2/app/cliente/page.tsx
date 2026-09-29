import Contador from "./contador";

// Mitigacion del hallazgo B-1: sin esta linea vinext la deja "? Unknown",
// la sirve por SSR en cada peticion y el CDN la marca BYPASS.
export const dynamic = "force-static";

export const metadata = { title: "Cliente" };

export default function Pagina() {
  return (
    <section>
      <h1>Client Component</h1>
      <p data-prueba="cliente-servidor-en">{new Date().toISOString()}</p>
      <Contador />
    </section>
  );
}
