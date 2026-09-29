import type { Metadata } from "next";
import { enumerar } from "@/features/catalogo/formato.ts";
import { PLATAFORMAS_PUBLICAS } from "@/features/catalogo/plataformas.ts";
import { obtenerIndiceDePlataformas } from "@/features/catalogo/consultas-hubs.ts";
import { IndiceDePlataformas } from "@/features/plataformas/IndiceDePlataformas.tsx";

// Estática (CLAUDE.md, regla 10).
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Qué ver en cada plataforma de streaming",
  description:
    // Los nombres salen de la presentación pública, no se escriben a mano.
    `${enumerar(PLATAFORMAS_PUBLICAS.map((p) => p.nombre))}: lo que recomendamos de cada una, lo que llega y lo que se va, con fecha de comprobación.`,
  alternates: { canonical: "/plataformas" },
};

export default async function Page() {
  return <IndiceDePlataformas datos={await obtenerIndiceDePlataformas()} />;
}
