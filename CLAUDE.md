# Mirada Larga

Guía editorial del streaming en España, construida sobre datos de catálogo vivos.
*"Qué merece la pena ver, y dónde verlo."*

Este archivo es la **constitución** del proyecto, no su historial.

> **Copia de muestra.** Este `CLAUDE.md` es el del proyecto real, con lo justo adaptado. Menciona
> documentos operativos (runbooks, ADR, planes) que **solo existen en el repositorio privado**;
> aquí se resumen en [`docs/`](docs/README.md). Las reglas son las mismas.

---

## Fuentes de verdad

**Lee solo lo que la tarea necesita.** No cargues todos los documentos para un cambio de CSS.

| Documento | Autoridad sobre |
|---|---|
| `PRODUCT.md` | **Producto, marca, tono editorial, dirección visual** |
| `docs/01-arquitectura.md` | Cómo está montado y por qué: piezas, capa anticorrupción, caché, despliegue |
| `docs/02-ingesta.md` | Jobs, pipelines, cuota de la API, idempotencia y reanudación |
| `docs/03-base-de-datos.md` | Las 15 tablas, invariantes, triggers y migraciones |
| `docs/04-lectura-del-catalogo.md` | Cómo lee la web el catálogo: puerto, adaptadores y permisos de lectura |
| `docs/05-web.md` | Pantallas, renderizado, caché, Mis plataformas y SEO |
| `docs/06-rankings.md` | Reglas de las tres listas y sus límites |
| `docs/07-sistema-de-diseno.md` | Tokens, tipografía, movimiento y componentes |
| `docs/08-calidad-y-seguridad.md` | Tests, linter, secretos y cadena de suministro |
| `docs/09-decisiones.md` | Qué se decidió, con qué evidencia y qué se descartó |

`spike-2/` **no es fuente operativa**: es la medición que sostiene la decisión de vinext y Workers Free.

## Estado actual

- **Fase 1 — Validación técnica: cerrada.** **Fase 2 — Datos e ingesta: en curso.** El frontend del MVP (Fase 3) se ha adelantado.
- **Pipelines:** `deltas` (cron diario), `expiring` y `upcoming` (cron semanal) son jobs registrados que gastan cuota **contra la rama de validación** `drizzle-schema-v1-test`; `updated` es manual y sin presupuesto; el seed no es un job. `popularity`, `reconcile`, `enrich` y `scoring` no existen.
- **Seed real `seed-es-202610`: preparado, sin ejecutar.** Su autorización de captura se activa el 2026-10-01 y congela la rama histórica; antes hay que pausar los workflows (`docs/OPERATIONS.md`).
- **`production`: migrada, catálogo sin cargar.** Cargar y el primer `deltas` exigen su propia autorización en código (ADR 0010).
- **Frontend MVP implementado** con la dirección **«Luz de sala — edición dinámica»**: portada, fichas, radar, búsqueda, listas, plataformas, hubs y Mis plataformas. Sigue leyendo por defecto los **fixtures ficticios de desarrollo** (`src/features/catalogo/desarrollo/`).
- **Adaptador de lectura de Neon implementado** (`src/db/queries/`, `CATALOGO_FUENTE`, fail closed) y validado en solo lectura contra la rama histórica; **sin catálogo real todavía**.
- **Antes de usar Neon fuera de validación falta el rol de solo lectura del runtime** y su credencial como secreto del Worker.
- **No hay producto publicado:** todo es `noindex` (`INDEXABLE = false`), sin despliegue declarado.
- **Imágenes (D6, ADR 0008):** ninguna se publica todavía; el pipeline y R2 no existen. Mientras, cartel tipográfico y **nunca URLs del proveedor**.

Detalle: [`docs/`](docs/README.md).

## Stack congelado

Next.js 16 + React + TypeScript estricto · App Router · **RSC por defecto** · **vinext** · **Cloudflare Workers Free** · PostgreSQL en Neon (UE) · Drizzle ORM · GitHub Actions para los jobs pesados. Monolito modular, sin microservicios. pnpm por Corepack; versiones del runtime **clavadas sin rango**.

Justificación: Plan §6 y §21. **vinext y Workers Free están decididos con evidencia en el ADR 0002; OpenNext queda descartado y no se reevalúa sin un bloqueo real.**

## Decision Freeze

El Plan v1.0 §21 congela stack, arquitectura, fuentes y presupuesto. **No se reabre una decisión congelada porque exista otra tecnología interesante.**

Solo se reabre si: (a) un Spike demuestra que no funciona; (b) cambia un requisito de producto; (c) cambia materialmente el precio o la licencia; (d) aparece un riesgo importante; (e) hay **evidencia medible** de que otra solución resuelve un problema real.

**Toda reapertura se documenta en un ADR.** Sin evidencia, no hay reapertura.

## Reglas innegociables

1. **Ninguna llamada a una API externa durante una request de usuario.** Nunca, ni en una búsqueda sin resultados. La web no tiene credenciales externas; solo los jobs, y **solo a través de `jobs/ops/transporte.ts`**, que reserva cuota antes de llamar (ESLint lo vigila en `jobs/**`).
2. **Todo dato externo entra por un adaptador** que cumple `jobs/adapters/contracts.ts` y devuelve el modelo canónico. Capa anticorrupción obligatoria: ninguna forma ajena se filtra al dominio. **Una identidad nunca se construye con un nombre de presentación** (ADR 0005).
3. **La ingesta jamás sobrescribe `editorial_*`.**
4. **Nunca usar datos de TMDB** mientras `TMDB_COMMERCIAL_LICENSE=false`.
5. **Nada de rutas SEO combinatorias.** Toda landing se activa a mano y pasa el control de calidad.
6. **Nunca marcar con `aggregateRating` una valoración ajena.** Atribuir siempre la fuente de disponibilidad.
7. **No inventar datos faltantes.** Si no lo sabemos, se dice.
8. El usuario de base de datos del runtime es **de solo lectura**.
9. **Secretos nunca en el repo.** `.env` está en `.gitignore` y Gitleaks escanea el historial en CI. Que el repositorio sea privado **no** relaja la regla; un secreto filtrado se rota (`docs/SECURITY.md`).
10. **Toda página que deba ser estática declara su route segment config explícitamente.** vinext no lo infiere: sin declararlo la ruta queda `? Unknown`, se renderiza en cada petición y el CDN la sirve `BYPASS`. **Falla en silencio.** Si hace falta, `export const dynamic = "force-static"`.
11. **Nunca pre-render masivo del catálogo.** Cada página pre-renderizada consume escrituras de Workers KV por despliegue y el plan Free tiene techo diario. Qué se pre-renderiza es una decisión explícita y justificada (valor SEO · tráfico · relevancia editorial · caché · coste en KV), nunca `routes: "*"`.

**Rankings (`docs/RANKINGS.md`):** A · Mejor valoradas, B · Popular esta semana y C · Selección editorial son **distintas y no se mezclan**. En A y B una posición es un **ordinal, nunca una puntuación**; sin dato es «sin dato», jamás un valor inventado; comparar ventanas **no** es movimiento en el tiempo.

## Operaciones: límites permanentes

- **Todo comando que gasta cuota de la API** (`pnpm job`, `--real`, `seed:sondear`/`seed:capturar`, primer `deltas`) **exige autorización explícita** cada vez. Techo mensual y tope por ejecución autorizan; el coste esperado no autoriza nada; **cero significa «no autorizado», nunca «sin límite»** (`docs/DATA-SOURCES.md` §1.8).
- **`production` no se toca sin decisión explícita** y sin su entrada en `AUTORIZACIONES_DE_PRODUCTION`.
- **Credenciales operativas nunca en `.env`**: el build lo copia al artefacto del Worker. Los comandos operativos se lanzan con **`pnpm ops <perfil> <comando>`**, que construye el entorno desde `.ops-env/` sin heredar credenciales. Las guardas de destino (`DATABASE_URL_DIRECT`, `NEON_VALIDATION_HOST`, `MIGRATION_TARGET`) están en `docs/SECURITY.md`.
- **`drizzle-kit push` está prohibido** y no se declara nunca. No existe un `db:migrate` genérico.
- Seed, migraciones, `production`, pipelines y validadores especializados: **`docs/OPERATIONS.md`**, `docs/DATA-SOURCES.md` y `docs/NEON-ADAPTER.md`, no aquí.

## Comandos cotidianos

Node ≥ 24 y pnpm por Corepack. Si `pnpm` no responde: `corepack enable --install-directory "$APPDATA/npm" pnpm`.

| Comando | Qué hace |
|---|---|
| `pnpm dev` · `pnpm build` · `pnpm preview` | Desarrollo (vinext) · build para Workers + verificación del artefacto (sin credenciales de los jobs, sin driver en el cliente) · servir el build con `wrangler` |
| `pnpm typecheck` · `pnpm lint` · `pnpm format:check` | `tsc --noEmit` · ESLint · Prettier |
| `pnpm test` · `pnpm test:e2e` | Vitest · Playwright en móvil (375) y escritorio (1.440), sin red externa |
| `pnpm db:generate` · `pnpm db:check` | Generar y validar migraciones, **offline por construcción** |
| `pnpm ops <perfil> <comando>` | Comando operativo con el entorno de `.ops-env/` (`docs/OPERATIONS.md`) |

**Antes de subir nada**, lo mismo que el CI:

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build
```

**Al tocar el esquema**, además `pnpm db:generate` y `pnpm db:check`. Los tests de `tests/contract/` vigilan el SQL emitido; **drizzle-kit no ve los triggers de `drizzle/0001`**, solo esos tests.

## Cómo trabajar aquí

- **No sobrearquitectar.** Ni infraestructura, ni interfaz, ni proceso. Lo mínimo que resuelve el problema de hoy.
- **Presupuesto 0–20 €/mes.** No se contrata nada recurrente sin necesidad demostrada y medida. **No se contrata Workers Paid** sin evidencia: mitigar → volver a medir → solo entonces proponerlo y actualizar el ADR 0002.
- **No instalar dependencias, servicios ni infraestructura sin justificarlo** por escrito. Medir antes de optimizar.
- **Una sesión, una tarea o una fase.** No avanzar sin cierre explícito de la actual.
- **Las skills se usan solo cuando aportan a la tarea en curso**, nunca todas por defecto (Plan §12 y §19.9).
- **Convenciones:** TypeScript estricto · Drizzle, nunca SQL suelto en componentes · RSC por defecto · rutas y textos en español de España · fechas en `Europe/Madrid` · migraciones versionadas.
- **Revalidación:** `revalidateTag(tag, { expire: 0 })` (en Next.js 16, `"max"` no invalida); la propagación tarda segundos, **nunca asumir invalidación instantánea**.
- **Verificación de caché:** una página estática se comprueba en la salida de `vinext build` y en su `cf-cache-status`. `? Unknown` o `BYPASS` donde debería haber `HIT` **es un defecto**.

**Prioridad permanente: UX > accesibilidad > rendimiento > consistencia visual > animación.**

## Workflow de página importante

`objetivo → UI/UX Pro Max → comprobar componentes propios → 21st.dev si hace falta un patrón → implementar → React Best Practices → Motion solo donde aporte → Accessibility Audit → Playwright → UI/UX Audit → SEO Analysis si es indexable → code-review / simplify`

Todo componente importado se adapta a nuestros tokens, accesibilidad y convenciones. El responsive se considera durante la implementación, no después.

## Skills frontend

No usar todas las skills de diseño a la vez. Jerarquía:

1. `brand`: identidad de marca.
2. `ui-ux-pro-max`: referencia principal de UX/UI.
3. `21st-ui-explore`: exploración de patrones/referencias.
4. `design-system`: formalización de tokens y componentes.
5. `21st-ui-build`: apoyo durante implementación visual.
6. `react-best-practices`: autoridad para React/Next.js.
7. `framer-motion`: solo después de estabilizar layout y UX (hoy, CSS primero y sin Framer Motion).
8. `ui-ux-audit`, `accessibility-audit`, `seo-analysis-skill` y Playwright: auditoría final.

`design`, `ui-styling`, `banner-design`, `21st-ai`, `21st-cli-use` y `21st-registry` solo cuando una tarea requiera específicamente su capacidad.

En conflicto de diseño prevalece `ui-ux-pro-max`; en conflicto técnico React/Next, `react-best-practices`.
