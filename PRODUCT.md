# PRODUCT.md — Mirada Larga

> Entregable de la **Fase 0** del Plan v1.0. Define qué construimos y para quién.
> Las decisiones técnicas están congeladas en el Plan v1.0 y no se tratan aquí.

---

## 1. Qué es Mirada Larga

**La guía editorial del streaming en España, construida sobre datos de catálogo vivos.**

Somos una publicación con criterio cuyas listas se mantienen actualizadas solas. No somos un buscador con blog.

El hueco que ocupamos: los medios de cine tienen criterio pero sus listas se pudren —recomiendan títulos que ya no están en la plataforma—, y los buscadores de disponibilidad tienen datos pero ningún criterio. Mirada Larga es lo único que tiene las dos cosas a la vez.

Respondemos, por orden de importancia:

1. **¿Qué merece la pena ver?** — con criterio explicado y firmado.
2. **¿Dónde lo veo?** — disponibilidad actual en España, con fecha de comprobación.
3. **¿Qué está pasando en los catálogos?** — qué llega y qué se va, con fechas.

---

## 2. Para quién

### Público primario — el suscriptor saturado que llega desde Google

Definido por **comportamiento, no por edad**:

- Tiene entre 2 y 4 suscripciones activas.
- Siente que tiene mucho contenido disponible y aun así le cuesta decidir.
- Llega buscando en Google: *mejores películas de Netflix*, *qué ver en Max*, *mejores series de ciencia ficción*, *películas de terror en Prime Video*, *dónde ver [título]*.
- Usa el móvil, normalmente por la noche, y quiere decidir en pocos minutos.
- Valora que la información esté actualizada.
- Quiere saber rápido si algo está incluido en **sus** plataformas.
- Vuelve si descubre que acertamos.

*(El rango 30–55 años es una hipótesis de audiencia, no una definición.)*

### Público secundario principal — el cazador de novedades

Le interesan los estrenos, qué llega esta semana, qué abandona una plataforma y los cambios de catálogo. Es el perfil con mayor potencial de recurrencia cuando lleguen newsletter y alertas (Fase 6).

### Audiencias futuras

- **Cinéfilo exigente** — requiere Filmin y Mubi, fuera del MVP. Algunas listas editoriales lo atraerán progresivamente, pero no nos posicionamos ahí hasta tener cobertura (D10).
- **Familias y hogares** — posible vertical futuro, condicionado a disponer de datos fiables de clasificación por edad. No inventamos datos.

---

## 3. Propuesta de valor

**"Qué merece la pena ver, y dónde verlo."**

Tres promesas, en este orden:

1. **Criterio** *(promesa principal, la que define la marca)* — te decimos qué merece la pena y por qué, con firma y fecha de revisión. No es un volcado ordenado por nota.
2. **Frescura demostrable** — cada dato lleva su fecha de comprobación. Si no sabemos algo, lo decimos en lugar de rellenarlo.
3. **Movimiento del catálogo** — qué acaba de llegar y qué se va, con fecha.

---

## 4. Diferenciadores

Ordenados por dificultad de copia:

1. **Listas editoriales que no caducan.** Nace de la arquitectura, no del esfuerzo: cuando un título sale de la plataforma, la lista lo sabe. Los medios no pueden igualarlo sin construir nuestra capa de datos; los buscadores de disponibilidad no pueden sin contratar redacción.
2. **Criterio explicado y separado.** Cada lista dice quién la firma, cuándo se revisó y con qué criterio. Lo editorial nunca se disfraza de algorítmico ni al revés.
3. **Movimiento del catálogo con fechas.** Tarda meses en madurar porque el histórico hay que acumularlo, pero nadie lo está haciendo en español.
4. **"Mis plataformas" sin registro.** Utilidad inmediata en la primera visita, sin el peaje de la cuenta.

### Dónde asumimos que perdemos

No competimos en exhaustividad de catálogo (JustWatch), volumen de notas y comunidad (FilmAffinity), ficha global y datos de industria (IMDb) ni velocidad de noticia (medios de cine y series).

---

## 5. Qué debemos hacer especialmente bien

Tres cosas. Si fueran diez, no serían prioridades.

1. **Resolver en diez segundos** si un título está en alguna de tus plataformas y si merece la pena. La respuesta va arriba, sin scroll, con fecha de comprobación.
2. **Que una lista se lea como escrita por alguien que ha visto eso.**
3. **Ir rápido en un móvil con mala conexión**, que es el contexto real del sofá.

---

## 6. Qué NO es Mirada Larga

- No es un catálogo exhaustivo.
- No es una red social ni un tablón de comentarios.
- No es un medio de última hora: no competimos en velocidad de noticia.
- No es un agregador de notas ajenas presentadas como propias.
- No es una granja de listas generadas con IA.
- No es una web que exija registro para ser útil.
- No es un clon visual de una plataforma de streaming.
- No enlaza ni insinúa contenido pirata.

---

## 7. Prioridades del MVP

### Listas editoriales — máxima calidad

20–30 listas y landings seleccionadas, cada una con: selección real de títulos, criterio claro, orden pensado, introducción original, explicación de por qué aparece cada título, autor identificado, fechas de publicación y revisión, enlazado interno útil, disponibilidad actualizada, intención de búsqueda concreta y buena presentación visual.

**20 listas excelentes antes que 100 mediocres.** Son las que construyen identidad, autoridad, diferenciación, tráfico y confianza.

### Fichas — infraestructura de información

Rápidas, completas, fiables y cuidadas, pero **sin texto editorial propio por título durante el MVP**. Resuelven: qué es, sinopsis, año, géneros, duración o temporadas, reparto y dirección, imágenes, valoración externa **claramente atribuida**, dónde verlo, tipo de oferta, plataforma, fecha de última comprobación, entradas y salidas del catálogo cuando haya histórico, listas en las que aparece y títulos relacionados cuando el dato sea fiable.

**No se generan críticas ni veredictos automáticos para miles de fichas.** Si un título ya tiene contenido editorial porque aparece en una lista, la ficha lo muestra o lo enlaza. El enriquecimiento editorial de fichas se asigna **según demanda real** detectada en Search Console, nunca por adelantado.

> **Fichas → utilidad, datos vivos y confianza. Listas → criterio, marca, SEO y diferenciación.**

### Estructura de la portada

1. **Hero editorial** — selección destacada, firmada, con explicación breve e imagen potente. No está obligada a rotar cada siete días: permanece mientras siga siendo relevante.
2. **Utilidad inmediata** — buscador, selector "Mis plataformas" y accesos a películas, series, estrenos y últimos días. No se esconden abajo.
3. **Selecciones editoriales.**
4. **Rankings automáticos**, claramente diferenciados de lo editorial.
5. **Radar de catálogo** — acaba de llegar, últimos días, próximamente donde haya dato fiable. Con protagonismo real.
6. **Exploración por plataformas y géneros**, como capa secundaria.

**La parrilla de pósters es recurso visual secundario, nunca estructura dominante.** Reproducirla sería recrear el problema que resolvemos.

En móvil el orden es: propuesta editorial → buscador → Mis plataformas → contenido recomendado → novedades y rankings.

---

## 8. Marca

| | |
|---|---|
| **Nombre** | **Mirada Larga** |
| **Dominio principal** | `miradalarga.com` — libre, verificado por RDAP el 2026-09-21 |
| **Tagline provisional (ES)** | *Qué merece la pena ver, y dónde verlo.* |
| **Tagline futuro (EN)** | Se localizará; **el nombre de marca no se traduce.** |

**Por qué Mirada Larga:** ver más lejos que el algoritmo. Criterio y perspectiva, que es exactamente nuestra promesa principal. No depende de plataformas ni de la palabra "streaming", que envejece, y puede crecer más allá del streaming.

**Requisito que decidió la elección — capacidad internacional.** Está prevista una versión en inglés. Lo que impide a una marca viajar no es ser opaca —Mubi, Hulu, Vimeo y Filmin no significan nada en ningún idioma y se llenan de sentido con el uso—, sino ser **impronunciable**. "Mirada Larga" tiene vocales simples y se dice sin esfuerzo en inglés; funcionará como marca opaca con tagline localizado. Su debilidad conocida y asumida son las cinco sílabas y las dos palabras.

**Descartados y por qué:**

- *Catalejo* — primera elección de la Fase 0; `catalejo.com` resultó no disponible en el registrador. Reabrió D7.
- *Ojo Fino* (`ojofino.com`, libre) — probablemente la marca más fuerte y expresiva en español de todas las exploradas, pero la jota la vuelve impronunciable para un angloparlante: sería un obstáculo fonético y obligaría a renombrar al internacionalizar.
- *Visto Bueno*, *Quevemos* — `.com` ocupados (confirmado por RDAP; el DNS había dado un falso positivo con Quevemos).
- *Altamirada* (libre) — escrita junta se lee "Altamira" y el reconocimiento se rompe.
- *Skopos, Opsis, Axia, Theatron, Lecta, Cerno* y el resto de raíces griegas y latinas — las mejores marcas globales posibles, todas con `.com` ocupado. Solo accesibles en el mercado secundario, fuera del presupuesto de 0–20 €/mes.
- Cualquier nombre con la raíz *-flix*, por riesgo de marca.

*Exploración: 198 nombres verificados por RDAP (registro autoritativo, no DNS). Hallazgo de referencia: el espacio de `.com` de una sola palabra pronunciable y con significado está agotado.*

---

## 9. Personalidad

**El que ha visto mucho y tiene buen ojo.** No el crítico de festival que te hace sentir inculto, ni la cuenta de redes que grita, ni el becario que copia sinopsis.

| Atributo | Cómo se nota |
|---|---|
| **Con criterio** | Descarta en voz alta, no solo recomienda. |
| **Honesto** | Admite lo que no sabe y pone fecha a lo que sabe. |
| **Práctico** | Respeta tu tiempo: la respuesta va arriba. |
| **Cinéfilo sin solemnidad** | Sabe de esto, pero no lo usa para impresionar. |

---

## 10. Tono editorial

Cercano y directo, con criterio.

- **Tuteo siempre.** Frases cortas. En móvil, párrafos de dos o tres líneas.
- **El veredicto tiene estructura fija:** qué es → qué aporta → para quién funciona. Dos o tres frases.
- **Obligatorio decir también para quién *no* es.** Si es lenta, larga o exigente, se dice.
- **Prohibido:** "no te lo pierdas", "la serie que está arrasando", "obra maestra" a la ligera, superlativos sin argumento, spoilers sin aviso, y reescribir la sinopsis haciéndola pasar por opinión.
- **Español de España**, sin anglicismos evitables ("serie limitada", no *limited series*), pero *streaming* y *thriller* se quedan porque es como habla la gente.
- **Los datos ajenos se atribuyen siempre; los propios se firman.**

### Forma del veredicto

**Texto breve argumentado**, sin nota numérica. 2–3 frases propias que expliquen por qué está en la lista, qué aporta, para qué espectador funciona y, si procede, qué advertencia tiene.

> *"No reinventa el thriller, pero ejecuta su propuesta con muchísimo ritmo y una tensión que apenas decae. Especialmente recomendable si buscas algo directo y entretenido para una noche."*

**Etiquetas cualitativas** como apoyo secundario, en conjunto pequeño y controlado: *Imprescindible · Joya escondida · Ideal para un fin de semana · Para fans de… · Fácil de ver · Exigente · Ritmo lento · Gran espectáculo*. Nunca sustituyen al texto.

**Sin nota editorial sobre 10 en el MVP**, porque obligaría a mantener una escala coherente, daría falsa precisión y nos pondría a competir con FilmAffinity e IMDb en su terreno. Queda como posible evolución futura si algún día hay volumen, autores y metodología suficientes.

### Estructura de una entrada editorial

```
Título
Contexto breve / datos esenciales
Etiqueta editorial (opcional)
Veredicto — 2-3 frases propias
Disponibilidad — desde nuestros datos vivos
```

---

## 11. Dirección visual inicial

*(No es el Design System. Son los principios que lo guiarán en la Fase 3.)*

**Oscuro cinematográfico con disciplina editorial.**

Advertencia de partida: la diferenciación frente a las plataformas **no está en el color de fondo, está en la estructura**. Un fondo oscuro no nos convierte en un clon; una portada de filas infinitas de pósters sí, sea del color que sea.

Principios:

- **Jerarquía tipográfica antes que imagen.** El titular manda; el póster ilustra. Es lo contrario a una plataforma.
- **Pósters en cantidades pequeñas y tamaños desiguales** según importancia. Nada de rejillas uniformes.
- **Mucho aire.** La sensación de calma es lo que nos separa del "no sé qué ver".
- **Un solo color de acento: latón / ámbar.** Todo lo demás, neutro. Evita el rojo (Netflix), el azul (Prime, Disney) y el morado (Max, SkyShowtime). *(Decisión tomada con el nombre anterior y mantenida: el ámbar funciona igual con Mirada Larga, como luz cálida en la distancia. Confirmado en el diseño del frontend del 2026-09-28: `docs/frontend/VISUAL-DIRECTION.md` y `docs/frontend/DESIGN-SYSTEM.md`.)*
- **La disponibilidad tiene tratamiento visual propio y consistente** —plataforma, tipo de oferta, fecha de comprobación—: es nuestro dato de confianza.
- **Los logos de plataformas, menos prominentes que nuestra marca**, conforme a sus condiciones y a la atribución exigida por el Plan v1.0.

Lo que evitamos: animaciones decorativas, vídeo de fondo, scroll animado constante y cualquier efecto que perjudique el rendimiento en móvil.

---

## 12. Estado de la Fase 0

**FASE 0 CERRADA.** Los doce puntos están resueltos, incluida **D7 (nombre y dominio)**.

El naming no se reabre salvo que aparezca un conflicto real de dominio o de marca registrada.

### Acciones pendientes de ejecución

| Acción | Notas |
|---|---|
| **Registrar `miradalarga.com`** | Libre según RDAP de Verisign el 2026-09-21. Registrar cuanto antes: la verificación no reserva el dominio. |
| **Comprobar conflicto de marca "Mirada Larga"** | Consulta en OEPM y EUIPO/TMview para las clases de información y entretenimiento. Único supuesto que reabriría D7. |
| **Solicitud a JustWatch Partners** | D4 del Plan v1.0. Respuesta lenta: se lanza ya. |
| **Alta en programas de afiliación** | D5. Amazon Associates, Apple Services Performance Partners y equivalentes. |

Siguiente paso: **Fase 1 — Validación técnica** (Spikes 1, 2 y 3 del Plan v1.0).
