import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import vinext from "vinext";

// Configuración de build para Cloudflare Workers mediante vinext (D3, ADR 0002).
//
// Se parte de la configuración validada en el Spike 2, con tres diferencias
// deliberadas:
//
//  1. Sin `cache: { data: kvDataAdapter(), cdn: cdnAdapter() }`. El namespace de
//     KV del spike está borrado y crear infraestructura antes de necesitarla
//     contradice el presupuesto. Se añade cuando exista despliegue real.
//
//  2. Sin `prerender: { routes: "*" }`. Prohibido por CLAUDE.md, regla 11: cada
//     página pre-renderizada consume ~2 escrituras de KV por despliegue y el
//     plan Free tope en 1.000/día. Qué rutas se pre-renderizan es una decisión
//     de arquitectura explícita, no un comodín.
//
//  3. **`.env` no es el entorno del Worker** (docs/SECURITY.md). Sin `.dev.vars`,
//     wrangler carga `.env` como variables del Worker —en `dev` y al serializar
//     `dist/server/.dev.vars` en el build—, y `.env` es de los jobs y los spikes:
//     📏 llevaba `STREAMING_AVAILABILITY_API_KEY` y el build la copiaba al
//     artefacto. Con esto, las variables de la web salen **solo** de `.dev.vars`
//     (ignorado por git) en local y de los secretos del Worker al desplegar.
//     `scripts/verificar-artefacto-web.ts` lo comprueba tras cada build.
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";

export default defineConfig({
  plugins: [
    vinext(),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
});
