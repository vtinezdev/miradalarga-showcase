# 4 · Lectura del catálogo

Cómo lee la web la base de datos sin que ninguna pantalla conozca SQL, columnas ni al proveedor.

## Un puerto, dos adaptadores

```
Server Components / generateMetadata
        ↓
consultas de aplicación     src/features/catalogo/consultas*.ts
        ↓
RepositorioDeCatalogo       src/features/catalogo/repositorio.ts   (el puerto)
        ↓  proveedor.ts elige según CATALOGO_FUENTE
 ┌──────────────────────┬────────────────────────────────────────────┐
 │ desarrollo/          │ src/db/queries/repositorio-neon.ts          │
 │ datos ficticios en   │   ├─ catalogo-sql.ts   una consulta por necesidad
 │ memoria              │   ├─ mapeo.ts          filas → modelo de la web
 │                      │   ├─ lector.ts         Neon HTTP + Drizzle
 │                      │   └─ errores.ts        errores saneados
 └──────────────────────┴────────────────────────────────────────────┘
```

- **El puerto** ([`repositorio.ts`](../src/features/catalogo/repositorio.ts)) es lo único que las
  consultas de aplicación conocen del origen de los datos. Sus reglas valen para cualquier
  adaptador: **solo lectura**, **ninguna llamada externa**, solo imágenes publicables y solo lo que
  permite la matriz de capacidades de cada plataforma.
- **El adaptador de desarrollo** (`src/features/catalogo/desarrollo/`) trae datos **ficticios** en
  memoria. Es el que usan `pnpm dev`, los tests y el build del CI.
- **El adaptador de Neon** implementa exactamente el mismo puerto. Las pantallas y las consultas de
  aplicación no cambiaron al añadirlo.

## Selección de la fuente y «fail closed»

[`proveedor.ts`](../src/features/catalogo/proveedor.ts) decide qué adaptador se usa según
`CATALOGO_FUENTE`. Ante cualquier duda, **falla en lugar de degradarse**:

- Valor desconocido → error.
- Variable ausente → datos de desarrollo **solo mientras el sitio no es indexable** (`INDEXABLE =
  false`). Con el sitio indexable, servir datos de desarrollo es un error de configuración.
- `neon` sin `DATABASE_URL`, o con una URL que no es PostgreSQL → error antes de conectar.
- `neon` con credenciales de los jobs en el entorno (la clave de la API, las URLs directas de
  migración) → error: la web no puede tenerlas.
- **Un fallo de Neon falla la petición.** Nunca hay respaldo silencioso a los fixtures.

## La segunda capa anticorrupción

[`mapeo.ts`](../src/db/queries/mapeo.ts) convierte filas en el modelo de la web. Ninguna fila,
columna ni enum SQL sale de `src/db/queries/`. La tabla siguiente muestra el tipo de decisiones que
se toman ahí; en todas, **lo que no se sabe queda ausente**.

| Campo de la web | Origen | Regla |
|---|---|---|
| `id` | `imdb_id` | Tal cual; **no** el id interno, que cambia entre entornos |
| `anio` | `year` | **Sin año no hay ficha** |
| `valoracion` | `rating` | Con su fuente atribuida; sin número de votos, porque no existe |
| `tmdb_id`, `source_id` | — | **No se exponen** |
| `imagenes` | — | Siempre vacío: nada publicable todavía |
| `calidad` de una oferta | Máxima de las opciones activas | **Se omite** si hay precio y varias calidades: no se afirma «4K desde 5,99 €» |
| `precioDesde` | Mínimo de opciones activas | Solo en euros y solo si la capacidad `prices` está medida |

## Qué es cada tipo de movimiento

El radar muestra cinco tipos, cada uno con su fuente y su regla:

| Tipo | Fuente | Regla |
|---|---|---|
| `llega` | Eventos `added` | Uno por título y plataforma |
| `se-fue` | Eventos `removed` | Solo si **hoy** no queda oferta disponible allí |
| `cambio` | Eventos `changed` | Solo campos presentables (precio, calidad, idiomas, caducidad) |
| `se-va` | Estado derivado `leaving_soon` | Solo plataformas con la capacidad `expiring` medida |
| `proximamente` | Anuncios vigentes | Solo con la capacidad `upcoming` medida |

Las capacidades se aplican **en la base de datos**: una plataforma sin esa capacidad no aporta ni
una fila, y la capa de aplicación la sigue leyendo para explicar por qué falta.

## Consultas: pocas y previsibles

- `titulos(ids)` resuelve **toda una lista con una consulta**, nunca una por tarjeta.
- `ficha` hace 4 consultas en paralelo (base, ofertas, anuncios, histórico).
- Los agregados (géneros, recuentos por plataforma) se calculan en SQL.
- La búsqueda no exige extensiones de PostgreSQL: pliega mayúsculas y tildes con `translate` y
  `lower`. `%`, `_` y `\` del usuario se escapan, y todo viaja como **parámetro**. 📏 Recorre el
  catálogo completo en 10 ms con 681 títulos.
- `mejorValoradas` devuelve las `n` mejores **más los empates de la frontera**, y el desempate
  neutral se aplica en TypeScript: el mismo código que en el adaptador de desarrollo
  ([Rankings](06-rankings.md)).

## Slugs sin tabla

Los slugs de ficha se derivan: `slugDeTitulo("La casa del faro", "tt1234567")` da
`la-casa-del-faro-tt1234567`. La ficha se resuelve **solo por el sufijo `tt…`**, así que si el
proveedor retoca el título, el slug viejo sigue llevando a la ficha, que declara el nuevo como
canónico. No hay colisiones porque `imdb_id` es único.

## Permisos mínimos del rol de lectura

El runtime de la web usa un rol de PostgreSQL que solo puede hacer `SELECT`, y solo sobre esto:

**Tablas del catálogo (`SELECT` de tabla completa):**

- `external_availability`
- `external_availability_announcements`
- `external_availability_events`
- `external_availability_options`
- `external_genres`
- `external_platform_capabilities`
- `external_platforms`
- `external_title_genres`
- `external_title_images`
- `external_titles`

**Del plano de operaciones, solo `ops_sync_runs` y solo estas columnas**, que dan la vigencia de los
anuncios y el ancla del seed: `checkpoint`, `error_count`, `finished_at`, `id`, `pipeline` y
`status`. No lee cuota, errores ni commits.

**No puede leer** capturas ni posiciones de popularidad, ni las tablas `derived_*`.

Esta lista **es un contrato vigilado por un test**
([`tests/contract/permisos-de-lectura.test.ts`](../tests/contract/permisos-de-lectura.test.ts)), sin
base de datos: si una consulta nueva toca otra tabla u otra columna de `ops_sync_runs`, el test
falla antes de que la ficha, el radar o la portada den «permiso denegado» en producción; y si
alguien concede de más, el contrato ya dice qué sobra. Este documento debe nombrar cada tabla y
columna concedidas, y el test lo comprueba.

## Frescura

`ultimaComprobacion()` devuelve la fecha de la última **observación real** del catálogo (solo
avanza). Si no hay ninguna, es un error: **nunca una fecha inventada**. Toda ficha muestra «Comprobado
el {fecha}», porque comprobar no es ver.
