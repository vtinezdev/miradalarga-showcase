/**
 * Análisis de la **primera validación real** de `/changes`. Funciones puras.
 *
 * Aquí no hay red ni base de datos: el harness
 * (`scripts/validate-changes-live.ts`) pide las páginas y este módulo decide
 * qué pedir, qué mirar y si una premisa se sostiene. Así la parte que razona
 * se prueba offline, y lo único que necesita cuota es la que habla por cable.
 *
 * ── Qué se valida, y por qué solo esto ──────────────────────────────────────
 *
 * Las cinco premisas que la auditoría del corpus **no pudo** cerrar, porque
 * todas las respuestas del Spike 1 se quedaron en la página 1. Nada más: este
 * harness no escribe catálogo ni histórico.
 */
import type { TipoDeCambio } from "../../adapters/contracts.ts";
import type { RespuestaCambiosProveedor } from "../../adapters/streaming-availability/schema.ts";

/**
 * **Tope absoluto de esta validación, independiente de los presupuestos del
 * pipeline.**
 *
 * No es un valor por defecto que nadie pueda heredar: es lo que esta prueba
 * concreta tiene autorizado. El harness lo inyecta además como
 * `topePorEjecucion`, para que el corte lo haga `reservar()` y no la buena
 * voluntad de este fichero.
 */
export const MAXIMO_DE_REQUESTS = 5;

/** Una petición del plan: qué pedir y con qué cursor. */
export interface PasoDeValidacion {
  readonly tipo: TipoDeCambio;
  readonly pagina: number;
  readonly cursor: string | null;
}

/** Un contraste entre el `timestamp` del aviso y el `expiresOn` del snapshot. */
export interface Contraste {
  readonly showId: string;
  readonly link: string | null;
  readonly timestampDelAviso: number;
  readonly expiresOnDelSnapshot: number;
  readonly coinciden: boolean;
  readonly diferenciaSegundos: number;
}

/** Lo observado en una página. Es la unidad del informe. */
export interface ObservacionDePagina {
  readonly tipo: TipoDeCambio;
  readonly pagina: number;
  readonly cursorEnviado: string | null;
  readonly resultCount: number;
  readonly hasMore: boolean;
  readonly cursorRecibido: string | null;
  readonly numeroDeCambios: number;
  readonly numeroDeShows: number;
  readonly showIdsSinResolver: readonly string[];
  readonly showIdsSobrantes: readonly string[];
  /** Huella de los avisos, para detectar que el cursor devolvió lo mismo. */
  readonly huella: string;
  readonly contrastes: readonly Contraste[];
  readonly contrastablesDescartados: number;
}

/**
 * Qué pedir a continuación. **Determinista y acotado a `MAXIMO_DE_REQUESTS`.**
 *
 * El orden persigue cerrar cuanto antes lo que más vale: una segunda página
 * real —lo único que prueba el cursor y la cobertura de `shows`— antes que
 * profundizar en ninguna lista.
 *
 *   1. `expiring`  página 1   con ventana e `include_unknown_dates=false`
 *   2. `expiring`  página 2   con el cursor recibido
 *   3. `upcoming`  página 1   con ventana e `include_unknown_dates=false`
 *   4. `upcoming`  página 2   con el cursor recibido
 *   5. la profundidad que quede: 3ª de `expiring`, o 3ª de `upcoming`
 *
 * Una página 2 **solo se pide si la 1 dijo que había más y dio cursor**:
 * gastar una request para confirmar el final de una lista no prueba nada.
 */
export function siguientePaso(
  observadas: readonly ObservacionDePagina[],
): PasoDeValidacion | null {
  if (observadas.length >= MAXIMO_DE_REQUESTS) return null;

  const ultimaDe = (tipo: TipoDeCambio): ObservacionDePagina | undefined =>
    [...observadas].reverse().find((o) => o.tipo === tipo);

  const continuacion = (tipo: TipoDeCambio): PasoDeValidacion | null => {
    const ultima = ultimaDe(tipo);
    if (ultima === undefined) return { tipo, pagina: 1, cursor: null };
    if (!ultima.hasMore || ultima.cursorRecibido === null) return null;
    return { tipo, pagina: ultima.pagina + 1, cursor: ultima.cursorRecibido };
  };

  // Las cuatro primeras, en orden fijo: dos por lista.
  for (const tipo of ["expiring", "upcoming"] as const) {
    const ultima = ultimaDe(tipo);
    if (ultima === undefined) return { tipo, pagina: 1, cursor: null };
    if (ultima.pagina < 2) {
      const paso = continuacion(tipo);
      if (paso !== null) return paso;
    }
  }

  // La quinta: profundidad, donde todavía quede algo que medir.
  return continuacion("expiring") ?? continuacion("upcoming");
}

function huellaDeAvisos(respuesta: RespuestaCambiosProveedor): string {
  return respuesta.changes
    .map(
      (c) =>
        `${c.showId}|${c.service.id}|${c.streamingOptionType}|${String(c.timestamp)}`,
    )
    .join("\n");
}

/**
 * Contrasta el `timestamp` de un aviso `expiring` con el `expiresOn` de la
 * opción que le corresponde en el snapshot.
 *
 * 📏 El diseño usa ese `timestamp` como instante de expiración **por
 * inferencia**: cae dentro de la ventana pedida y es futuro en 25 de 25. Esto
 * es lo que convierte la inferencia en medición — o la desmiente.
 *
 * Solo se contrastan los pares donde **existen los dos** valores. Un aviso sin
 * `expiresOn` en el snapshot no es un desacuerdo: es un dato que no consta, y
 * se cuenta aparte en vez de puntuar como acierto o como fallo.
 */
export function contrastarExpiracion(respuesta: RespuestaCambiosProveedor): {
  readonly contrastes: readonly Contraste[];
  readonly descartados: number;
} {
  const contrastes: Contraste[] = [];
  let descartados = 0;

  for (const cambio of respuesta.changes) {
    if (cambio.changeType !== "expiring") continue;

    const show = respuesta.shows[cambio.showId];
    const opciones = show?.streamingOptions?.es ?? [];
    const opcion = opciones.find(
      (o) =>
        o.service.id === cambio.service.id &&
        o.type === cambio.streamingOptionType &&
        (cambio.link === undefined || o.link === cambio.link) &&
        (cambio.addon?.id ?? null) === (o.addon?.id ?? null),
    );

    if (opcion?.expiresOn === undefined) {
      descartados++;
      continue;
    }

    const diferencia = cambio.timestamp - opcion.expiresOn;
    contrastes.push({
      showId: cambio.showId,
      link: cambio.link ?? null,
      timestampDelAviso: cambio.timestamp,
      expiresOnDelSnapshot: opcion.expiresOn,
      coinciden: diferencia === 0,
      diferenciaSegundos: diferencia,
    });
  }

  return { contrastes, descartados };
}

export function analizarPagina(
  paso: PasoDeValidacion,
  respuesta: RespuestaCambiosProveedor,
): ObservacionDePagina {
  const { changes, shows } = respuesta;
  const claves = new Set(Object.keys(shows));
  const referenciados = new Set(changes.map((c) => c.showId));

  const { contrastes, descartados } = contrastarExpiracion(respuesta);

  return {
    tipo: paso.tipo,
    pagina: paso.pagina,
    cursorEnviado: paso.cursor,
    // La respuesta no trae ningún `result_count` propio: el recuento es el
    // número de avisos que vienen dentro. No se inventa una cifra del
    // proveedor para rellenar una columna del informe.
    resultCount: changes.length,
    hasMore: respuesta.hasMore ?? false,
    cursorRecibido: respuesta.nextCursor ?? null,
    numeroDeCambios: changes.length,
    numeroDeShows: claves.size,
    showIdsSinResolver: [...referenciados].filter((id) => !claves.has(id)),
    showIdsSobrantes: [...claves].filter((id) => !referenciados.has(id)),
    huella: huellaDeAvisos(respuesta),
    contrastes,
    contrastablesDescartados: descartados,
  };
}

// ── Las cinco premisas ──────────────────────────────────────────────────────

/**
 * ⚠️ **`parcial` no es un aprobado, y `sin_datos` tampoco.**
 *
 * `ok` significa medido y cerrado. `parcial` significa que lo observado es
 * cierto pero **incompleto** —el caso del volumen: con `hasMore=true` la cifra
 * es un mínimo y el total sigue sin agotarse—. Fundirlos en un `ok` seria
 * exactamente lo que `docs/DATA-SOURCES.md` prohibe: presentar un minimo como
 * si fuera el total.
 */
export type EstadoDePremisa = "ok" | "parcial" | "fallo" | "sin_datos";

export interface Veredicto {
  readonly numero: number;
  readonly premisa: string;
  readonly estado: EstadoDePremisa;
  readonly detalle: string;
}

/**
 * ⚠️ **`sin_datos` no es un aprobado.** Si la prueba se quedó sin cuota antes
 * de poder mirar, la premisa sigue sin medir y el informe tiene que decirlo
 * con esa palabra: convertir un silencio en un «ok» es exactamente el error
 * que `docs/DATA-SOURCES.md` prohíbe.
 */
export function evaluarPremisas(
  observadas: readonly ObservacionDePagina[],
): readonly Veredicto[] {
  const segundas = observadas.filter((o) => o.pagina >= 2);
  const primeras = observadas.filter((o) => o.pagina === 1);

  // 1 ─ El cursor funciona: hay una página 2 y NO repite la 1.
  const repetidas = segundas.filter((segunda) =>
    observadas.some(
      (otra) =>
        otra.tipo === segunda.tipo &&
        otra.pagina === 1 &&
        otra.huella === segunda.huella,
    ),
  );
  const premisa1: Veredicto =
    segundas.length === 0
      ? {
          numero: 1,
          premisa: "cursor=nextCursor devuelve la página 2",
          estado: "sin_datos",
          detalle: "Ninguna lista dio hasMore + cursor, o no alcanzó la cuota.",
        }
      : repetidas.length > 0
        ? {
            numero: 1,
            premisa: "cursor=nextCursor devuelve la página 2",
            estado: "fallo",
            detalle:
              `El cursor fue ignorado en ${String(repetidas.length)} caso(s): ` +
              `la página 2 devolvió exactamente los mismos avisos que la 1.`,
          }
        : {
            numero: 1,
            premisa: "cursor=nextCursor devuelve la página 2",
            estado: "ok",
            detalle: `${String(segundas.length)} página(s) 2+ con avisos distintos de la 1.`,
          };

  // 2 ─ `shows` cubre también las páginas ≥ 2.
  const sinResolver = segundas.reduce((n, o) => n + o.showIdsSinResolver.length, 0);
  const premisa2: Veredicto =
    segundas.length === 0
      ? {
          numero: 2,
          premisa: "shows cubre los showId en páginas >= 2",
          estado: "sin_datos",
          detalle: "No se llegó a ninguna página 2.",
        }
      : sinResolver === 0
        ? {
            numero: 2,
            premisa: "shows cubre los showId en páginas >= 2",
            estado: "ok",
            detalle: `0 showId sin resolver en ${String(segundas.length)} página(s) 2+.`,
          }
        : {
            numero: 2,
            premisa: "shows cubre los showId en páginas >= 2",
            estado: "fallo",
            detalle: `${String(sinResolver)} showId sin su show en páginas 2+.`,
          };

  // 3 ─ `include_unknown_dates=false` se acepta. Va en TODAS las peticiones
  //     con ventana, así que una sola respuesta 200 ya lo demuestra.
  const premisa3: Veredicto =
    primeras.length === 0
      ? {
          numero: 3,
          premisa: "include_unknown_dates=false es aceptado",
          estado: "sin_datos",
          detalle: "No se completó ninguna petición con ventana.",
        }
      : {
          numero: 3,
          premisa: "include_unknown_dates=false es aceptado",
          estado: "ok",
          detalle: `${String(observadas.length)} respuesta(s) 200 enviándolo.`,
        };

  // 4 ─ Profundidad real. Con `hasMore` en la última página observada, la
  //     cifra es un MÍNIMO y se comunica como tal, nunca como el total.
  const profundidad = (["expiring", "upcoming"] as const).map((tipo) => {
    const paginas = observadas.filter((o) => o.tipo === tipo);
    if (paginas.length === 0) return `${tipo}: sin datos`;
    const ultima = paginas[paginas.length - 1];
    const avisos = paginas.reduce((n, o) => n + o.numeroDeCambios, 0);
    const cierre =
      ultima?.hasMore === true ? " (hasMore: es un MÍNIMO)" : " (lista agotada)";
    return `${tipo}: >= ${String(paginas.length)} pág. / ${String(avisos)} avisos${cierre}`;
  });
  // Mientras alguna lista siga diciendo `hasMore`, lo medido es un SUELO y la
  // premisa no esta cerrada: el total exacto no se ha agotado.
  const quedaCola = observadas.some((o) => {
    const siguientes = observadas.filter(
      (otra) => otra.tipo === o.tipo && otra.pagina > o.pagina,
    );
    return o.hasMore && siguientes.length === 0;
  });
  const premisa4: Veredicto = {
    numero: 4,
    premisa: "volumen real de expiring y upcoming",
    estado: observadas.length === 0 ? "sin_datos" : quedaCola ? "parcial" : "ok",
    detalle: profundidad.join(" · "),
  };

  // 5 ─ El `timestamp` de `expiring` contra el `expiresOn` del snapshot.
  const todos = observadas.flatMap((o) => o.contrastes);
  const descartados = observadas.reduce((n, o) => n + o.contrastablesDescartados, 0);
  const discrepantes = todos.filter((c) => !c.coinciden);
  const premisa5: Veredicto =
    todos.length === 0
      ? {
          numero: 5,
          premisa: "timestamp de expiring == expiresOn del snapshot",
          estado: "sin_datos",
          detalle: `Ningún par contrastable (${String(descartados)} sin expiresOn).`,
        }
      : discrepantes.length === 0
        ? {
            numero: 5,
            premisa: "timestamp de expiring == expiresOn del snapshot",
            estado: "ok",
            detalle:
              `${String(todos.length)} de ${String(todos.length)} coinciden al segundo ` +
              `(${String(descartados)} sin expiresOn, no contrastables).`,
          }
        : {
            numero: 5,
            premisa: "timestamp de expiring == expiresOn del snapshot",
            estado: "fallo",
            detalle:
              `${String(discrepantes.length)} de ${String(todos.length)} NO coinciden. ` +
              `Mayor diferencia: ${String(
                Math.max(...discrepantes.map((c) => Math.abs(c.diferenciaSegundos))),
              )} s. El diseño usa ese timestamp como expires_at.`,
          };

  return [premisa1, premisa2, premisa3, premisa4, premisa5];
}
