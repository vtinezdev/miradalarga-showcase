# 5 · La web

Next.js (App Router) con **Server Components por defecto**, desplegada con **vinext** en Cloudflare
Workers Free. Rutas y textos en español de España, fechas en `Europe/Madrid`.

## Producto en una frase

Tres preguntas, en este orden: **¿qué merece la pena ver?** → **¿dónde lo veo?** → **¿qué está
pasando en los catálogos?** La navegación y la portada siguen ese orden.

```
CRITERIO ──────► TÍTULO ──────► DISPONIBILIDAD
(listas firmadas,  (ficha: qué es,   (dónde, cómo, hasta cuándo,
 rankings)          si merece verse)   comprobado cuándo)
      ▲                                    │
      └───────── RADAR DEL CATÁLOGO ◄──────┘
```

Se entra por el criterio (portada, listas) o por el título (alguien busca «dónde ver X»). Todo
título lleva a su disponibilidad, y el radar cierra el círculo.

## Pantallas

| Pantalla | Ruta | Renderizado |
|---|---|---|
| Portada | `/` | Estática |
| Ficha de título | `/peliculas/{slug}` · `/series/{slug}` | Dinámica |
| Hubs de tipo | `/peliculas` · `/series` | Estática |
| Listas editoriales | `/listas` · `/listas/{slug}` | Estática |
| Plataformas | `/plataformas` · `/plataformas/{slug}` | Estática |
| Radar del catálogo | `/radar` | Estática (filtros en cliente) |
| Búsqueda | `/buscar` | Dinámica |
| Mis plataformas | Hoja/diálogo, sin ruta | Cliente |

Cada `page.tsx` es fino: declara su configuración de renderizado y delega en un componente de
[`src/features/`](../src/features/), que es donde vive la pantalla. La ficha de película y la de
serie **son la misma pantalla con un tipo fijado**: una implementación, dos URL canónicas
([`src/features/ficha/pagina.tsx`](../src/features/ficha/pagina.tsx)).

## Renderizado y caché

Toda página declara su *route segment config* de forma explícita
(`export const dynamic = "force-static"` o `"force-dynamic"`). vinext no lo infiere, y una página
sin declarar se renderiza en cada petición **sin dar ningún error**.

| Decisión | Razón |
|---|---|
| Las pantallas de navegación son **estáticas** | Su contenido cambia poco y se sirven desde el CDN |
| La ficha es **dinámica** | Pre-renderizar todas las fichas sería pre-render masivo del catálogo, que el límite de escrituras de KV prohíbe. El segment config debe ser literal, así que no puede cambiar con la fuente de datos |
| La búsqueda es **dinámica** | Depende de la consulta del usuario |
| `dynamicParams = false` en listas y plataformas | Solo existen los slugs conocidos; cualquier otro es un 404 real |

La revalidación desde los jobs usa `revalidateTag(tag, { expire: 0 })` y **nunca se asume que sea
instantánea**: la propagación tarda unos segundos.

## Filtros en la URL

El radar y la búsqueda se filtran con `?tipo=`, `?plataforma=` y `?obra=`. Los valores
desconocidos se ignoran. Los filtros se aplican en el navegador **sin navegar**
(`history.replaceState`): se pueden enlazar, recargar y recuperar con «atrás», y la página
servida sigue siendo la misma para el CDN.

## Mis plataformas

El lector marca las plataformas que tiene contratadas y la web resalta lo que puede ver. Se apoya
en tres reglas de arquitectura:

1. **Se resuelve en el cliente sobre el HTML completo.** El servidor nunca varía el HTML según la
   selección: rompería la caché del CDN y crearía riesgo de *cloaking*.
2. **Sin cuenta, sin cookie y sin escritura en el servidor.** Solo `localStorage`
   ([`almacen.ts`](../src/features/mis-plataformas/almacen.ts)), que no viaja al servidor.
3. **Resaltar es automático; ocultar, nunca.** Filtrar solo ocurre si el lector activa «Solo en mis
   plataformas». Así, lo que sirve el servidor y lo que ve un buscador coinciden.

Detalles de implementación que evitan parpadeos y saltos de maquetación:

- Un script mínimo en `<head>` lee la selección **antes del primer pintado** y la escribe como
  atributo de `<html>` (`data-mis-plataformas`). **El resaltado es solo CSS** sobre ese atributo, no
  espera a la hidratación.
- Solo el reordenado de la disponibilidad y el filtro necesitan JavaScript, y ocurren dentro de un
  contenedor cuyo tamaño no cambia.
- El dato guardado es un JSON versionado con los **ids canónicos** de plataforma. Las funciones son
  puras sobre un `Storage` inyectado, así que se prueban sin navegador, y un `localStorage`
  inaccesible nunca rompe la página: solo deja de persistir.

## Honestidad del dato en la interfaz

Reglas que la arquitectura impone a todas las pantallas:

1. **Solo se muestra lo que la matriz de capacidades permite.** Para el resto, un mensaje distinto
   por estado: «no hemos visto salidas anunciadas», «esta plataforma no anuncia sus próximas
   llegadas», «todavía no medimos esto».
2. **«Comprobado el {fecha}»** en todo bloque de disponibilidad.
3. **Sin dato no es cero.** Una posición sin dato dice «sin dato»; una sinopsis que no existe en
   español no se muestra ni se traduce; un precio que no tenemos no se escribe.
4. **Lo editorial y lo calculado no se mezclan.** Las listas firmadas y los rankings automáticos
   nunca comparten bloque ni vocabulario.
5. **El histórico es joven**, y la interfaz dice desde cuándo se registran movimientos.

## SEO

- **Todo el sitio es `noindex`** mientras no haya producto publicado. Un único interruptor,
  `INDEXABLE` en [`src/lib/sitio.ts`](../src/lib/sitio.ts), lo leen `robots`, los metadatos y el
  sitemap.
- Datos estructurados con schema.org: `Movie`/`TVSeries` con `WatchAction` y `Offer` por plataforma,
  `BreadcrumbList`, `ItemList` en las listas y `WebSite` con `SearchAction` en la portada. Se
  generan desde las **mismas migas y datos que se pintan**: una sola fuente para lo visible y lo
  marcado.
- **Nunca `aggregateRating`.** La valoración que mostramos es ajena, y marcarla como propia sería
  engañoso. La fuente de disponibilidad se atribuye siempre.
- **Nada de rutas SEO combinatorias.** Cada landing se activa a mano y pasa un control de calidad.

## Seguridad de la superficie pública

- Los datos estructurados se serializan con `<` escapado, para que nada dentro de un `<script>`
  pueda cerrarlo ([`datos-estructurados.ts`](../src/lib/datos-estructurados.ts)).
- La búsqueda escapa los comodines del usuario y usa siempre parámetros.
- La web nunca escribe en el catálogo: su usuario es de solo lectura.
- Detalle en [Calidad y seguridad](08-calidad-y-seguridad.md).
