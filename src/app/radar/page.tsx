import type { Metadata } from "next";
import { enumerar } from "@/features/catalogo/formato.ts";
import { PLATAFORMAS_PUBLICAS } from "@/features/catalogo/plataformas.ts";
import { obtenerRadar } from "@/features/catalogo/consultas-radar.ts";
import { Radar } from "@/features/radar/Radar.tsx";

// Estática (CLAUDE.md, regla 10): los filtros (`?tipo=`, `?plataforma=`,
// `?obra=`) los aplica el navegador sobre este mismo HTML, así que filtrar no
// invoca el Worker. Toda combinación de filtros tiene la canónica de la vista
// base y `robots.txt` la excluye (docs/SEO.md).
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Radar del catálogo: qué llega y qué se va",
  description: `Las llegadas, salidas y estrenos anunciados de ${enumerar(PLATAFORMAS_PUBLICAS.map((p) => p.nombre))} en España, día a día y con fecha de comprobación.`,
  alternates: { canonical: "/radar" },
};

export default async function Page() {
  return <Radar vista={await obtenerRadar()} />;
}
