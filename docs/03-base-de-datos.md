# 3 · Base de datos

PostgreSQL en Neon (región UE), con esquema en Drizzle ORM
([`src/db/schema/`](../src/db/schema/)) y migraciones versionadas ([`drizzle/`](../drizzle/)).
Son **15 tablas**. El modelo sigue una regla: **medir primero, modelar después**. Una tabla entra
solo si la forma real de sus datos se ha observado, o si responde a una necesidad interna.

## Cinco planos, separados por prefijo

Las tablas se agrupan por **quién puede escribirlas**.

| Prefijo | Contenido | Quién escribe |
|---|---|---|
| `external_*` | Catálogo y disponibilidad tal y como llegan de fuera | Solo la ingesta |
| `derived_*` | Rankings que calculamos | Solo la ingesta |
| `editorial_*` | Texto propio, listas, autores | Solo personas |
| `site_*` | Landings, redirecciones, búsquedas | Ingesta y runtime acotado |
| `ops_*` | Ejecuciones de pipelines, cuota, errores | Solo los jobs |

⚖️ Se eligieron **prefijos y no schemas de PostgreSQL**. La única ventaja real de los schemas
(negar por permisos que la ingesta escriba en `editorial_*`) solo cuenta cuando existen dos roles
escritores distintos. Pasar a schemas después es `ALTER TABLE … SET SCHEMA`, sin pérdida de datos.

## Las tablas

### Catálogo

| Tabla | Contenido |
|---|---|
| `external_titles` | El título normalizado. `imdb_id` único y obligatorio |
| `external_genres` · `external_title_genres` | Vocabulario cerrado de géneros y su relación N:M |
| `external_title_images` | Referencias de imagen (estado actual, no histórico) |

### Plataformas y disponibilidad

| Tabla | Contenido |
|---|---|
| `external_platforms` | Referencia **curada a mano**, con id propio distinto del del proveedor |
| `external_platform_capabilities` | Qué puede publicarse de cada plataforma, **por país** |
| `external_availability` | **Identidad estable** de una oferta lógica |
| `external_availability_options` | **Variantes concretas** observadas de esa oferta |
| `external_availability_events` | Histórico **inmutable** de altas, bajas y cambios |
| `external_availability_announcements` | Anuncios de disponibilidad futura («Próximamente») |

### Señales, derivado y operación

| Tabla | Contenido |
|---|---|
| `external_list_captures` · `external_list_positions` | Capturas de listas de popularidad y sus posiciones ordinales |
| `derived_ranking_definitions` · `derived_ranking_entries` | Definición pública de cada ranking y su contenido |
| `ops_sync_runs` | Una fila por ejecución de pipeline: estado, cuota, errores y checkpoint |

## Decisiones de modelado que merece la pena entender

### Oferta lógica y opciones

Una oferta («The Crown en Netflix, por suscripción») se separa de sus variantes concretas
(enlace, calidad, precio, idiomas).

```
external_availability          → identidad: título · plataforma · país · tipo · addon
external_availability_options  → variantes: enlace · calidad · precio · idiomas · fechas
```

📏 Con datos reales, el 18,3 % de las ofertas tienen más de una opción (hasta 9), y `link` y
`quality` son dimensiones independientes: ninguna basta sola. Prime *buy* vende tres calidades a
tres precios bajo un único enlace.

Las altas y bajas se registran **en la oferta lógica, nunca por opción**. Así, la rotación de
enlaces o precios es un `changed`, no una falsa baja seguida de una falsa alta: se protege el dato
de producto «en Netflix desde…».

### Nada derivable se almacena

No existe columna `status`, ni `leaving_soon`, ni `is_active`. Se calculan a partir de las
opciones activas:

| Estado | Condición |
|---|---|
| `upcoming` | Todas las opciones activas tienen `available_since` futuro |
| `available` | Alguna opción activa ya está disponible |
| `gone` | No queda ninguna opción activa |
| `leaving_soon` | Disponible y la menor `expires_at` **futura** cae en ≤ 30 días |

📏 Esa regla de «se va pronto» reproduce el dato de la fuente en 336 de 336 ofertas medidas. Una
`expires_at` **ya pasada** no cuenta: si una oferta sigue activa después de su fecha, no sabemos
que «se va pronto».

### Los anuncios no son opciones falsas

Una oferta anunciada para el futuro va a su propia tabla. Su identidad es la de la oferta lógica;
**ni la fecha ni el enlace son identidad**, así que un aplazamiento actualiza la misma fila. Un
anuncio es *vigente* solo si su fecha es futura **y** se ha visto en el último recorrido completo y
sin errores. Un recorrido incompleto no invalida nada.

### `null` significa «no lo sabemos»

- El proveedor emite `0` para «sin valoración todavía». La conversión `0 → null` ocurre **una sola
  vez**, en el adaptador, y `CHECK (rating BETWEEN 1 AND 100)` garantiza que un `0` no puede entrar.
- `imdb_id` vacío o en blanco no es identidad: un `CHECK` con expresión regular lo impide. 📏 La
  expresión coincide con el `trim()` del adaptador en 13 de 13 casos, incluidos U+00A0 y U+3000;
  `btrim()` a secas dejaba pasar tabuladores y saltos de línea.

### Las capacidades por plataforma son de cuatro estados

`supported_with_data` · `supported_no_data_in_sample` · `not_supported` · `unknown`. Un booleano
colapsaría «medido y vacío» con «no soportado», y esa es la distinción que importa: **un cero
observado no se comunica como una ausencia**. Lo ausente es `unknown`.

### Imágenes: «conocida» no es «publicable»

La base guarda referencias del proveedor con su caducidad, pero **ninguna consulta de la web lee
esas URLs**. La columna `is_placeholder` es obligatoria: sin ella, títulos que solo tienen el
póster genérico del proveedor pasarían el filtro de «ficha mínima» del ranking.

## Integridad que garantiza la base, no el código

### Idempotencia por `UNIQUE`

Los eventos llevan `UNIQUE (availability_id, event_type, event_digest, dedupe_bucket_at)`, donde
`event_digest` es un hash determinista del cambio. Reejecutar un pipeline, reintentar o reprocesar
un crudo no escribe nada. `dedupe_bucket_at` es un instante (inicio del día, hoy) y no una fecha:
pasar a cadencia horaria no exigiría migrar el esquema.

⚠️ Limitación consciente: dos cambios idénticos dentro del mismo intervalo se colapsan en uno. Se
prefiere idempotencia garantizada a capturar oscilaciones intradía que hoy nadie consume.

### Inmutabilidad: privilegios y triggers, no `CHECK`

Un `CHECK` valida filas, pero no impide `UPDATE` ni `DELETE`. La inmutabilidad del histórico se
protege con privilegios, con triggers que cubren también al propietario y con migraciones aplicadas
por un rol distinto del de ingesta. Los triggers son **asimétricos**, porque inmutabilidad y
retención no son lo mismo:

| Tabla | `UPDATE` | `DELETE` |
|---|---|---|
| `external_availability_events` | ❌ | ❌ («se compacta, no se borra») |
| `external_list_captures` · `external_list_positions` | ❌ | ✅ (retención de 180 días) |

Por eso `external_list_positions.capture_id` es `ON DELETE RESTRICT` y no `CASCADE`: la retención
borra en dos pasos explícitos, primero posiciones y luego capturas.

drizzle-kit no ve los triggers (van en una migración escrita a mano), así que los vigilan tests de
contrato ([`tests/contract/`](../tests/contract/)).

### No todo `external_*` es recargable

| Grupo | Qué contiene | Reingesta |
|---|---|---|
| **Estado** | Títulos, géneros, imágenes, disponibilidad y opciones | Recargable sin pérdida |
| **Histórico** | Eventos, capturas de listas y sus posiciones | **Irrecuperable**: registra lo observado un día concreto |
| **Referencia curada** | Plataformas y capacidades | Lleva decisiones propias que ninguna ingesta repone |

Confundirlos destruiría el diferencial de producto. Recargar el estado no pierde nada propio, y el
histórico y la referencia quedan fuera de esa operación **siempre**. Además, la ingesta jamás
sobrescribe `editorial_*`.

## Migraciones

- Versionadas en [`drizzle/`](../drizzle/): cinco migraciones. La inicial la genera drizzle-kit;
  la segunda está escrita a mano y contiene los triggers de inmutabilidad; las otras tres son
  aditivas (checkpoint de reanudación, anuncios de disponibilidad y el `CHECK` de `imdb_id`).
- `drizzle-kit push` está **prohibido** y no se declara. Tampoco existe un `db:migrate` genérico.
- `drizzle.config.ts` **no declara credenciales**: por construcción es incapaz de conectarse, así
  que `db:generate` y `db:check` no pueden filtrar nada. Las migraciones reales pasan por
  `drizzle.migrate.config.ts`, con las guardas de destino descritas en
  [Ingesta](02-ingesta.md#protección-de-los-destinos).

## Rol de solo lectura

El runtime de la web usa un usuario de solo lectura. Qué puede leer exactamente, y por qué esa
lista es un contrato vigilado por un test, está en
[Lectura del catálogo](04-lectura-del-catalogo.md#permisos-mínimos-del-rol-de-lectura).
