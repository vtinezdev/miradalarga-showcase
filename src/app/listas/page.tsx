import type { Metadata } from "next";
import { obtenerMarco } from "@/features/catalogo/consultas.ts";
import { obtenerIndiceDeListas } from "@/features/catalogo/consultas-listas.ts";
import { IndiceDeListas } from "@/features/listas/IndiceDeListas.tsx";

// Estática (CLAUDE.md, regla 10). Cuando lea de Neon, la invalidará el job que
// publique o revise una lista (`revalidateTag`).
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Listas firmadas: qué merece la pena ver",
  description:
    "Selecciones de películas y series hechas a mano, firmadas y revisadas, con un veredicto por título y dónde verlo hoy en España.",
  alternates: { canonical: "/listas" },
};

export default async function Page() {
  const [datos, marco] = await Promise.all([obtenerIndiceDeListas(), obtenerMarco()]);
  return (
    <IndiceDeListas
      datos={datos}
      plataformasValidas={marco.plataformas.map((p) => p.id)}
    />
  );
}
