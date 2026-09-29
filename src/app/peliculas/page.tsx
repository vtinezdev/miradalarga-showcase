import type { Metadata } from "next";
import { obtenerMarco } from "@/features/catalogo/consultas.ts";
import { obtenerHubDeTipo } from "@/features/catalogo/consultas-hubs.ts";
import { HubDeTipo } from "@/features/hubs/HubDeTipo.tsx";

// Estática (CLAUDE.md, regla 10). Es el padre de la miga de pan de cada ficha.
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Películas: qué ver y dónde verlas en España",
  description:
    "Películas que merece la pena ver según nuestras listas firmadas, las mejor valoradas y lo que llega o se va de las plataformas en España.",
  alternates: { canonical: "/peliculas" },
};

export default async function Page() {
  const [datos, marco] = await Promise.all([
    obtenerHubDeTipo("pelicula"),
    obtenerMarco(),
  ]);
  return (
    <HubDeTipo datos={datos} plataformasValidas={marco.plataformas.map((p) => p.id)} />
  );
}
