import type { NextConfig } from "next";

// Spike 2 — configuracion minima a proposito.
// No se anade nada que no sirva para medir D3 o D9.
const nextConfig: NextConfig = {
  // Se declara para comprobar que vinext lee next.config (la skill dice que lo respeta).
  env: {
    SPIKE_MARCA_CONFIG: "next-config-leido",
  },
};

export default nextConfig;
