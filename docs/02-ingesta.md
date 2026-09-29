# 2 · Ingesta de datos

La ingesta vive en [`jobs/`](../jobs/) y es la única parte del sistema que habla con el exterior.
El problema que resuelve es doble: **mantener un catálogo al día** con una API que tiene cuota
mensual limitada y **no perder nunca lo observado**, porque la fuente no devuelve el pasado.

## Punto de entrada y registro

`pnpm job <nombre>` ejecuta [`jobs/run.ts`](../jobs/run.ts), que solo sabe lanzar los pipelines de
[`jobs/registro.ts`](../jobs/registro.ts): `deltas`, `expiring` y `upcoming`. Añadir uno es una
decisión explícita, porque cada uno necesita su propio presupuesto de cuota. El *seed* inicial no
es un job: se captura, verifica y carga a mano.

Los tres jobs comparten el mismo runner ([`jobs/pipelines/programado.ts`](../jobs/pipelines/programado.ts)):
mismas guardas de destino, mismas conexiones y misma política de códigos de salida. Además traduce
su veredicto a anotaciones y resumen de GitHub Actions.

## Los pipelines

| Pipeline | Qué hace | Ventana |
|---|---|---|
| `seed` | Construye el catálogo inicial (~5.000 títulos) a partir de una captura única y la carga con upsert idempotente | Una vez |
| `deltas` | Altas y bajas de disponibilidad (`new`, `removed`) desde la última ejecución | Contigua hacia atrás, reanudable |
| `expiring` | Ofertas que caducan en los próximos días | Horizonte hacia delante |
| `upcoming` | Ofertas anunciadas para el futuro | Horizonte hacia delante |
| `updated` | Cambios de precio, calidad o idiomas | Manual, solo medición |

**Dos estrategias de ventana, deliberadamente distintas.**

- **Contigua hacia atrás** (`deltas`): cada ventana empieza donde terminó la anterior. Si una se
  corta, la siguiente ejecución **la reanuda** con su cursor.
- **Horizonte hacia delante** (`expiring`, `upcoming`): cada ejecución recorre
  `[ahora, ahora + N días]` **desde su principio**. El horizonte de ayer ya no es el de hoy;
  reanudarlo perseguiría la cola de una lista caducada.

## Anatomía de una ejecución

El job de `/changes` ([`jobs/pipelines/deltas/job.ts`](../jobs/pipelines/deltas/job.ts)) une el
pipeline con el plano de operaciones. Las piezas están separadas por una razón concreta cada una.

- **Dos conexiones.** Una lleva el lock del pipeline y la contabilidad de cuota; la otra, el
  catálogo, el histórico y el avance del checkpoint. Si compartieran transacción, un `ROLLBACK`
  de datos **borraría cuota ya gastada**.
- **Una transacción por página.** Estado, reconciliación, eventos y checkpoint se confirman juntos
  o no se confirman. El histórico no se puede reconstruir después, y un checkpoint adelantado
  saltaría una página que nunca se escribió.
- **El crudo se guarda al llegar, antes de parsearlo.** Lo pagado no se pierde aunque todo lo demás
  falle, y se puede **reproducir** sin gastar cuota.
- **El plan se escribe en la fila de la ejecución antes de la primera reserva**, y no en un fichero
  local.

## La cuota como recurso protegido

La API tiene 1.000 peticiones al mes en el plan gratuito. Todo el diseño de `jobs/ops/` gira en
torno a no pasarse **nunca**.

### Reservar antes de llamar

[`presupuesto.ts`](../jobs/ops/presupuesto.ts): el contador `requests_made` **se incrementa antes
de cada llamada**, en una transacción propia que se confirma de inmediato. Si el proceso muere, la
petición reservada **sigue contada**. El error va siempre en la dirección segura (sobrecontar,
nunca liberar cuota ya gastada) y el sobreconteo máximo por caída es de una petición. No existe
ningún contador en memoria: **la fuente de verdad es la fila**.

### El único punto con acceso a la red

[`transporte.ts`](../jobs/ops/transporte.ts) envuelve `fetch` con tres garantías:

1. **Primero la cuota.** Si se deniega, la línea lanza y no hay llamada.
2. **Solo `https:` y URL absoluta.** `http:` mandaría la credencial en claro.
3. **Tiempo máximo de 30 s por petición**, cuerpo incluido. No es una métrica de latencia, es un
   cerrojo: una conexión colgada se comería el `timeout-minutes` del job y GitHub mataría el
   proceso sin cerrar la fila.

Una petición que agota el tiempo **sigue contada**: pudo llegar al proveedor.

### Techos y «cero»

Cada pipeline tiene un **techo mensual** y un **tope por ejecución**. Existe además un umbral
global que manda siempre, por encima de la suma de los techos.

⚖️ **Cero significa «no autorizado», nunca «sin límite».** Registrar un pipeline nuevo obliga a
decidir su cuota a propósito, y un test exige que los pipelines de medición manual tengan tope 0.

### Dos guardias en orden fijo

1. **La externa**: lee las cabeceras de cuota del propio proveedor (`x-quota-*`, `x-quota-reset`) y
   se arma de antemano si otra ejecución ya registró un corte que aún no ha reiniciado.
2. **La interna**: la reserva de arriba.

La externa va primero para que una denegación suya no deje una reserva sin llamada detrás.

## Idempotencia y reanudación

- **Checkpoint en la propia base** ([`jobs/ops/checkpoint.ts`](../jobs/ops/checkpoint.ts)): cada
  ejecución guarda en `ops_sync_runs.checkpoint` desde dónde reanudar. Si se corta, la siguiente lo
  recoge.
- **Idempotencia por restricciones de la base**, no por código: reejecutar un pipeline dentro del
  mismo intervalo no escribe nada ([Base de datos](03-base-de-datos.md)).
- **Una ausencia cuenta una vez por observación.** El contador `missing_streak` se compara con el
  instante de la observación, de modo que un reintento o una reproducción del crudo nunca cuenta
  dos veces.
- **`deltas` mantiene un catálogo, no lo construye.** Sin estado previo, solo un aviso de alta
  justifica un evento: emitir «llegó» para ofertas que llevan años en otras plataformas fecharía
  hoy altas que nadie observó. Se escriben como línea base, sin evento.

## El seed y el ancla

El catálogo inicial se construye con **una sola captura** y se carga con el **mismo crudo** primero
en una rama de validación y después en producción. Su pieza clave es el **ancla**: el instante
desde el que la primera ventana de `deltas` cubre, sin hueco, todo lo que cambió después de la
captura. Con 24 h «a ojo» los cambios entre la captura y el primer `deltas` se perderían en silencio.

El seed tiene además una compuerta de verificación del crudo (huella, formato, continuidad) antes
de cargar, y su carga es idempotente: [`jobs/pipelines/seed/`](../jobs/pipelines/seed/).

## Protección de los destinos

Las operaciones que escriben tienen guardas que corren **al cargar el módulo, antes de que exista
un socket**:

- Conexión directa (se rechaza el *pooler*, que rompe bloqueos y DDL largo).
- Nombre del host de destino idéntico al declarado.
- Confirmación explícita del destino de la migración.
- Producción usa una **familia de variables distinta** y las dos familias no conviven en una
  sesión. Escribir en ella exige además una entrada en una lista de autorizaciones en código
  ([`jobs/ops/autorizacion-de-production.ts`](../jobs/ops/autorizacion-de-production.ts)), que
  está vacía por defecto.

## Cómo se prueba sin gastar cuota

- Los adaptadores se prueban con respuestas de ejemplo ficticias
  ([`tests/fixtures/`](../tests/fixtures/)).
- El transporte es una dependencia inyectada: los tests usan un doble y comprueban que se reserva
  una vez **por página**, que un HTTP no-2xx lanza y que `PresupuestoAgotado` no se captura.
- Los pipelines se pueden **reproducir desde el crudo** guardado con 0 peticiones.
