# Mirada Larga

Guía editorial del streaming en España, construida sobre datos de catálogo vivos.

> *«Qué merece la pena ver, y dónde verlo.»*

Proyecto personal de producto completo: datos, ingesta, base de datos, web, diseño y operaciones, con
un solo desarrollador y un presupuesto de **0–20 €/mes**.

> **Este repositorio es una copia de muestra (showcase).** El desarrollo real es privado. Aquí no
> hay datos del proveedor, ni runbooks operativos, ni workflows que gasten cuota. **La web arranca
> con datos ficticios**, sin credenciales ni red externa. No hay producto publicado todavía.

---

## Empieza por aquí

La carpeta [`docs/`](docs/README.md) explica **cómo funciona la web y cada una de sus partes**:

| # | Documento | Qué explica |
|---|---|---|
| 1 | [Arquitectura](docs/01-arquitectura.md) | Las tres piezas, la regla que las gobierna y cómo se hace cumplir |
| 2 | [Ingesta de datos](docs/02-ingesta.md) | Pipelines, cuota de la API como recurso protegido, idempotencia |
| 3 | [Base de datos](docs/03-base-de-datos.md) | Modelo de 15 tablas, invariantes, triggers de inmutabilidad |
| 4 | [Lectura del catálogo](docs/04-lectura-del-catalogo.md) | Puerto y adaptadores, «fail closed», permisos mínimos |
| 5 | [La web](docs/05-web.md) | Pantallas, renderizado, caché, Mis plataformas, SEO |
| 6 | [Rankings](docs/06-rankings.md) | Tres listas que no se mezclan y lo que se niegan a inventar |
| 7 | [Sistema de diseño](docs/07-sistema-de-diseno.md) | Tokens, tipografía, movimiento, componentes |
| 8 | [Calidad y seguridad](docs/08-calidad-y-seguridad.md) | Qué comprueba el código por sí solo |
| 9 | [Decisiones](docs/09-decisiones.md) | Qué se decidió, con qué evidencia y qué se descartó |

---

## Herramientas y por qué

Cada elección tiene una razón y, cuando hizo falta, una medición detrás.

### Stack de producto

| Herramienta | Por qué |
|---|---|
| **Next.js 16 + React 19 (App Router, RSC por defecto)** | Server Components dejan el JavaScript de cliente casi a cero, que es lo que más pesa en una guía de contenido |
| **vinext sobre Cloudflare Workers Free** | Decidido con un spike medido ([`spike-2/`](spike-2/RESULTADOS.md)): 10/10 rutas correctas, TTFB p50 de 81–86 ms en caché, 0 errores en ~2.900 peticiones, 0 € de coste. El spike también midió el límite: 1.000 escrituras de KV al día impiden pre-renderizar el catálogo completo |
| **PostgreSQL en Neon (UE) + Drizzle ORM** | Postgres real, con triggers e invariantes en la base, y esquema tipado sin SQL suelto en los componentes. Migraciones versionadas; `drizzle-kit push` prohibido a propósito |
| **TypeScript estricto + Zod** | Los datos externos se validan al entrar, en el adaptador, y no se propagan formas ajenas al dominio |
| **CSS nativo + CSS Modules, tokens en tres capas** | Sin Tailwind ni CSS-in-JS: no había necesidad medida, y el CSS-in-JS en ejecución choca con RSC. Consultas de contenedor para que los componentes se adapten a su hueco |
| **GitHub Actions** | CI frugal (un solo job, concurrencia cancelable, caché de pnpm). Los jobs de ingesta se programan aparte |

### Calidad y seguridad

| Herramienta | Por qué |
|---|---|
| **Vitest** (unidad y contrato) | Los tests de contrato vigilan el SQL emitido y los triggers, que `drizzle-kit` no ve |
| **Playwright** (375, 768 y 1.440 px) | E2E sin red externa. El responsive se comprueba en tres anchos |
| **ESLint con reglas de frontera** | La web no importa de los jobs; ninguna llamada externa fuera del transporte con cuota. Es una regla del linter, no una convención |
| **Gitleaks** en CI sobre el historial completo | El escaneo de secretos de GitHub es de pago en repos privados; se apoya el control en algo que sí se tiene |
| **Versiones clavadas sin rango + Dependabot acotado** | Se despliega el conjunto exacto que se midió sobre Workers. Subir una versión mayor exige volver a medir |

### Trabajo con IA (Claude Code)

| Herramienta | Por qué |
|---|---|
| **[`CLAUDE.md`](CLAUDE.md) como constitución del proyecto** | Reglas innegociables y decisiones congeladas. Cada sesión arranca con el mismo contexto, sin repetirlo |
| **Tres agentes de auditoría** ([`.claude/agents/`](.claude/agents/)) | Arquitectura/datos, frontend/UX y seguridad/operaciones, de solo lectura y con dominios separados |
| **Skills de diseño y calidad** (UI/UX, accesibilidad, SEO, React) | Se usan solo en la fase que les toca, no todas a la vez. Las copias de las skills de terceros no se incluyen aquí |

---

## Decisiones de las que estoy más satisfecho

1. **Decidir con evidencia, no con preferencia.** Los criterios de bloqueo se fijan *antes* de medir, y una decisión congelada solo se reabre con un ADR y datos.
2. **Ninguna llamada a una API externa durante una petición de usuario.** La web no tiene credenciales; solo los jobs, y siempre a través de un transporte que reserva cuota antes de llamar.
3. **Capa anticorrupción.** Todo dato externo entra por un adaptador y sale como modelo canónico. Una identidad nunca se construye con un nombre de presentación.
4. **Honestidad con los datos.** Si no se sabe, se dice: sin dato es «sin dato», y en los rankings una posición es un ordinal, nunca una puntuación inventada.
5. **Guardas operativas.** Las operaciones que gastan cuota o tocan producción requieren autorización explícita en código. «Cero» significa «no autorizado», nunca «sin límite».

---

## Estado

- Frontend del MVP implementado: portada, fichas, radar, búsqueda, listas, plataformas y «Mis plataformas».
- Esquema y adaptador de lectura de Neon implementados y validados en solo lectura.
- Pipelines de ingesta (`deltas`, `expiring`, `upcoming`) implementados; **sin catálogo real cargado**.
- Imágenes: cartel tipográfico. No se publican imágenes del proveedor.

---

## Probarlo en local

Requiere Node ≥ 24 y pnpm por Corepack (`corepack enable pnpm`).

```bash
pnpm install
pnpm dev          # la web, con datos ficticios de desarrollo
```

Comprobación completa, la misma que el CI:

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build
```

No hace falta `.env` para ver la web. Los comandos de ingesta y de base de datos necesitan
credenciales propias y **no están pensados para ejecutarse desde esta copia**.

---

## Nota sobre esta copia

- **Retirado:** datos crudos del proveedor, evidencias de ejecución, runbooks operativos, workflows
  programados, ADR y planes internos (resumidos en [`docs/`](docs/README.md)) y las skills de
  terceros. Algunos comentarios del código aún mencionan esos documentos como referencia.
- **Datos de prueba ficticios:** los fixtures de [`tests/fixtures/`](tests/fixtures/README.md) tienen
  la forma de las respuestas del proveedor, con títulos, identificadores y enlaces inventados.
  Los datos de catálogo pertenecen a su proveedor y no se redistribuyen.
- El historial se ha aplastado en un único commit. El desarrollo real conserva su historial completo.

## Licencia

Código publicado **solo para su evaluación** (portfolio y entrevistas). Todos los derechos
reservados: ver [`LICENSE`](LICENSE).
