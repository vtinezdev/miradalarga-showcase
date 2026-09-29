# 6 · Rankings

La web muestra tres tipos de lista. **Son distintas y no se mezclan nunca.**

| Lista | Qué es | Quién la decide |
|---|---|---|
| **A · Mejor valoradas** | Orden por valoración | Un algoritmo simple y público |
| **B · Popular esta semana** | Orden de popularidad del proveedor | El proveedor; nosotros solo filtramos |
| **C · Selección editorial** | Curación humana | Una persona, que firma con nombre y fecha |

## Tres reglas que no se negocian

1. **Una posición es un ordinal, nunca una puntuación.** No se convierte en una sin explicar la
   transformación exactamente donde se use.
2. **Un título sin posición en una ventana tiene «sin dato»**, jamás un valor inventado. «Sin dato»
   debe poder representarse en el esquema: es un requisito, no un detalle de presentación.
3. **Comparar dos ventanas no es medir movimiento en el tiempo.** Eso exige histórico propio.

En A y B **no se usa vocabulario editorial** («recomendamos», «nuestros expertos»). Si hay firma,
hay criterio humano detrás; si no la hay, es un ranking automático, y debe ser evidente sin leer
la letra pequeña.

## A · Mejor valoradas

**Regla:** de los títulos **con valoración**, **disponibles hoy** en alguna plataforma del MVP y con
**ficha mínima** (identificador, póster y año), se ordena por valoración descendente, en **dos
listas separadas: películas y series**. Los empates se deshacen por orden alfabético del título en
`es-ES` y, si aún empatan, por identificador.

Implementación: [`jobs/scoring/orden.ts`](../jobs/scoring/orden.ts), con tests en
[`tests/unit/orden.test.ts`](../tests/unit/orden.test.ts).

### El desempate es obligatorio

📏 Es el resultado más importante del análisis. **Sin desempate explícito, el Top 20 depende del
orden en que se leen los ficheros de ingesta**, es decir, el ranking deja de ser reproducible. Se
midió con barajados deterministas, no se supuso.

El desempate es **neutral a propósito**: usar año o popularidad metería una segunda señal dentro de
una lista que se anuncia como «mejor valoradas». El comparador usa `Intl.Collator("es-ES")` sin
opciones; añadirle `sensitivity` o `numeric` cambia el resultado, y por eso hay que volver a medir
si algún día se toca.

### El `0` del proveedor no es una nota

El proveedor emite `0` para «sin valoración todavía» (📏 alrededor del 1 % de la muestra, ninguno
entre 0 y 10, concentrados en los estrenos). Ordenarlo como una nota real hundiría los estrenos al
fondo de una lista de «mejor valoradas». La conversión `0 → null` ocurre **una sola vez, en el
adaptador**, y `null` **se excluye de A**: no se ordena al fondo.

### Películas y series por separado

Es una decisión de producto, no una imposición del dato: quien busca «qué serie veo» no quiere una
lista donde compitan una película y una serie.

### Lo que A se niega a hacer

- **Sin media bayesiana:** la fuente no da número de votos y no hay sustituto honesto.
- **Sin umbral de valoración** mientras no exista una justificación independiente y reproducible.
- **No se exige sinopsis:** falta en buena parte del catálogo por un hueco de traducción, no de dato.

### Límite declarado

A no distingue evidencia: la valoración alta de un estreno pesa igual que la de un clásico, y con
esta fuente no se puede resolver. Se mitiga, no se resuelve, con **revisión editorial del Top 20**
antes de publicar y declarándolo en la página de metodología.

## B · Popular esta semana

**Regla:** se toma el orden de popularidad semanal para España, en películas y series por separado,
limitado a títulos disponibles hoy y con ficha mínima. Cuando el dato existe, cada título muestra
su relación con la ventana mensual: «más arriba en la semana que en el mes» o «aparece en la semana
y no en el mes». **Sin posición mensual no se inventa ninguna.**

### Por qué solo se compara con la ventana mensual

📏 Solapamiento medido entre ventanas:

| Par | Películas | Series |
|---|---|---|
| semana ∩ mes | 53 % | 55 % |
| semana ∩ año | 10 % | 7,5 % |
| semana ∩ histórico | 0 % | 5 % |

Las ventanas no son versiones suaves de lo mismo: **son universos distintos**. Comparar ventanas
lejanas es hacer aritmética sobre conjuntos que apenas se tocan. La única con solapamiento
suficiente es la mensual.

### Una variante descartada con dato

Se descartó promediar los rangos de las cuatro ventanas: no por gusto, sino porque el solapamiento
no da para promediar posiciones de conjuntos casi disjuntos.

### Reglas propias de B

- **No se filtra por valoración.** Dejaría fuera estrenos legítimamente populares, que es donde vive
  esta lista.
- **No existe puntuación de popularidad**, solo ordenación.
- ❓ **Límite vigente:** la ordenación por popularidad solo está medida en una plataforma. Las demás
  exigen medición antes de publicar B para ellas, y esa condición es una capacidad más de la matriz
  por plataforma.

## C · Selección editorial

Curación humana, sin algoritmo: orden manual, texto propio por título, autor y fecha de revisión,
distintivo visual claro y marcado acorde. **No se genera automáticamente** y nunca se mezcla con A
ni con B.

## Otras listas y el Top 10 oficial

- **Lo más visto de siempre en España** es una lista propia y **nunca se mezcla con la semanal**:
  es un dato excelente y muy español, pero no mide tendencia.
- El **Top 10 oficial de cada plataforma** es una señal separada y atribuida: es el de la
  plataforma, no el nuestro. Se muestra tal cual y **nunca se usa como insumo ni sustituto** de A o
  B. Si una plataforma no lo publica, **se omite el bloque**: no se rellena con un ranking propio
  disfrazado.

## Reglas de publicación

- **Mínimo de títulos por lista:** si no se alcanza, no se publica.
- **Máximo de 2 títulos de la misma franquicia** en el top 10.
- **Histéresis:** el orden no debe bailar a diario.
- **Metodología pública** que declare, para cada lista, **lo que no sabemos**.
- **Revisión editorial** del Top 20 antes de publicar.

## Cómo lo representa el modelo de datos

`derived_ranking_definitions` guarda la definición pública de cada lista (clave, tipo algorítmico o
editorial, señal de origen, filtros y `formula_version`) y `derived_ranking_entries` guarda posición
y desglose por título:

- para A: la valoración y los filtros superados;
- para B: **las posiciones ordinales por ventana y el literal «sin dato»** cuando no hay posición.

Pasar a una fórmula ponderada será **un cambio de pesos y una versión nueva**, no una reescritura.
Esa fórmula avanzada no se diseña hasta que exista histórico propio: **no se inventan métricas que
la fuente no proporciona.**
