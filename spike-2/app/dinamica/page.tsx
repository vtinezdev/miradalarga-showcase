import { headers } from "next/headers";

// DINAMICA: se renderiza en cada peticion. Es la ruta que mas CPU consume (E4/E5).
export const dynamic = "force-dynamic";
export const metadata = { title: "Dinamica" };

export default async function Pagina() {
  const h = await headers();
  return (
    <section>
      <h1>Pagina dinamica</h1>
      <p data-prueba="dinamica-generada-en">{new Date().toISOString()}</p>
      <ul>
        <li>cf-ray: {h.get("cf-ray") ?? "(no hay)"}</li>
        <li>cf-ipcountry: {h.get("cf-ipcountry") ?? "(no hay)"}</li>
        <li>user-agent: {(h.get("user-agent") ?? "").slice(0, 60)}</li>
      </ul>
    </section>
  );
}
