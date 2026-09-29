# Spike 2 — Resultados

**Fase 1 · Validación técnica.** Resuelve **D3** (vinext u OpenNext) y **D9** (Workers Free o Paid).
Código **desechable**: al cerrar el spike se destila en `docs/adr/0002-adaptador-y-hosting.md` y se borra.

- Fecha: 2026-09-21
- Máquina: Windows 11, Node v24.19.0, npm 11.17.0, gestor **npm**
- Versiones: `next` 16.3.5 · `react` 19.3.0 · **`vinext` 1.0.0-beta.10** · `wrangler` 4.136.0 · `vite` 8.3.0
- Neon: Free en **AWS `eu-central-1` (Fráncfort)**, endpoint *pooled*, tabla `spike_ping` con 3 filas
- Desplegado en: `https://spike-2.<subdominio-de-cuenta>.workers.dev` · Workers **Free** · coste **0 €**
- Consumo del spike: **~2.900 peticiones**, el 2,9 % de la cuota diaria de Free

**Veredicto: vinext (D3). Workers Free, con una restricción arquitectónica medida (D9).**
La Fase F (OpenNext) **no procede**: no se activó ningún criterio de bloqueo.

---

## 0. Límites vigentes del plan (E9) — verificados hoy, no supuestos

| Límite | Free | Paid |
|---|---|---|
| Peticiones | 100.000/día | sin límite |
| **CPU por invocación** | **10 ms** | 5 min (30 s por defecto) |
| Tamaño del worker | **64 MiB sin comprimir. Sin límite comprimido** | igual |
| Startup | 1 s | 1 s |
| Assets estáticos | 20.000 ficheros, 25 MiB c/u | 100.000 ficheros |
| Peticiones a assets | *"free and unlimited"*, no cuentan para la facturación de Workers | igual |
| **KV** | 100.000 lecturas/día · **1.000 escrituras a claves distintas/día** · 1 GB | de pago por uso |

### Divergencias con el Plan v1.0 §6 — se impone lo vigente

1. **El límite de 3 MiB comprimido en Free ya no existe** (retirado el 2026-09-04; ahora 64 MiB sin comprimir en todos los planes). → **Anula el criterio B-5 y la mitad «tamaño» de P-3.**
2. Paid no son 30 s de CPU sino **5 min** (30 s por defecto).
3. El límite de startup no es 400 ms sino **1 s**. Medido en el despliegue: **2 ms**.
4. Confirmado: **los assets estáticos no cuentan como peticiones de Worker.**

---

## 1. Fase A — Línea base Next.js (control)

| Métrica | Valor |
|---|---|
| Build en frío | **8,9 s** |
| Build en caliente | 6,4 s |
| JS de cliente | 575 KB |
| Rutas 200 | 11/11 |

```
○ /  ○ /cache  ○ /cliente  ○ /isr (1m)        estáticas, pre-renderizadas en build
● /titulo/uno · dos · tres                    SSG vía generateStaticParams
ƒ /db  ƒ /dinamica  ƒ /api/ping  ƒ /api/revalidate   dinámicas
```

### Hallazgo A-1 — `revalidateTag` cambió de firma en Next.js 16

La firma es **`revalidateTag(tag, profile)`** y el perfil decide el comportamiento:

| Llamada | ¿Invalida? |
|---|---|
| `revalidateTag("spike", "max")` | **No** |
| `revalidateTag("spike", { expire: 0 })` | **Sí** |
| `revalidatePath("/cache")` | Sí |

**Afecta al Plan §5**, donde los jobs refrescan el sitio con `revalidateTag`. La llamada correcta es `{ expire: 0 }`. No es cosa de vinext: es Next.js 16.

---

## 2. Fase B — vinext

### B1 · `vinext check` → **91 % compatible**

10 soportado, 0 parcial, 1 incidencia (`"type": "module"` ausente, que `vinext init` resuelve). Los 5 imports de `next/*` usados y la opción `env` de `next.config.ts`: totalmente soportados.

### B2 · `vinext init`

- **La skill del proyecto documenta `vinext init` a secas; el comando real exige `--platform`** y, en Cloudflare, también `--cdn-cache`, `--data-cache` e `--image-optimization`. Se niega a elegir por defecto.
- Configuración: `--platform=cloudflare --cdn-cache=workers-cache --data-cache=kv --image-optimization=none`.
  `image-optimization=none` porque Cloudflare Images es de pago y **D6 sigue abierta**.
  `response-store`, que vinext marca como recomendado, se descartó: **«Workers Response Store» no aparece en la documentación pública de Cloudflare**.

### B4 · `vinext build`

| Métrica | vinext | Next.js (control) |
|---|---|---|
| Build en frío | **4,7–5,1 s** | 8,9 s |
| Worker (subida real) | **1.282 KiB · 352 KiB gzip** | — |
| Cliente | 491 KB | 575 KB |
| Startup del Worker | **2 ms** (límite 1 s) | — |

1.282 KiB frente a 64 MiB: **el tamaño es irrelevante para D9.**

### B5b · Bajo `workerd` y en producción

**10/10 rutas responden 200** en ambos entornos: RSC · App Router · `[slug]` · `generateStaticParams` · `generateMetadata` · Route Handlers · hidratación · `next.config.ts` · variables de entorno.

### Hallazgo B-1 — el clasificador estático no reconoce rutas estáticas obvias · **el hallazgo central del spike**

`vinext build` deja rutas como **`? Unknown`**, no las pre-renderiza, y **el CDN las marca `BYPASS`**: se renderizan en el servidor en cada petición, para siempre.

| Ruta | Next.js | vinext | `cf-cache-status` |
|---|---|---|---|
| `/` | ○ Static | **? Unknown** | **BYPASS** |
| `/cache` | ○ Static | **? Unknown** | **BYPASS** |
| `/cliente` (antes) | ○ Static | **? Unknown** | **BYPASS** |
| `/cliente` (tras mitigar) | ○ Static | **○ Static** | **HIT** |
| `/estatica-forzada` | — | ○ Static | HIT |
| `/isr` | ○ Static (1m) | ◐ ISR (60s) | HIT |
| `/titulo/uno·dos·tres` | ● SSG | pre-renderizadas | HIT |

**Experimento de control:** `/estatica-forzada` es idéntica a `/` salvo por `export const dynamic = "force-static"`. Con esa línea se clasifica, se pre-renderiza y el CDN la cachea; sin ella, no.

**Mitigación verificada en producción.** Se añadió esa línea a `/cliente` y se redesplegó:

| `/cliente` | CPU p50 | CPU máx | `>10 ms` | `cf-cache` |
|---|---|---|---|---|
| Antes | 5 ms | **84 ms** | 8,8 % | BYPASS |
| Después | 4 ms | **16 ms** | 8,7 % | **HIT** |

**Consecuencia para la Fase 3:** Next.js infiere la estaticidad; **vinext exige declararla**. Debe entrar en `CLAUDE.md` como convención obligatoria: *toda página que deba ser estática declara su route segment config explícitamente*. No declararla no da error — da una página que se renderiza en cada petición y nunca se cachea.

### Hallazgo B-2 — el Plan §6 está desfasado sobre el pre-render

El Plan afirma: *"vinext no soporta pre-render en build"*. **Falso en beta.10**: existe `prerender: { routes: "*" }`, funciona y respeta `generateStaticParams`.

Lo que sí se confirma: **TPR (`--experimental-tpr`) requiere dominio propio** — *"zone analytics are unavailable on `*.workers.dev`"*. **No se ha podido probar.**

Matiz para D9: el HTML pre-renderizado va a `dist/server/prerendered-routes/` y a KV, **no a `dist/client/`**. No se sirve como asset gratuito: **cuenta para las 100.000 peticiones/día y para el CPU.**

### Hallazgo B-3 — divergencia de metadata

| Ruta | Next.js 16 | vinext |
|---|---|---|
| `/` | `Estatica` | **`Estatica · Spike 2`** |
| `/isr` | `ISR · Spike 2` | `ISR · Spike 2` |

Next.js no aplica `title.template` al segmento donde se define; vinext sí. Afecta al `<title>` de la portada. Menor, pero es SEO (§11) y no está documentado.

### Hallazgo B-4 — `.dev.vars` se copia en `dist/server/`, pero vinext lo protege

Verificado en el dry-run: ni `.dev.vars` ni ninguna credencial de Neon aparecen en lo que se sube. vinext genera un `.assetsignore` que excluye `wrangler.json`, `.dev.vars` y `.vite`. **No es un riesgo.**

### Hallazgo B-5 — `NEXT_PUBLIC_*` se incrusta en build

`/api/ping` devuelve en producción `publicaSiteUrl: "http://localhost:3000"`: el valor quedó fijado en el build desde `.env.local`. Los secretos de servidor sí se leen en runtime. **Las variables públicas hay que fijarlas antes de construir**, no después.

---

## 3. Fase C — Neon (resuelta)

| Prueba | Local (`workerd`) | **Producción** |
|---|---|---|
| C1 · `@neondatabase/serverless` por HTTP desde RSC | OK, 3 filas | **OK, 3 filas** |
| C2 · `drizzle-orm/neon-http` | OK, 3 filas | **OK, 3 filas** |
| C3 · Variables de entorno | `.dev.vars` | **secretos de Cloudflare** |

Latencia de la consulta en producción: **1.298 ms** la primera (despertar del autosuspend de Neon), **~135 ms p50** en caliente bajo ráfaga, desde Madrid a Fráncfort.

**→ Criterio de bloqueo B-3 descartado.**

### Secretos

`DATABASE_URL` y `REVALIDATE_SECRET` configurados como **`secret_text`**, no como variables públicas. Verificado en producción: `tieneDatabaseUrl: true`, `tieneRevalidateSecret: true`.

**`wrangler secret put` crea y despliega una versión nueva del Worker.** Confirmado: el despliegue generó la versión `ad7ae45b` (16:14:12) y cada `secret put` generó otra — `643bc2b1` (16:18:36) y `155bd6f0` (16:18:45). Tres versiones para un solo despliegue lógico. **Conviene subir los secretos antes o agruparlos**, para no multiplicar versiones.

---

## 4. Fase D — Despliegue en Workers Free

Desplegado sin incidencias. Bindings: `VINEXT_KV_CACHE`, `ASSETS`, `CF_VERSION_METADATA`. **Ningún producto de pago activado.**

### Incidencia operativa — el subdominio `*.workers.dev` se creó solo

Al ejecutarse en sesión no interactiva, **Cloudflare registró automáticamente el subdominio de cuenta como `<subdominio-de-cuenta>.workers.dev`**, tomando el nombre del Worker, sin solicitar confirmación. La URL resultante es `spike-2.<subdominio-de-cuenta>.workers.dev`.

Es una decisión **de cuenta**, no del spike. **Cloudflare permite cambiarlo después** desde *Workers & Pages → Your subdomain → Change*. Queda pendiente de decisión antes de usar la cuenta para Mirada Larga. **No se ha cambiado.**

---

## 5. Fase E — Mediciones en producción

### E1/E2 · Latencia desde España — **todas las peticiones servidas desde `MAD` (Madrid)**

30 peticiones por ruta, TTFB real hasta el primer trozo del cuerpo. Estado final, tras la mitigación:

| Ruta | p50 | p75 | p95 | `cf-cache` |
|---|---|---|---|---|
| `/titulo/uno` | **82 ms** | 93 | 129 | HIT |
| `/titulo/cuatro` | **83 ms** | 91 | 103 | HIT |
| `/isr` | **85 ms** | 87 | 127 | HIT |
| `/estatica-forzada` | **86 ms** | 91 | 131 | HIT |
| `/cliente` | **81 ms** | 88 | 99 | HIT |
| `/` | 100 ms | 119 | 197 | BYPASS |
| `/dinamica` | 103 ms | 110 | 151 | BYPASS |
| `/cache` | 113 ms | 124 | 162 | BYPASS |
| `/db` | 190 ms | 235 | 435 | BYPASS |
| `/logo.svg` · `/pixel.png` | 69–72 ms | | | HIT |

**0 errores** en 360 peticiones.

**→ Criterio §26.3 (TTFB < 200 ms desde España) CUMPLIDO** en todas las rutas cacheables, con holgura: 81–86 ms.

### E3 · Sobrecoste de primera petición

Primera petición a cada ruta tras el despliegue, frente al p50 en caliente:

| Ruta | 1.ª petición | p50 caliente | Δ |
|---|---|---|---|
| `/estatica-forzada` | 383 ms | 86 ms | +297 ms |
| `/db` | 342 ms | 190 ms | +152 ms |
| `/titulo/uno` | 302 ms | 82 ms | +220 ms |
| `/isr` | 298 ms | 85 ms | +213 ms |
| `/` | 218 ms | 100 ms | +118 ms |
| `/api/ping` | 56 ms | 89 ms | −33 ms |

**Se reporta como *first-request overhead*.** No se afirma que Cloudflare creara un isolate frío: no es observable de forma determinista desde fuera, y el caso de `/api/ping` (más rápida en frío que en caliente) desaconseja interpretarlo como cold start. Parte del sobrecoste es poblar la caché del CDN (`MISS` → `HIT`), no arranque de código.

### E4 · CPU por invocación — **la métrica decisiva**

Medido con `wrangler tail --format json`, que expone `cpuTime` **por evento y atribuido a cada URL**: no hace falta inferir por ventanas temporales. Ráfagas de 120 peticiones por ruta, separadas 4 s.

**1.169 invocaciones. Outcomes: `{"ok": 1169}`. `exceededCpu`: 0.**

Descartando las 5 primeras invocaciones de cada ruta:

| Ruta | CPU p50 | CPU p99 | CPU máx | `>10 ms` | `cf-cache` |
|---|---|---|---|---|---|
| `/dinamica` | 9 ms | **26 ms** | **70 ms** | **43,4 %** | BYPASS |
| `/cliente` (antes) | 5 ms | **61 ms** | **84 ms** | 8,8 % | BYPASS |
| `/` | 5 ms | 13 ms | 15 ms | 6,0 % | BYPASS |
| `/db` | 6 ms | 14 ms | 16 ms | 5,0 % | BYPASS |
| `/cache` | 5 ms | 14 ms | 49 ms | 3,2 % | BYPASS |
| `/estatica-forzada` | 3 ms | n/a | 18 ms | 3,2 % | HIT |
| `/isr` | 2 ms | n/a | 22 ms | 2,6 % | HIT |
| `/titulo/uno` | 3 ms | n/a | 14 ms | 1,1 % | HIT |
| `/api/ping` | 3 ms | 9 ms | 9 ms | 0,0 % | BYPASS |

`cpu_p99` solo se publica con n ≥ 100; donde la muestra no llega, se marca `n/a` en lugar de inventarlo.

**Dos hechos que conviene no mezclar:**

1. **Hubo invocaciones muy por encima de los 10 ms documentados** —hasta 70–84 ms— y **ninguna fue terminada**. Las 1.169 devolvieron `ok`. **No sé explicar el mecanismo desde fuera** (¿enforcement por media?, ¿margen de gracia?, ¿no aplicable a estas rutas?) y no lo invento. El hecho observado es ese; con 1.169 invocaciones a bajo volumen **no basta para concluir que el límite de Free no se aplique**.
2. **Las rutas cacheadas cuestan 2–3 ms; las `BYPASS`, 5–9 ms con colas largas.** La diferencia no es el código: es si el CDN sirve la respuesta.

**Comprobación de la hipótesis inicial.** Supuse que los picos serían las primeras invocaciones. **Era falso**: en `/dinamica` el 43 % de las peticiones *posteriores* superan los 10 ms. Los picos son del render, no del arranque.

### E5 · Ráfagas

| Ruta | Peticiones | Concurrencia | OK | Fallos | p50 | p99 |
|---|---|---|---|---|---|---|
| `/dinamica` | 500 | 20 | **500** | **0** | 264 ms | 691 ms |
| `/db` | 300 | 10 | **300** | **0** | 135 ms | 403 ms |

**Tasa de error: 0,00 %.** → **Criterio P-2 (SSR no fiable) no activado.**

### E6 · Caché de CDN

`cf-cache-status` separa limpiamente lo clasificado de lo no clasificado: **HIT** con `Age` creciente en rutas pre-renderizadas e ISR, **BYPASS** permanente en las `? Unknown`, **HIT** en los assets.

**Nota metodológica:** bajo `wrangler dev` todo salía `no-store` y nada se cacheaba. Era un artefacto del entorno local — el `wrangler.json` generado declara tres entrypoints y el local ejerce `default`, con `cache: { enabled: false }`; el cacheado real vive en `VinextCachedResponse`, sobre el edge. **Aplicada la regla acordada, no se registró como bloqueo, y el despliegue confirmó que habría sido un falso positivo.**

### E7 · ISR y revalidación — **funcionan en producción**

| Prueba | Resultado |
|---|---|
| `POST /api/revalidate` sin secreto | **401** |
| `revalidatePath("/isr")` sobre página cacheada en CDN | **Purga** — 16:19:27 → 16:21:05, y estabiliza |
| `revalidateTag("spike", { expire: 0 })` | **Invalida en ~5 s** |

**Corrección de una medición propia:** en el primer intento di `revalidateTag` por no funcional esperando 3 s. Era insuficiente: vinext usa un `tagCacheTtlMs` de 5 s por defecto y KV es eventualmente consistente. Repetido con márgenes de hasta 90 s, invalida dentro de los primeros 5 s y luego permanece estable.

**→ Criterio de bloqueo B-4 descartado.** La arquitectura del Plan §5 —jobs que refrescan el sitio con `revalidateTag`— es viable, contando con ~5 s de propagación.

### E8 · Escrituras de KV — **la restricción real de D9**

Estructura observada en el namespace:

```
cache:app:<build-id>:/<ruta>:html     ┐ 2 claves por pagina pre-renderizada
cache:app:<build-id>:/<ruta>:rsc      ┘
cache:unstable_cache:v2:<clave>       1 clave por entrada de datos
__tag:<etiqueta>                      1 marcador por etiqueta purgada
```

**Medido con un redespliegue real:**

| Momento | Claves |
|---|---|
| Tras el 1.er despliegue (6 rutas pre-renderizadas) | 11 + 3 = **14** |
| Tras el 2.º despliegue (7 rutas pre-renderizadas) | 11 + 13 + 3 = **27** |

Dos hechos:

1. **Cada despliegue escribe ~2 claves de KV por página pre-renderizada.**
2. **Las claves del despliegue anterior no se borran**: están versionadas por build-id y se acumulan.

`/titulo/dos`, `/titulo/tres` y `/404` estaban en KV **sin haberlas pedido nunca**: se escriben en el despliegue, no bajo demanda.

**Proyección a Mirada Larga** (catálogo de 5.000–15.000 títulos, Plan §21):

| Escenario | Escrituras de KV por despliegue | Límite Free |
|---|---|---|
| Pre-renderizar todo el catálogo | **10.000 – 30.000** | **1.000/día** |
| Pre-renderizar solo landings y páginas fijas (~50) | ~100 | holgado |

**Pre-renderizar el catálogo completo en build excede el límite diario de escrituras de KV de Free entre 10 y 30 veces.** Y el consumo se repite en cada despliegue, más el crecimiento de almacenamiento por acumulación de versiones.

Riesgo adicional cuantificable: si las fichas se pueblan por ISR bajo demanda, cada primera visita escribe 2 claves. Un rastreo de Googlebot de 500 páginas/día ya consume 1.000 escrituras.

---

## 6. D3 — ¿vinext u OpenNext?

| Criterio de bloqueo | Estado |
|---|---|
| B-1 · build o deploy fallan | **No** — ambos correctos |
| B-2 · falla RSC/App Router/`[slug]`/metadata/Route Handler | **No** — 10/10 en producción |
| B-3 · Neon/Drizzle no funcionan en el Worker | **No** — funcionan |
| B-4 · no hay revalidación | **No** — `revalidateTag` y `revalidatePath` funcionan |
| B-5 · el worker no cabe en Free | **Anulado** — el límite ya no existe |
| B-6 · `exceededCpu` sistemático | **No** — 0 de 1.169 |

## → **VEREDICTO D3: vinext.**

Ningún criterio de bloqueo activado. Conforme al Decision Freeze (§21), **no se ejecuta la Fase F ni se evalúa OpenNext**: no hay evidencia medida que justifique reabrir la decisión. Las carencias encontradas (B-1, B-3) son reales pero tienen mitigación barata y documentada.

---

## 7. D9 — ¿Workers Free o Paid?

| Criterio para pasar a Paid | Medición | ¿Activado? |
|---|---|---|
| **P-1 · CPU superada de forma recurrente** | p99 > 10 ms en 5 rutas y máx 84 ms, **pero 0 terminaciones en 1.169 invocaciones** | **Ambiguo — ver abajo** |
| **P-2 · SSR no fiable** | 0 errores en ~2.900 peticiones | No |
| **P-3 · Límites superiores necesarios** | Tamaño: anulado. **KV: el catálogo completo pre-renderizado excede 10–30×** | **Sí, condicionalmente** |
| **P-4 · El tráfico lo justifica** | 2,9 % de la cuota diaria durante todo el spike | No |

**Sobre P-1.** El criterio que yo mismo redacté decía *«p99 > 10 ms **o** cualquier `exceededCpu`»*. Fue un error de diseño: mezcla un indicador indirecto con el fallo real. Lo que importa es si las peticiones mueren, y **ninguna murió**. Pero el margen en rutas SSR es estrecho y no está explicado, así que no se declara resuelto: se declara **vigilado**.

## → **VEREDICTO D9: Workers Free.**

**Con una restricción arquitectónica medida, no con una advertencia genérica:**

> **Sobre el plan Free no se puede pre-renderizar el catálogo completo en build.** El límite de 1.000 escrituras de KV al día lo impide con cualquier catálogo por encima de ~400 páginas.

Esto **no** obliga a pasar a Paid. Obliga a decidir en la Fase 2/3 **qué se pre-renderiza**, y las opciones ya existen: pre-renderizar solo landings y páginas fijas y dejar las fichas en ISR bajo demanda; o bien TPR, que pre-renderiza únicamente lo que recibe tráfico —pero **exige dominio propio**, que aún no tenemos.

**No se contrata nada.** Los 5 $/mes de Paid caben en el presupuesto (§21), pero ningún criterio medido los justifica hoy.

### Qué habría que volver a medir antes de descartar Paid definitivamente

1. CPU con tráfico realista y páginas con datos reales, no con una app de nueve rutas triviales.
2. Escrituras de KV con la estrategia de pre-render que se elija en la Fase 3.
3. Si aparece `exceededCpu` en algún momento: mitigar primero (más caché, menos render, más trabajo en los jobs de GitHub Actions, §5) y volver a medir. Solo si persiste, proponer Paid con los números delante.

---

## 8. Lo que este spike NO ha probado

- **TPR (`--experimental-tpr`)** — requiere dominio propio.
- **`"use cache"` / `cacheComponents`** — se usó `unstable_cache`. El propio README de vinext avisa de que `cacheComponents` está incompleto.
- **Server Actions** — no se incluyeron.
- **`next/image` con optimización** — descartado a propósito mientras D6 siga abierta.
- **Comportamiento con tráfico sostenido** — la ráfaga mayor fueron 500 peticiones en 7 s.
- **OpenNext** — no procede, no hubo bloqueo.

---

## 9. Consecuencias para el resto del proyecto

1. **`CLAUDE.md`, convención nueva y obligatoria:** toda página que deba ser estática **declara su route segment config explícitamente**. Sin ella, vinext no la clasifica, no la pre-renderiza y el CDN la marca `BYPASS`. No da error: da una página lenta y cara para siempre.
2. **Plan §5:** los jobs deben llamar `revalidateTag(tag, { expire: 0 })` y contar con ~5 s de propagación.
3. **Plan §6:** corregir la afirmación sobre el pre-render de vinext y las cifras de límites de Cloudflare.
4. **Fase 3, decisión pendiente:** estrategia de pre-render del catálogo, condicionada por el límite de escrituras de KV.
5. **Cuenta de Cloudflare:** decidir si se renombra el subdominio `<subdominio-de-cuenta>.workers.dev`.
6. **Dominio propio:** desbloquearía TPR, que es la respuesta natural al problema de KV.

---

## 10. Verificación del cierre (criterios del plan del Spike 2)

- [x] Las rutas responden desde `*.workers.dev`, comparadas con la línea base de Next.js
- [x] **§26.3 — TTFB < 200 ms desde España**: 81–86 ms p50 en rutas cacheables, colo `MAD`
- [x] **§26.3 — `revalidateTag` refresca la página ISR**: demostrado, con ~5 s de propagación
- [x] **§26.3 — CPU y escrituras caben en Free**: CPU sí, 0 terminaciones; **KV solo si no se pre-renderiza el catálogo completo** — documentado
- [x] Tabla de incompatibilidades reales, separando lo documentado de lo descubierto aquí
- [x] **Veredicto D3** con los números que lo sostienen
- [x] **Veredicto D9** con los números que lo sostienen
- [x] Coste durante todo el spike: **0 €**
- [x] **Ningún componente de la web real construido**
- [x] `docs/adr/0002-adaptador-y-hosting.md` escrito y aceptado

**Spike 2 cerrado formalmente el 2026-09-21.** Las decisiones permanentes viven ya en el ADR 0002 y en `CLAUDE.md`; este documento conserva solo la evidencia bruta y **se borra junto con `spike-2/`** al inicializar el repositorio.

**No se avanza al Spike 3.**
