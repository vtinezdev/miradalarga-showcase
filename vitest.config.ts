import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // El mismo alias que tsconfig.json: la web importa con `@/`.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    // Node, no navegador: la interfaz se prueba renderizando a HTML estático
    // (react-dom/server) y en navegador real con Playwright (tests/e2e/).
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    // Los spikes son evidencia archivada; sus scripts no son código bajo prueba.
    // tests/e2e/ es de Playwright, no de Vitest.
    exclude: [
      "node_modules/**",
      "dist/**",
      "spike-1/**",
      "spike-2/**",
      "spike-3/**",
      "tests/e2e/**",
    ],
  },
});
