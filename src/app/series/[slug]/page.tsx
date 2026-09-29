import type { Metadata } from "next";
import { metadatos, pagina } from "@/features/ficha/pagina.tsx";

// Misma pantalla que /peliculas/[slug], con el tipo fijado. Ver allí el porqué
// del segment config (CLAUDE.md, reglas 1, 10 y 11).
export const dynamic = "force-dynamic";

export async function generateMetadata(props: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  return metadatos("serie")(props);
}

export default pagina("serie");
