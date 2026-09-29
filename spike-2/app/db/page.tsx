import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { spikePing } from "../../db/schema";

// Camino real del stack congelado (§6): Neon sobre HTTP + Drizzle, desde un RSC.
// Se degrada sin romper el build cuando todavia no hay DATABASE_URL.
export const dynamic = "force-dynamic";
export const metadata = { title: "DB" };

export default async function Pagina() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    return (
      <section>
        <h1>Neon</h1>
        <p data-prueba="db-estado">sin-database-url</p>
      </section>
    );
  }

  const inicio = Date.now();
  let filasSql: unknown[] = [];
  let filasDrizzle: unknown[] = [];
  let error: string | null = null;

  try {
    const sql = neon(url);
    filasSql = await sql`select id, nombre from spike_ping order by id`;
    const db = drizzle(sql);
    filasDrizzle = await db.select().from(spikePing);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <section>
      <h1>Neon</h1>
      <p data-prueba="db-estado">{error ? "error" : "ok"}</p>
      <p data-prueba="db-ms">{Date.now() - inicio}</p>
      <p data-prueba="db-filas-sql">{filasSql.length}</p>
      <p data-prueba="db-filas-drizzle">{filasDrizzle.length}</p>
      {error ? <pre>{error}</pre> : <pre>{JSON.stringify(filasDrizzle)}</pre>}
    </section>
  );
}
