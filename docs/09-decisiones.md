# 9 · Decisiones

Las decisiones de arquitectura se toman **con evidencia medida**, y una decisión congelada solo se
reabre por un motivo concreto: un experimento demuestra que no funciona, cambia un requisito de
producto, cambia el precio o la licencia, aparece un riesgo importante o hay evidencia medible de
que otra solución resuelve un problema real. **Sin evidencia, no hay reapertura.**

Los criterios de bloqueo se fijan **antes** de medir.

## Stack elegido y por qué

| Decisión | Elegido | Por qué | Descartado |
|---|---|---|---|
| **Adaptador de despliegue** | **vinext** | Un spike con 9 rutas desplegadas en Workers Free contra una base real: 10/10 rutas correctas, TTFB p50 de 81–86 ms en rutas cacheables, 0 errores en ~2.900 peticiones, 0 de 1.169 invocaciones excedieron la CPU | OpenNext: no se evaluó porque ninguno de los seis criterios de bloqueo definidos de antemano se activó |
| **Hosting** | **Cloudflare Workers Free** | Ningún criterio para pasar a Paid quedó acreditado | Workers Paid: sin evidencia. El orden ante un problema es mitigar → volver a medir → solo entonces proponer Paid |
| **Base de datos** | **PostgreSQL en Neon (UE) + Drizzle** | Postgres real con triggers e invariantes, y esquema tipado | Almacenes clave-valor y ORMs sin control del SQL |
| **Estilos** | **CSS nativo + CSS Modules** | Sin necesidad demostrada de más; compatible con Server Components | Tailwind, shadcn/ui, CSS-in-JS |
| **Fuente de datos** | **Streaming Availability (Movie of the Night)** | Uso comercial y caché indefinida permitidos en el plan gratuito, cobertura de España con enlaces directos al 100 % | TMDB (licencia no comercial), Watchmode y otras: incompatibles con el modelo o el presupuesto |

**No es una comparativa de funcionalidades, es una comparativa de licencias.** TMDB queda como
adaptador enchufable y desactivado; usar sus datos está prohibido mientras no haya licencia
comercial.

## Un hallazgo que condiciona la arquitectura

📏 El plan gratuito de Workers tiene un tope de 1.000 escrituras diarias a KV, y el pre-render
consume ~2 por página y por despliegue. **No se puede pre-renderizar el catálogo completo.** De ahí
salen varias decisiones de la web: la ficha es dinámica, solo se pre-renderiza lo que se justifica
por valor, tráfico y coste, y el resto se genera bajo demanda.

## Las decisiones registradas

En el desarrollo real cada una es un ADR (contexto, decisión, evidencia y consecuencias). Aquí se
resumen.

| ADR | Decisión | En una frase |
|---|---|---|
| 0001 | Fuente de datos | Una sola fuente para metadatos y disponibilidad, elegida por licencia y no por funciones |
| 0002 | Adaptador y hosting | vinext en Workers Free, con el techo de KV medido y documentado |
| 0003 | Plataformas del MVP | Seis plataformas y una matriz de capacidades de cuatro estados: qué se puede publicar de cada una |
| 0004 | Visibilidad del repositorio | Se decidió con el presupuesto de CI y el escaneo de secretos como restricciones reales |
| 0005 | Addon por id | Una identidad no se construye con un nombre de presentación: dos addons comparten nombre |
| 0006 | Checkpoint de reanudación | El punto de reanudación vive en la propia fila de ejecución, en la base de datos |
| 0007 | Anuncios de disponibilidad | «Próximamente» tiene su tabla; un anuncio no es una opción falsa |
| 0008 | Imágenes del MVP | Que un proveedor permita alojar una imagen no significa que se pueda publicarla: cartel tipográfico mientras tanto |
| 0009 | Seed inicial y ancla | Un catálogo inicial de ~5.000 títulos con una sola captura y un ancla que evita huecos en `deltas` |
| 0010 | Bloque de producción | Guardas de entorno, autorización en código y compuerta antes de escribir en producción |

### Tres ejemplos de cómo se razona

**Un dato falso que parecía inofensivo (ADR 0005).** El proveedor identifica cada addon por un id
y un nombre, pero 📏 en el corpus medido hay 27 ids y solo 25 nombres: dos nombres los comparten
dos addons distintos. Si el nombre fuera parte de la clave, dos ofertas distintas colapsarían en
una sin que nada fallara. Hoy la diferencia medida es cero filas, pero eso es una propiedad del
corpus, no del modelo. **La clave usa el id, y el nombre no se almacena.**

**Permitir no es tener derecho (ADR 0008).** El proveedor confirmó por escrito que se pueden alojar
sus imágenes en infraestructura propia. Pero esa autorización técnica **no implica** que licencie
los derechos de copyright del contenido de las imágenes. Son dos preguntas distintas y resolver la
primera no resuelve la segunda. Consecuencia: una imagen solo se publica si hay base de uso
aceptable; si no, cartel tipográfico. El esquema guarda referencias, pero ninguna consulta de la
web las lee.

**Una ausencia no es una baja (modelo de disponibilidad).** Un título que no aparece en una
observación no ha desaparecido: puede ser un reintento, una reproducción del crudo o una
observación más vieja que otra ya aplicada. El contador de ausencias se compara con el **instante
de la observación**, de modo que ninguna repetición cuenta dos veces. El error va siempre en la
dirección segura: una opción tarda más en retirarse, nunca menos.

## Estado del proyecto

- **Implementado:** frontend del MVP (portada, fichas, radar, búsqueda, listas, plataformas,
  «Mis plataformas»), esquema completo con triggers, adaptador de lectura de Neon, pipelines de
  ingesta (`deltas`, `expiring`, `upcoming`, `updated`) y el sistema de cuota con sus guardas.
- **Preparado, sin ejecutar:** el seed real y el bloque de producción, cada uno con su compuerta y
  su autorización explícita en código.
- **Sin hacer todavía:** catálogo real cargado, rol de solo lectura del runtime, imágenes
  publicables, contenido editorial, despliegue e indexación.
- **Sin producto publicado:** todo el sitio es `noindex`. La web arranca con datos ficticios.
