import { defineConfig, devices } from "@playwright/test";

/**
 * Humo E2E en navegador real (Plan §12, I): los flujos críticos en móvil
 * (375 px) y escritorio (1.440 px), más un spec suelto a 768 px. Arranca el servidor de desarrollo, que lee
 * del adaptador de desarrollo: cero red externa, cero base de datos.
 */
const PUERTO = 3100;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  // El servidor de desarrollo compila cada ruta la primera vez que se pide: con
  // un worker por núcleo, las navegaciones superaban el tiempo de espera por
  // carga (📏 10 fallos de 39 con el valor por defecto, 0 con 2).
  workers: 2,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PUERTO}`,
    locale: "es-ES",
    timezoneId: "Europe/Madrid",
    colorScheme: "dark",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "movil",
      testIgnore: /tableta\.spec\.ts/,
      use: { ...devices["Pixel 7"], viewport: { width: 375, height: 812 } },
    },
    {
      name: "escritorio",
      testIgnore: /tableta\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      // Solo el spec de tableta: 768 px es donde Quality Sprint 01 midió los
      // saltos de maquetación y el foco perdido del menú; 375 y 1.440 no los ven.
      name: "tableta",
      testMatch: /tableta\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 768, height: 1024 } },
    },
  ],
  webServer: {
    command: `pnpm dev -p ${PUERTO}`,
    url: `http://localhost:${PUERTO}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
