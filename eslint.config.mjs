import js from "@eslint/js";
import next from "eslint-config-next/core-web-vitals";
import prettier from "eslint-config-prettier/flat";
import tseslint from "typescript-eslint";

/**
 * Regla innegociable 1 de CLAUDE.md, hecha ejecutable.
 *
 * Ninguna llamada externa puede salir sin haber reservado cuota antes, y la
 * reserva vive en jobs/ops/presupuesto.ts. Si cualquier fichero pudiera llamar
 * a fetch, esa garantía volvería a depender de que alguien se acuerde.
 */
const MENSAJE_DE_RED =
  "Ninguna llamada externa fuera de jobs/ops/transporte.ts: es el único sitio que reserva cuota antes de llamar (CLAUDE.md, regla 1; Plan §8.5).";

export default tseslint.config(
  {
    // Los spikes son evidencia archivada, no código mantenido: se conservan tal
    // cual hasta que se borren. Los artefactos de build tampoco se revisan.
    ignores: [
      "spike-1/**",
      "spike-2/**",
      "spike-3/**",
      "dist/**",
      ".next/**",
      ".vinext/**",
      ".wrangler/**",
      "coverage/**",
      "drizzle/**",
      "next-env.d.ts",
      // Skills de Claude Code: herramientas de terceros versionadas en el repo
      // (commit a413615), no código del proyecto.
      ".claude/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },

  js.configs.recommended,
  ...next,

  // ── Linting con información de tipos ─────────────────────────────────────
  // Acotado a los ficheros TypeScript y con el parser reafirmado: los configs
  // de eslint-config-next imponen su propio parser de forma global, y sin esto
  // las reglas que necesitan tipos fallan al arrancar.
  {
    files: ["**/*.{ts,tsx,mts}"],
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // No inventar datos faltantes (CLAUDE.md, regla 7): un `any` es
      // exactamente eso, afirmar una forma que no se conoce.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  // ── Separación web / jobs (Plan §19.3) ───────────────────────────────────
  // La regla existía solo como texto. Aquí se vuelve ejecutable.
  {
    files: ["jobs/**/*.{ts,tsx}", "scripts/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            // Cerrar la puerta de atrás: si fetch está prohibido fuera del
            // transporte, un cliente HTTP de bajo nivel sería el rodeo obvio.
            { name: "node:http", message: MENSAJE_DE_RED },
            { name: "node:https", message: MENSAJE_DE_RED },
            { name: "http", message: MENSAJE_DE_RED },
            { name: "https", message: MENSAJE_DE_RED },
            { name: "undici", message: MENSAJE_DE_RED },
            { name: "node-fetch", message: MENSAJE_DE_RED },
            { name: "axios", message: MENSAJE_DE_RED },
          ],
          patterns: [
            {
              group: ["@/app/*", "../src/app/*", "**/src/app/*"],
              message:
                "Los jobs no importan de src/app (Plan §19.3). Lo compartido va en src/db o src/lib.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@jobs/*", "../jobs/*", "**/jobs/*"],
              message:
                "La web no importa de jobs/ (Plan §19.3). Solo los jobs tienen credenciales externas, y ninguna petición de usuario puede provocar una llamada externa (CLAUDE.md, regla 1).",
            },
          ],
        },
      ],
    },
  },

  // ── El transporte es la única puerta a la red ────────────────────────────
  // jobs/ops/transporte.ts queda fuera a propósito: es el envoltorio que
  // reserva cuota antes de cada llamada. Todo lo demás en jobs/ tiene la red
  // cerrada por el linter, no por disciplina. `scripts/` entra en la misma regla:
  // un harness de validación es justo donde tentaría llamar a fetch «solo esta vez».
  {
    files: ["jobs/**/*.{ts,tsx}", "scripts/**/*.{ts,tsx}"],
    ignores: ["jobs/ops/transporte.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: MENSAJE_DE_RED },
        { name: "XMLHttpRequest", message: MENSAJE_DE_RED },
      ],
      "no-restricted-properties": [
        "error",
        { object: "globalThis", property: "fetch", message: MENSAJE_DE_RED },
        { object: "global", property: "fetch", message: MENSAJE_DE_RED },
      ],
    },
  },

  // Debe ir el último: apaga todo lo que colisione con Prettier.
  prettier,
);
