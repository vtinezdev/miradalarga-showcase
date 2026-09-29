# 1 · Arquitectura

Mirada Larga es un **monolito modular** con tres piezas. No hay microservicios ni colas: las
piezas se comunican solo a través de la base de datos.

```
┌────────────────────────────────────────────────────────────────┐
│ INGESTA · GitHub Actions (cron)                                │
│   jobs/adapters/    contrato canónico + un directorio por fuente│
│   jobs/pipelines/   seed · deltas · expiring · upcoming        │
│   jobs/ops/         cuota, bloqueos, transporte, ejecución     │
│   ÚNICO lugar con credenciales de APIs externas                │
└───────────────────────────┬────────────────────────────────────┘
                            │ escribe
┌───────────────────────────▼────────────────────────────────────┐
│ POSTGRES · Neon (UE)                                           │
│   external_* · derived_* · editorial_* · site_* · ops_*        │
└───────────────────────────┬────────────────────────────────────┘
                            │ lee (rol de SOLO LECTURA)
┌───────────────────────────▼────────────────────────────────────┐
│ WEB · Next.js sobre Cloudflare Workers (vinext)                │
│   Server Components · rutas en español · sin credenciales      │
│   externas                                                     │
└────────────────────────────────────────────────────────────────┘
```

## La regla que gobierna el diseño

> **Ninguna petición de usuario provoca una llamada a una API externa.** Nunca, ni en una
> búsqueda sin resultados.

No es una convención que haya que recordar: es **imposible de incumplir** por construcción.

1. La web **no tiene credenciales** de APIs externas. Solo los jobs las tienen.
2. ESLint prohíbe que `src/**` importe de `jobs/**` y que `jobs/**` importe de `src/app`
   ([`eslint.config.mjs`](../eslint.config.mjs)).
3. Dentro de `jobs/**`, ESLint prohíbe `fetch`, `XMLHttpRequest` y los clientes HTTP de bajo nivel
   **salvo en un único fichero**, [`jobs/ops/transporte.ts`](../jobs/ops/transporte.ts), que
   reserva cuota antes de cada llamada.
4. Al arrancar, la web se niega a conectar con la base de datos si su entorno lleva credenciales
   de los jobs ([`src/features/catalogo/proveedor.ts`](../src/features/catalogo/proveedor.ts)), y
   `pnpm build` verifica que el artefacto desplegable no las contiene
   ([`scripts/verificar-artefacto-web.ts`](../scripts/verificar-artefacto-web.ts)).

Un atacante que consiga disparar mil búsquedas no puede gastar la cuota de la API: desde la web
no hay cuota que gastar.

## Las tres piezas

### Ingesta (`jobs/`)

Programas de línea de comandos que corren en GitHub Actions. Cada uno sigue el mismo camino:

```
proveedor → esquema Zod del proveedor → normalización → modelo canónico → PostgreSQL
```

Detalle en [Ingesta de datos](02-ingesta.md).

### Base de datos (`src/db/schema/`, `drizzle/`)

PostgreSQL en Neon, con esquema en Drizzle y migraciones versionadas. Las tablas se agrupan por
prefijo según **quién puede escribirlas** (`external_*`, `derived_*`, `editorial_*`, `site_*`,
`ops_*`). Buena parte de las reglas de integridad viven en la propia base: `CHECK`, `UNIQUE` y
triggers. Detalle en [Base de datos](03-base-de-datos.md).

### Web (`src/`)

Next.js con App Router y Server Components, desplegada con **vinext** en Cloudflare Workers Free.
Las pantallas no conocen SQL: hablan con un **puerto** (`RepositorioDeCatalogo`) que tiene dos
implementaciones, una con datos ficticios en memoria y otra con Neon. Detalle en
[Lectura del catálogo](04-lectura-del-catalogo.md) y [La web](05-web.md).

## Capa anticorrupción

Todo dato externo entra por un adaptador y sale convertido al modelo canónico. Ninguna forma del
proveedor llega al dominio.

| Fichero | Responsabilidad |
|---|---|
| [`jobs/adapters/contracts.ts`](../jobs/adapters/contracts.ts) | **Modelo canónico.** Sin un solo nombre del proveedor. No importa nada: es la raíz de la dependencia |
| `jobs/adapters/streaming-availability/schema.ts` | Zod de las respuestas externas. Aquí viven los nombres y las rarezas del proveedor |
| `jobs/adapters/streaming-availability/normalizar*.ts` | Traducción pura entre ambos |

Hay una segunda frontera en el lado de lectura: [`src/db/queries/mapeo.ts`](../src/db/queries/mapeo.ts)
convierte filas SQL en el modelo de la web (`Titulo`, `Oferta`, `Movimiento`…), de modo que ninguna
columna ni enum de la base de datos sale de `src/db/queries/`.

**Prueba de fuego:** si aparece un segundo proveedor, debería poder cumplir el contrato sin que
`contracts.ts` cambie. Un test comprueba que `contracts.ts` no importa nada de un proveedor
([`tests/unit/capa-anticorrupcion.test.ts`](../tests/unit/capa-anticorrupcion.test.ts)).

**Una identidad nunca se construye con un nombre de presentación.** Un ejemplo real: el proveedor
llama `hbo` a lo que la web llama «HBO Max» (id canónico `max`, slug `hbo-max`). Son cuatro
identidades distintas, cada una con su dueño
([`src/features/catalogo/plataformas.ts`](../src/features/catalogo/plataformas.ts)), y un test
impide que el id del proveedor se cuele en la web.

## Concurrencia sin infraestructura extra

Los jobs no usan colas: los coordina PostgreSQL con **tres advisory locks** en espacios de
nombres distintos ([`jobs/ops/bloqueo.ts`](../jobs/ops/bloqueo.ts)).

| Lock | Tipo | Impide |
|---|---|---|
| Pipeline | sesión, sin espera | dos ejecuciones del **mismo** pipeline |
| Escritor de catálogo | sesión, sin espera | dos pipelines escribiendo `external_*` a la vez |
| Ciclo | transacción, con espera | dos reservas de cuota leyendo y decidiendo a la vez |

El orden es fijo (pipeline → catálogo → ciclo) y los dos primeros no esperan, así que el grafo de
espera no puede formar un ciclo. Si el catálogo está ocupado, la ejecución sale **antes de tocar
nada**. 📏 Se comprobó con sesiones PostgreSQL reales, incluido un control negativo que sí
provoca el interbloqueo (`40P01`) con la variante que espera.

## Despliegue

**vinext sobre Cloudflare Workers Free** (elegido con un spike medido, ver
[Decisiones](09-decisiones.md)).

| Capa de caché | Backend |
|---|---|
| Datos y pre-render | Workers KV |
| Páginas | Workers Cache |
| Assets estáticos | Gratis e ilimitados |

📏 **El techo real no es la CPU: son las escrituras a KV.** El pre-render consume ~2 claves por
página y por despliegue, y el plan gratuito tiene un tope de 1.000 escrituras diarias a claves
distintas. Por eso **no se pre-renderiza el catálogo completo**: qué rutas se pre-renderizan es una
decisión explícita, y el resto de páginas se genera bajo demanda.

**vinext no infiere el *route segment config* como Next.js.** Una página que no lo declara queda
sin clasificar, se renderiza en cada petición y el CDN la sirve sin caché, **sin dar ningún error**.
Por eso toda página declara `export const dynamic = …` de forma explícita, y se verifica en la
salida del build.

## Mapa del repositorio

```
src/
  app/          App Router: una carpeta por ruta, en español
  components/   ui/  componentes del sistema de diseño
  features/     una carpeta por pantalla o dominio (catalogo, ficha, radar…)
  db/           schema/ (Drizzle) · queries/ (adaptador de lectura)
  lib/          utilidades: slugs, fechas, datos estructurados, sitemap
  styles/       tokens.css y base.css
jobs/
  adapters/     contrato canónico + un directorio por proveedor
  pipelines/    seed/ · deltas/ · expiring/ · upcoming/ · updated/
  ops/          cuota, bloqueos, transporte, ciclo de vida de cada ejecución
  scoring/      orden del Ranking A
  run.ts        punto de entrada: pnpm job <nombre>
drizzle/        migraciones versionadas (esquema, triggers y tres ampliaciones)
scripts/        validación de esquema y de artefacto, herramientas de operación
tests/          unit/ · contract/ · e2e/ · fixtures/
docs/           esta carpeta
```
