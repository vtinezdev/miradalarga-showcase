// ESTATICA: sin datos dinamicos. La marca de tiempo se congela en build
// si hay prerender real; si cambia en cada peticion, no lo hubo (prueba D6 del plan).
export const metadata = { title: "Estatica" };

export default function Pagina() {
  const generadaEn = new Date().toISOString();
  return (
    <section>
      <h1>Pagina estatica</h1>
      <p data-prueba="estatica-generada-en">{generadaEn}</p>
      <img src="/logo.svg" alt="" width={48} height={48} />
    </section>
  );
}
