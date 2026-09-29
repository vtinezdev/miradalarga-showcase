# Fixtures de prueba: datos ficticios

Todo lo que hay en esta carpeta es **ficticio**. Los ficheros tienen la **estructura y la forma
exactas** de las respuestas del proveedor de datos (que es lo que necesitan los tests de contrato y
de los pipelines), pero **no contienen datos reales**.

## Qué se ha inventado y qué se ha conservado

| Se ha sustituido | Por |
|---|---|
| Títulos y títulos originales | `Título ficticio 001`, `Original ficticio 001`… |
| Sinopsis | `Sinopsis ficticia de ejemplo número N.` |
| Reparto, dirección y autoría | `Persona Ficticia NNN`, `Creador Ficticio NNN` |
| Identificadores (`id`, `imdbId`, `tmdbId`) | Valores sintéticos: `5000000+`, `tt9000000+`, `movie/900000+` |
| Enlaces a las plataformas (`link`, `videoLink`) | `https://<plataforma>/ficticio/NNNN`, conservando el dominio |
| Cursores de paginación | El identificador se sustituye y el resto se anula |

| Se ha conservado | Por qué importa |
|---|---|
| La **estructura** (claves, anidamiento, tipos) | Es lo que valida el adaptador |
| Números: valoración, duración, año, precios, timestamps | Los tests dependen de ellos |
| Cardinalidades: cuántos avisos, opciones o páginas hay | Los tests cuentan resultados |
| El **orden relativo** de los identificadores y de los títulos | Los desempates dependen del orden alfabético y por identificador |
| Que un mismo show tenga el mismo identificador en varios ficheros | Varios tests cruzan ficheros |
| Los nombres de plataforma y de idioma, y las URL de sus logotipos | Son referencia de plataformas, no contenido |
| Las URL de imagen, con la firma **redactada** | El parser de imágenes necesita su forma; el identificador del show sí es ficticio |

Cada fichero lleva `aviso_ficticio` al principio de `meta` para que no se confunda con una
respuesta real.

## Por qué así, y no con datos reales recortados

El proveedor no autoriza redistribuir su catálogo, y publicar una muestra real en un repositorio
abierto sería exactamente eso. Anonimizar conservando forma y orden permite mantener los mismos
tests con las mismas aserciones, sin depender de un dato que no es nuestro.

## Cómo se generaron

Con un script determinista de una sola pasada: recoge los valores distintos de cada tipo, los
ordena y asigna sustitutos preservando el orden relativo. Los literales de los tests que nombraban
un show concreto se actualizaron a mano a sus equivalentes ficticios, y toda la suite sigue
pasando con las mismas aserciones.
