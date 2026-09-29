# 8 · Calidad y seguridad

La idea común: **una regla que solo existe como texto se incumple; una regla que un comando
comprueba, no.** Casi todo lo importante de este proyecto está escrito como test, como regla de
ESLint, como restricción de la base de datos o como guarda que falla al arrancar.

## La puerta de calidad

Antes de subir nada, y en CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)):

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build
```

Además, el CI ejecuta `pnpm audit --prod --audit-level=high` (bloqueante) y **Gitleaks sobre el
historial completo**.

| Comprobación | Qué vigila |
|---|---|
| **TypeScript estricto** | Tipos en todo el repositorio. Un `any` es un error de lint: afirmar una forma que no se conoce es inventar datos |
| **ESLint** | Fronteras entre módulos (abajo) y reglas de tipos |
| **Prettier** | Formato uniforme |
| **Vitest** | Unidad y contrato |
| **`pnpm build`** | Compila para Workers y **verifica el artefacto** (abajo) |
| **Playwright** | Flujos críticos en navegador real a 375, 768 y 1.440 px. Sin red externa: arranca la web con datos ficticios |

CI es deliberadamente frugal: un solo job, ejecuciones obsoletas canceladas y caché del almacén de
pnpm. Playwright corre en local antes de subir, no en cada push.

## Reglas que el linter hace cumplir

[`eslint.config.mjs`](../eslint.config.mjs) convierte tres reglas de arquitectura en errores:

1. `src/**` **no puede importar** de `jobs/**`.
2. `jobs/**` y `scripts/**` **no pueden importar** de `src/app`.
3. En `jobs/**` y `scripts/**` están prohibidos `fetch`, `XMLHttpRequest`, `node:http(s)`, `undici`,
   `axios` y `node-fetch`, **salvo en `jobs/ops/transporte.ts`**. Así, «no llames a la API sin
   reservar cuota» deja de ser disciplina y pasa a ser imposible de incumplir sin que el lint lo
   diga.

## Tests: qué tipos hay y qué garantizan

| Carpeta | Contenido |
|---|---|
| [`tests/unit/`](../tests/unit/) | Lógica pura: normalización, orden de rankings, ventanas de `deltas`, presupuesto de cuota, slugs, filtros de URL, búsqueda |
| [`tests/contract/`](../tests/contract/) | **Contratos que cruzan fronteras.** Vigilan el SQL emitido, los triggers que drizzle-kit no ve, el esquema, los permisos de lectura y la separación de módulos |
| [`tests/e2e/`](../tests/e2e/) | Playwright: flujos críticos y un spec a 768 px |
| [`tests/fixtures/`](../tests/fixtures/) | Respuestas de ejemplo **ficticias** con la forma de las del proveedor |

Ejemplos de contratos que merece la pena mirar:

- **`permisos-de-lectura`**: la lista exacta de tablas y columnas que el rol de solo lectura puede
  ver. Si una consulta nueva toca otra, falla antes de llegar a producción.
- **`capa-anticorrupcion`**: el contrato canónico no importa nada de un proveedor.
- **`plataformas-canonicas`**: el id del proveedor nunca es id ni slug en la web.
- **Contratos del esquema y de la migración inicial**: garantizan que los triggers de inmutabilidad
  existen y hacen lo que dicen.

Muchos tests se escriben contra **PostgreSQL real** cuando lo que importa es el comportamiento de
la base (locks, triggers, idempotencia), con validadores dedicados en [`scripts/`](../scripts/).
📏 Ejemplo: 41 comprobaciones de exclusión mutua de locks, incluido un control negativo que
provoca a propósito el interbloqueo que el diseño evita.

## Secretos

Reglas simples y comprobadas:

1. **Nunca en el repositorio.** `.env` está en `.gitignore`; solo `.env.example` se versiona, y va
   sin valores.
2. **Un repositorio privado no relaja nada.** Un secreto que llega al historial se rota; borrarlo
   en un commit posterior no lo retira.
3. **Gitleaks en CI** escanea el historial completo con la versión fijada. Se descarga el binario de
   su release: la acción oficial exige licencia en organizaciones, y el escaneo de secretos de
   GitHub es de pago en repos privados. **No se apoya un control de seguridad en una función que
   quizá no se tenga.**

### El build podía filtrar credenciales, y se cerró

📏 Se descubrió que `vinext build` copiaba el contenido de `.env` **en texto plano** al artefacto
desplegable. Con una clave de API en `.env`, el build la embebía. Eso rompería la garantía central
del proyecto (la web no tiene credenciales externas). Las medidas:

- `vite.config.ts` desactiva la carga de `.env` en el Worker.
- **Las credenciales operativas no viven en `.env`**: los comandos operativos se lanzan con un
  wrapper que construye el entorno desde ficheros ignorados por git, sin heredar credenciales.
- [`scripts/verificar-artefacto-web.ts`](../scripts/verificar-artefacto-web.ts) corre tras cada
  build y falla si el artefacto declara variables fuera de la lista de la web, si el bundle de
  cliente contiene el driver de base de datos, `DATABASE_URL` o una cadena de conexión, o si **el
  valor** de una credencial de los jobs aparece en cualquier fichero de `dist/`. Compara en memoria
  y **nunca imprime un valor**.
- `proveedor.ts` se niega a conectar si el entorno de la web lleva credenciales de los jobs.

## Base de datos

| Medida | Detalle |
|---|---|
| Usuario del runtime | **Solo lectura**, con la lista mínima de tablas y columnas ([Lectura del catálogo](04-lectura-del-catalogo.md#permisos-mínimos-del-rol-de-lectura)) |
| Escrituras | Solo los jobs |
| Consultas | Drizzle o SQL **parametrizado**, nunca concatenado |
| Migraciones | Versionadas. `drizzle-kit push` prohibido |
| Región | UE, por RGPD |
| Errores | Se **sanean** antes de imprimirse: ante un fallo de autenticación, PostgreSQL responde con el nombre del usuario de la base de datos |

Ningún hostname, contraseña ni cadena de conexión se escribe en el repositorio.

## Guardas de operaciones

Las operaciones que escriben o gastan cuota están protegidas con guardas que corren **al cargar el
módulo, antes de que exista un socket**, y con autorizaciones en código
([Ingesta](02-ingesta.md#protección-de-los-destinos)). Las de producción usan una familia de
variables distinta que no puede coexistir con la de validación, de modo que una sesión de una no
alcanza la otra ni por error.

## Cadena de suministro

| Medida | Detalle |
|---|---|
| Lockfile | `pnpm-lock.yaml`, con `--frozen-lockfile` en CI |
| Versiones del runtime | **Clavadas sin rango**, exactamente el conjunto medido sobre Workers |
| Scripts de instalación | **Bloqueados por defecto**; solo los que necesitan binario nativo están permitidos |
| Auditoría | `pnpm audit --prod` bloqueante en CI. Solo producción: un CVE de una herramienta de desarrollo no llega al Worker, y bloquear el CI por él lo convertiría en un semáforo que nadie mira |
| Dependabot | Actualizaciones agrupadas y semanales; no puede subir versiones mayores del runtime sin volver a medir |
| Dependencias nuevas | Con justificación escrita |

## Superficie pública

- Los datos estructurados se serializan con `<` escapado para que nada cierre un `<script>`.
- La búsqueda escapa los comodines y solo usa parámetros.
- Cabeceras de seguridad (CSP, HSTS y demás) previstas para el momento del despliegue, cuando haya
  una superficie que proteger.
- Sin datos personales: Mis plataformas vive en `localStorage`, sin cuenta ni cookie.

## Trabajo con agentes de IA

El proyecto se desarrolla con Claude Code y lo documenta abiertamente:

- [`CLAUDE.md`](../CLAUDE.md) es la **constitución** del proyecto: reglas innegociables, decisiones
  congeladas y qué documento manda en cada tema. Cada sesión arranca con el mismo contexto.
- Tres agentes de auditoría de **solo lectura** en [`.claude/agents/`](../.claude/agents/), cada uno
  con su dominio (arquitectura y datos, frontend y UX, seguridad y operaciones). Se limitan a
  auditar; sus informes los cruza la sesión principal, que decide qué se corrige y qué se
  documenta como deuda conocida.
