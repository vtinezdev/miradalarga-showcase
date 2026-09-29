# 7 · Sistema de diseño

La dirección visual se llama **«Luz de sala»**: una publicación editorial sobre el cine y las series
que se lee de noche, con una mano y en el sofá. Los valores viven en
[`src/styles/tokens.css`](../src/styles/tokens.css) y los componentes en
[`src/components/ui/`](../src/components/ui/).

Prioridad permanente: **UX > accesibilidad > rendimiento > consistencia visual > animación.**

## Cómo se implementa

- **Tokens como propiedades CSS en tres capas:** primitivo → semántico → componente. Los
  componentes solo leen tokens semánticos o de componente, nunca primitivos ni valores sueltos.
- **CSS nativo + CSS Modules.** Sin Tailwind, sin shadcn/ui y sin CSS-in-JS en ejecución: no había
  necesidad demostrada, cada uno sería una dependencia más, y el CSS-in-JS en ejecución choca con
  los Server Components.
- **Consultas de contenedor (`@container`)** para que tarjetas y filas se adapten a su hueco y no
  al viewport. Los puntos de corte (768, 1024 y 1440 px) gobiernan solo la retícula de página.
- **Mobile-first**, con 375 px como diseño de referencia. El responsive se considera durante la
  implementación, no después.

## Color

Dos familias, y ningún otro acento:

- **Tinta** (`--ink-*`): neutros cálidos, el negro de sala y no el gris azulado de las interfaces.
- **Latón** (`--brass-*`): el único acento.

Los estados del catálogo usan tonos apagados propios. Solo hay tema oscuro en el MVP, pero los
tokens semánticos ya están listos para uno claro. El contraste se ha **medido** contra WCAG 2.2,
no supuesto.

## Tipografía

| Rol | Familia | Por qué |
|---|---|---|
| Serif | **Newsreader** | Serif de lectura en pantalla con carácter editorial |
| Sans | **Schibsted Grotesk** | Sobria y con carácter; evita el aspecto SaaS de Inter |

- **Alojadas en el propio origen** (`@fontsource-variable`), nunca desde Google Fonts en ejecución:
  privacidad, RGPD y una conexión externa menos.
- `next/font` no se usa: en vinext cargaría desde el CDN de Google o inyectaría CSS en ejecución.
- 📏 Solo el eje de peso de Newsreader: con el eje óptico el subconjunto latino pesa 132 KB, y sin
  él 58 KB.
- Métricas de respaldo ajustadas (`size-adjust`) para que el texto no salte al cargar la fuente.
- **Escala fluida** entre 375 y 1440 px, en `rem`, de modo que el texto sigue escalando con el zoom
  del navegador (WCAG 1.4.4). Mínimo de 16 px en cualquier texto que se lea en frase.

## Movimiento

Principios ([`tokens.css`](../src/styles/tokens.css) y `base.css`):

1. **El movimiento explica una causa o es la firma de la marca; nunca decora.**
2. **El contenido es visible sin movimiento.** Nada queda invisible esperando a que se haga scroll.
3. **Nada se mueve solo:** sin autoavance, sin bucles. Lo que ocurre al llegar a una página ocurre
   una vez y dura menos de 0,6 s.
4. **Nunca se secuestra el scroll.** Lo vinculado al scroll lo observa; no lo frena ni lo sustituye.
5. **CSS primero.** Hoy todo es CSS más `IntersectionObserver`, `ResizeObserver` y la Web
   Animations API. Framer Motion no está instalado ni hace falta.
6. Solo se animan `opacity` y `transform`. Nada que cambie la maquetación.
7. Con `prefers-reduced-motion`, **todas las duraciones pasan a 0** y las animaciones de llegada ni
   se declaran. Ninguna función depende de una animación.

Hay **tres curvas y cinco duraciones**, por familia de uso (feedback, hover, reordenación, hojas y
transiciones editoriales), y ninguna más.

### Las seis interacciones de firma

| # | Interacción | Qué hace |
|---|---|---|
| 1 | **Horizonte vivo** | El motivo de la marca (una línea con un punto) como separador, respuesta al señalar, indicador de posición y progreso |
| 2 | **Rail editorial** | Scroll horizontal nativo con `scroll-snap`; la siguiente pieza siempre asoma; sin autoavance |
| 3 | **Índice invertido** | Al señalar una fila de ranking, el papel entra como cortinilla y el ordinal gana peso |
| 4 | **Mis plataformas** | Al marcar una, tus plataformas se deslizan arriba en «Dónde verla» |
| 5 | **Regla temporal del radar** | pasado ← **hoy** → futuro, un día por columna, con hoy marcado |
| 6 | **Cabecera contextual** | Se compacta al bajar sin cambiar su altura en el flujo y nunca se oculta |

Cada una tiene su equivalente táctil y de teclado.

## Imágenes: cartel tipográfico

Mientras no haya imágenes con base de uso aceptable, cada título tiene un **cartel tipográfico**
(`PlaceholderImage`) en lugar de un póster. Es una decisión de producto además de legal: se nota
que es editorial, no un hueco. **Nunca se usan URLs del proveedor.**

## Componentes

Organizados por función:

- **Estructura:** `Header`, `Footer`, `Navigation`, `MobileNavigation`, `PageHeader`,
  `Breadcrumbs`, `SectionHeader`.
- **Editorial:** `EditorialHero`, `EditorialCard`, `EditorialEntry`, `RailEditorial`, `Signature`.
- **Título y disponibilidad:** `PosterCard`, `AvailabilityPanel`, `AvailabilityRow`,
  `PlatformBadge`, `FreshnessStamp`.
- **Rankings y radar:** `RankedList`, `ReglaTemporal`, `ColumnasDeRadar`, `FilaDeMovimiento`,
  `CatalogEvent`.
- **Búsqueda y filtros:** `SearchInput`, `FilterChips`, `PlatformSelector`.
- **Estados:** `EmptyState`, y un tratamiento explícito de carga, error y «sin dato».

Cada componente tiene su CSS Module y usa tokens, no valores sueltos.

## Accesibilidad desde el diseño

- Contraste medido, foco visible (latón claro), objetivos táctiles suficientes y
  `aria-current="page"` en la navegación activa.
- Los menús y hojas se cierran con botón visible y con `Esc`.
- La disponibilidad de una ficha **sube justo bajo el título**: es la respuesta de los diez
  segundos, y un lector de pantalla la encuentra antes que el resto.
- Cifras tabulares solo donde se alinean en columna, no en texto corrido.
- Toda interacción tiene equivalente de teclado y funciona con movimiento reducido y sin
  JavaScript cuando es posible.
