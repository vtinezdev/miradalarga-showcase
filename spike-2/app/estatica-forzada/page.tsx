// Control del clasificador de vinext: identica a "/" pero declarando
// explicitamente el route segment config. Si esta SI se pre-renderiza y "/"
// no, la carencia esta en el analisis estatico, no en el pre-render.
export const dynamic = "force-static";
export const metadata = { title: "Estatica forzada" };

export default function Pagina() {
  return (
    <section>
      <h1>Pagina estatica forzada</h1>
      <p data-prueba="forzada-generada-en">{new Date().toISOString()}</p>
    </section>
  );
}
