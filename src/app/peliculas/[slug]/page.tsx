import type { Metadata } from "next";
import { metadatos, pagina } from "@/features/ficha/pagina.tsx";

// Dinámica, declarada (CLAUDE.md, regla 10): cada ficha se resuelve en la
// petición leyendo **solo nuestra base** (o los fixtures), nunca una API externa
// (regla 1). Con Neon, pre-renderizar todas en el build sería pre-render masivo
// del catálogo (regla 11); y el segment config tiene que ser literal, así que
// no puede cambiar con `CATALOGO_FUENTE`: es dinámica también con los fixtures.
// Sin ISR ni caché propia todavía (docs/NEON-ADAPTER.md §15). Un slug que no
// resuelve es un 404 real (`notFound()`).
export const dynamic = "force-dynamic";

export async function generateMetadata(props: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  return metadatos("pelicula")(props);
}

export default pagina("pelicula");
