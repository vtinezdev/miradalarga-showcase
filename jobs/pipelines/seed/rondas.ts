/**
 * **Recorrido por rondas** de los 12 estratos (ADR 0009 §1). Máquina de estados
 * pura: no pide nada ni lee nada. La usan la captura —para decidir qué página
 * pedir— y la verificación —para comprobar que el crudo siguió estas reglas—.
 * Una sola implementación: las dos no pueden discrepar.
 *
 *   · **Una ronda pide una página de cada estrato no agotado**, en el orden del
 *     plan. Un estrato se agota cuando responde `hasMore=false`.
 *   · **El criterio de parada se evalúa al cerrar cada ronda, nunca a mitad**:
 *     `objetivo_alcanzado` si los elegibles únicos llegan al objetivo,
 *     `catalogo_agotado` si ya no queda ningún estrato. Cerrar la ronda cuesta
 *     como mucho 11 páginas más y deja todos los estratos con la misma
 *     profundidad.
 *   · **Cursor sin progreso:** con `hasMore=true`, un `nextCursor` nulo, vacío
 *     o ya usado **en ese estrato** detiene el recorrido sin pedir otra página
 *     (la misma guarda que `/changes`, `deltas/origen.ts`).
 */

export interface EstadoDeEstrato {
  readonly estrato: string;
  /** El cursor con el que se pedirá su próxima página. `null` = la primera. */
  readonly cursorDeEntrada: string | null;
  readonly agotado: boolean;
  readonly paginas: number;
  /** Cursores ya usados como entrada en este estrato. */
  readonly cursoresUsados: readonly string[];
}

export interface EstadoDeRondas {
  /** La ronda en curso, desde 1. */
  readonly ronda: number;
  /** Todos los estratos, en el orden del plan. */
  readonly estratos: readonly EstadoDeEstrato[];
  /** Los de la ronda en curso que faltan por pedir, en orden. */
  readonly pendientesDeLaRonda: readonly string[];
  /** Páginas ya registradas en la ronda en curso. */
  readonly pedidasEnLaRonda: number;
}

export interface PeticionDeRonda {
  readonly estrato: string;
  readonly ronda: number;
  readonly cursorDeEntrada: string | null;
}

export type MotivoDeParada = "objetivo_alcanzado" | "catalogo_agotado";

export function iniciarRondas(estratos: readonly string[]): EstadoDeRondas {
  if (estratos.length === 0 || new Set(estratos).size !== estratos.length) {
    throw new Error("Las rondas necesitan estratos, sin repetidos.");
  }
  return {
    ronda: 1,
    estratos: estratos.map((estrato) => ({
      estrato,
      cursorDeEntrada: null,
      agotado: false,
      paginas: 0,
      cursoresUsados: [],
    })),
    pendientesDeLaRonda: [...estratos],
    pedidasEnLaRonda: 0,
  };
}

/** La página que toca pedir, o `null` si la ronda en curso ya está completa. */
export function siguientePeticion(estado: EstadoDeRondas): PeticionDeRonda | null {
  const estrato = estado.pendientesDeLaRonda[0];
  if (estrato === undefined) return null;
  const e = estado.estratos.find((x) => x.estrato === estrato);
  if (e === undefined) throw new Error(`Estrato desconocido: ${estrato}.`);
  return { estrato, ronda: estado.ronda, cursorDeEntrada: e.cursorDeEntrada };
}

export type ResultadoDePagina =
  | { readonly tipo: "ok"; readonly estado: EstadoDeRondas }
  | {
      readonly tipo: "cursor_sin_progreso";
      readonly estado: EstadoDeRondas;
      readonly estrato: string;
      readonly cursorDeEntrada: string | null;
      readonly nextCursor: string | null;
    };

/**
 * Registra la página **que tocaba**. Registrar otra es un error de programación
 * y lanza: el orden lo decide `siguientePeticion`, no quien llama.
 */
export function registrarPagina(
  estado: EstadoDeRondas,
  pagina: {
    readonly estrato: string;
    readonly hasMore: boolean;
    readonly nextCursor: string | null;
  },
): ResultadoDePagina {
  const tocaba = siguientePeticion(estado);
  if (tocaba?.estrato !== pagina.estrato) {
    throw new Error(
      `Se registró ${pagina.estrato} y tocaba ${tocaba?.estrato ?? "cerrar la ronda"}.`,
    );
  }
  const previo = estado.estratos.find((x) => x.estrato === pagina.estrato);
  if (previo === undefined) throw new Error(`Estrato desconocido: ${pagina.estrato}.`);

  const usados =
    previo.cursorDeEntrada === null
      ? previo.cursoresUsados
      : [...previo.cursoresUsados, previo.cursorDeEntrada];
  const pendientes = estado.pendientesDeLaRonda.slice(1);

  const sinProgreso =
    pagina.hasMore &&
    (pagina.nextCursor === null ||
      pagina.nextCursor === "" ||
      usados.includes(pagina.nextCursor));

  const actualizado: EstadoDeEstrato = {
    estrato: previo.estrato,
    // Sin progreso, el cursor no avanza: el recorrido se detiene aquí.
    cursorDeEntrada:
      pagina.hasMore && !sinProgreso ? pagina.nextCursor : previo.cursorDeEntrada,
    agotado: !pagina.hasMore,
    paginas: previo.paginas + 1,
    cursoresUsados: usados,
  };
  const siguiente: EstadoDeRondas = {
    ...estado,
    estratos: estado.estratos.map((x) =>
      x.estrato === previo.estrato ? actualizado : x,
    ),
    pendientesDeLaRonda: pendientes,
    pedidasEnLaRonda: estado.pedidasEnLaRonda + 1,
  };

  if (sinProgreso) {
    return {
      tipo: "cursor_sin_progreso",
      estado: siguiente,
      estrato: previo.estrato,
      cursorDeEntrada: previo.cursorDeEntrada,
      nextCursor: pagina.nextCursor,
    };
  }
  return { tipo: "ok", estado: siguiente };
}

export type DecisionDeRonda =
  | { readonly tipo: "parar"; readonly motivo: MotivoDeParada; readonly ronda: number }
  | { readonly tipo: "seguir"; readonly estado: EstadoDeRondas };

/**
 * **El criterio de parada**, al cerrar la ronda en curso. Solo se puede llamar
 * con la ronda completa: evaluarlo a mitad es justo lo que la regla prohíbe.
 */
export function cerrarRonda(
  estado: EstadoDeRondas,
  unicosElegibles: number,
  objetivo: number,
): DecisionDeRonda {
  if (estado.pendientesDeLaRonda.length > 0) {
    throw new Error(
      `La ronda ${String(estado.ronda)} no está completa: faltan ` +
        `${estado.pendientesDeLaRonda.join(", ")}. El objetivo solo se evalúa al cerrarla.`,
    );
  }
  if (unicosElegibles >= objetivo) {
    return { tipo: "parar", motivo: "objetivo_alcanzado", ronda: estado.ronda };
  }
  const vivos = estado.estratos.filter((e) => !e.agotado).map((e) => e.estrato);
  if (vivos.length === 0) {
    return { tipo: "parar", motivo: "catalogo_agotado", ronda: estado.ronda };
  }
  return {
    tipo: "seguir",
    estado: {
      ...estado,
      ronda: estado.ronda + 1,
      pendientesDeLaRonda: vivos,
      pedidasEnLaRonda: 0,
    },
  };
}

/**
 * **Rondas completas**: las que tienen todas sus páginas. La ronda en curso
 * solo cuenta si ya no le falta ninguna.
 */
export function rondasCompletas(estado: EstadoDeRondas): number {
  return estado.pendientesDeLaRonda.length === 0 ? estado.ronda : estado.ronda - 1;
}

/**
 * **¿Se detuvo en una frontera de ronda?** Sí si la ronda en curso está
 * completa o todavía no se ha pedido ninguna de sus páginas. Un corte a mitad
 * de ronda deja estratos con más profundidad que otros: ese crudo es íntegro y
 * reanudable, pero **no se carga** (ADR 0009 §1, enmienda del 2026-09-27).
 */
export function enFronteraDeRonda(estado: EstadoDeRondas): boolean {
  return estado.pendientesDeLaRonda.length === 0 || estado.pedidasEnLaRonda === 0;
}
