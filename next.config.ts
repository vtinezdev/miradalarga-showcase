import type { NextConfig } from "next";

// Mirada Larga — configuración de Next.js.
//
// Deliberadamente mínima en la Fase 1: aquí no se añade nada que no resuelva un
// problema de hoy (CLAUDE.md, «no sobrearquitectar»).
//
// Pendiente de fases posteriores:
//   · Imágenes — D6 resuelta para el MVP (docs/adr/0008): se
//     servirán desde R2 + CDN propio, nunca desde las URLs firmadas del
//     proveedor. No se configura nada hasta que exista el pipeline de imágenes.
//   · Cabeceras de seguridad (CSP, HSTS…) — docs/SECURITY.md, Fase 3.
const nextConfig: NextConfig = {};

export default nextConfig;
