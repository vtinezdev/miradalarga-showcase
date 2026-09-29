// ISR clasico: se revalida cada 60 s.
export const revalidate = 60;
export const metadata = { title: "ISR" };

export default function Pagina() {
  return (
    <section>
      <h1>ISR (revalidate = 60)</h1>
      <p data-prueba="isr-generada-en">{new Date().toISOString()}</p>
    </section>
  );
}
