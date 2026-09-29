# Cómo funciona Mirada Larga

Esta carpeta explica cómo está construida la web y qué hace cada parte. No es documentación
de operación ni un historial del proyecto: es el mapa para leer el código.

## Léelos en este orden

| # | Documento | Responde a |
|---|---|---|
| 1 | [Arquitectura](01-arquitectura.md) | ¿Qué piezas hay, cómo se hablan y qué reglas gobiernan el diseño? |
| 2 | [Ingesta de datos](02-ingesta.md) | ¿Cómo entran los datos del catálogo y cómo se protege la cuota de la API? |
| 3 | [Base de datos](03-base-de-datos.md) | ¿Cómo se modela el catálogo y qué garantiza PostgreSQL por sí mismo? |
| 4 | [Lectura del catálogo](04-lectura-del-catalogo.md) | ¿Cómo lee la web la base de datos sin conocer SQL ni al proveedor? |
| 5 | [La web](05-web.md) | ¿Qué pantallas hay, cómo se renderizan y se cachean? |
| 6 | [Rankings](06-rankings.md) | ¿Cómo se ordenan las listas y qué se niega a inventar? |
| 7 | [Sistema de diseño](07-sistema-de-diseno.md) | ¿Cómo se construye la interfaz y por qué se ve como se ve? |
| 8 | [Calidad y seguridad](08-calidad-y-seguridad.md) | ¿Qué comprueba el código por sí solo y cómo se protegen los secretos? |
| 9 | [Decisiones](09-decisiones.md) | ¿Qué se decidió, con qué evidencia y qué se descartó? |

## El proyecto en un párrafo

Mirada Larga es una guía editorial del streaming en España. Un conjunto de **jobs** consulta una
API de catálogo, normaliza lo que recibe y lo guarda en **PostgreSQL** (Neon). Una **web** en
Next.js, desplegada en Cloudflare Workers, lee esa base de datos con un usuario de solo lectura
y pinta fichas, listas, un radar de altas y bajas del catálogo y rankings con metodología
pública. Los jobs y la web no comparten código ni credenciales: **solo se comunican a través de
la base de datos**.

## Convenciones de estos documentos

- 📏 marca una cifra **medida** (con el spike o el test que la respalda).
- ⚖️ marca una **decisión** con su motivo.
- Los nombres de ficheros y directorios son los del repositorio: puedes abrirlos.
- El código y los comentarios están en español de España, igual que las rutas de la web.
