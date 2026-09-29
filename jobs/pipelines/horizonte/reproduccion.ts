/**
 * **Reproducir un recorrido del horizonte** (`expiring`, `upcoming`): desde
 * qué estado, y qué tiene que coincidir con el original. Funciones puras: los
 * scripts (`scripts/horizonte-manual.ts`) leen los ficheros y hablan con Neon.
 *
 * ── El defecto que esto corrige (2026-09-24) ─────────────────────────────────
 *
 * 📏 La primera reproducción del ensayo de `expiring` dio 7/7 y aun así **no
 * repetía** la ejecución: 4 desaparecidas y 0 ofertas de línea base en el
 * ensayo; 2 y 309 en la reproducción, con las mismas páginas y los mismos
 * avisos. El ensayo partió del catálogo del Spike 1 sembrado dentro de su
 * transacción; la reproducción, de lo que había en la rama —el catálogo que
 * ha ido construyendo `deltas`—. Mismo crudo, otra base, otra medición. Y las
 * 7 comprobaciones solo miraban páginas, avisos y estado, que salen del crudo
 * y no pueden fallar por eso.
 *
 * ── Dos clases de reproducción, y por qué ninguna miente ─────────────────────
 *
 *   · **Exacta** — `estadoInicial: corpus_spike1`. El estado de partida se
 *     reconstruye entero (corpus + ejecuciones previas), así que **todo** tiene
 *     que coincidir: páginas con sus eventos, resumen del informe y medición
 *     del horizonte, muestra incluida. El corpus se siembra encima de la
 *     rama, así que antes se exige que la rama siga igual (`cambiosEnLaRama`):
 *     si `deltas` la ha movido, la reconstrucción ya no es exacta y se dice.
 *   · **De idempotencia** — `estadoInicial: rama`. Una ejecución real confirma
 *     su trabajo: el estado del que partió ya no existe, y la rama sigue
 *     cambiando con cada `deltas`. ⚖️ Diferencia **deliberada**: solo se exige
 *     lo que sale del crudo (páginas, avisos, cursores, estado); el resumen y
 *     el horizonte se enseñan como información, con la razón. Sigue siendo
 *     válida para lo que promete: que reprocesar lo pagado no escribe nada que
 *     no estuviera ya.
 *
 * ── Comparación por valor, no por texto ──────────────────────────────────────
 *
 * 📏 `JSON.stringify` depende del orden de las claves, y `jsonb` lo cambia
 * (fila 44): mismo valor, otro texto, falso negativo. Todo se compara con
 * `mismoValorJson`.
 */
import { isDeepStrictEqual } from "node:util";

import type { NombreDePipeline } from "../../ops/contratos.ts";
import type {
  EstadoInicial,
  HuellaDeLaRama,
  Manifiesto,
  PaginaDelManifiesto,
} from "../deltas/manifiesto.ts";

export type LectorDeManifiestos = (directorio: string) => Manifiesto;
export type ResolverRuta = (base: string, relativa: string) => string;

/**
 * **¿Mismo valor JSON?** Sin depender del orden de las claves.
 *
 * 📏 `jsonb` no conserva el orden de inserción: guarda las claves ordenadas
 * por longitud y, a igual longitud, por bytes. La fila 44 devolvió su
 * checkpoint como `v, tipos, ventana, pendiente, reanudaDe, …` mientras el
 * job lo tenía como `v, estrategia, horizonteDias, ventana, …`: mismo valor,
 * otro texto. Comparar con `JSON.stringify` dio un falso negativo. El viaje
 * de ida y vuelta por JSON normaliza lo que sí cuenta (`Date` → ISO,
 * `undefined` fuera) antes de comparar por valor.
 */
export function mismoValorJson(a: unknown, b: unknown): boolean {
  const normalizar = (x: unknown): unknown =>
    x === undefined ? undefined : (JSON.parse(JSON.stringify(x)) as unknown);
  return isDeepStrictEqual(normalizar(a), normalizar(b));
}

export type PlanDeReconstruccion =
  | { readonly tipo: "rama"; readonly motivo: string }
  | {
      readonly tipo: "corpus_spike1";
      readonly excluir: RegExp;
      /** Directorios absolutos que se reproducen ANTES, en este orden. */
      readonly previas: readonly string[];
      /** Cómo estaba la rama bajo el corpus. Tiene que seguir igual. */
      readonly rama: HuellaDeLaRama;
    };

/**
 * Desde qué estado se reproduce el manifiesto de `directorio`.
 *
 * Lanza si no hay forma honesta de hacerlo: un ensayo sin `estadoInicial`
 * (anterior a que el manifiesto lo registrara) partió de un corpus que ya no
 * se puede adivinar, y reproducirlo sobre la rama volvería a dar una medición
 * distinta sin avisar.
 */
export function planDeReconstruccion(
  pipeline: NombreDePipeline,
  directorio: string,
  leer: LectorDeManifiestos,
  resolver: ResolverRuta,
): PlanDeReconstruccion {
  const manifiesto = leer(directorio);
  const estado = manifiesto.estadoInicial;

  if (estado === undefined) {
    if (manifiesto.modo === "ensayo") {
      throw new Error(
        "Este manifiesto de ensayo no dice de qué estado partió (es anterior a que " +
          "el manifiesto lo registrara), así que no se puede reconstruir. Vuelve a " +
          `ejecutar \`pnpm api:run:${pipeline} --ensayo\` —cero API— y reproduce el nuevo.`,
      );
    }
    return {
      tipo: "rama",
      motivo:
        "el manifiesto no declara estado inicial: se trata como una ejecución real",
    };
  }
  if (estado.tipo === "rama") {
    return {
      tipo: "rama",
      motivo:
        "una ejecución real ya confirmó su trabajo: el estado del que partió no existe " +
        "y la rama sigue cambiando con cada deltas",
    };
  }

  const previas: string[] = [];
  const visitadas = new Set<string>([directorio]);
  const expandir = (
    desde: string,
    e: Extract<EstadoInicial, { tipo: "corpus_spike1" }>,
  ) => {
    for (const relativa of e.previas) {
      const dir = resolver(desde, relativa);
      if (visitadas.has(dir)) {
        throw new Error(`Las ejecuciones previas forman un ciclo en ${dir}.`);
      }
      visitadas.add(dir);
      const previa = leer(dir).estadoInicial;
      if (previa?.tipo !== "corpus_spike1" || previa.excluir !== estado.excluir) {
        throw new Error(
          `La ejecución previa ${dir} no parte del mismo corpus: no se puede encadenar.`,
        );
      }
      expandir(dir, previa);
      previas.push(dir);
    }
  };
  expandir(directorio, estado);

  return {
    tipo: "corpus_spike1",
    excluir: new RegExp(estado.excluir),
    previas,
    rama: estado.rama,
  };
}

/**
 * La rama bajo el corpus, entonces y ahora. `null` si coincide; si no, qué
 * cambió. Si cambió, la reconstrucción ya no es exacta: no se compara nada
 * más como si lo fuera.
 */
export function cambiosEnLaRama(
  entonces: HuellaDeLaRama,
  ahora: HuellaDeLaRama,
): string | null {
  const cambios: string[] = [];
  const tablas = new Set([
    ...Object.keys(entonces.recuentos),
    ...Object.keys(ahora.recuentos),
  ]);
  for (const t of [...tablas].sort()) {
    const a = entonces.recuentos[t];
    const b = ahora.recuentos[t];
    if (a !== b) cambios.push(`${t} ${String(a ?? "∅")}→${String(b ?? "∅")}`);
  }
  if (entonces.ultimoEvento !== ahora.ultimoEvento) {
    cambios.push(
      `último evento ${String(entonces.ultimoEvento)}→${String(ahora.ultimoEvento)}`,
    );
  }
  if (entonces.ultimaComprobacion !== ahora.ultimaComprobacion) {
    cambios.push(
      `última comprobación ${entonces.ultimaComprobacion ?? "∅"}→${ahora.ultimaComprobacion ?? "∅"}`,
    );
  }
  return cambios.length === 0 ? null : cambios.join(" · ");
}

// ── Qué tiene que coincidir ──────────────────────────────────────────────────

export interface Diferencia {
  readonly campo: string;
  /** `true` si su diferencia invalida la reproducción. */
  readonly exigible: boolean;
  readonly igual: boolean;
  readonly original: unknown;
  readonly reproducido: unknown;
}

/**
 * Un campo propio de un pipeline que también se compara. `delCrudo`: sale
 * del crudo y no depende del estado de la base, así que se exige **siempre**;
 * si no, solo en una reproducción exacta.
 */
export interface CampoComparable {
  readonly campo: string;
  readonly delCrudo: boolean;
  leer(manifiesto: Manifiesto): unknown;
}

/** Lo que de una página sale del crudo: no depende del estado de la base. */
function paginaDelCrudo(p: PaginaDelManifiesto) {
  return {
    changeType: p.changeType,
    pagina: p.pagina,
    cursorDeEntrada: p.cursorDeEntrada,
    nextCursor: p.nextCursor,
    hasMore: p.hasMore,
    avisos: p.avisos,
    ultimoTimestamp: p.ultimoTimestamp,
  };
}

/** Lo que de una página depende del estado del que partió. */
function paginaDelEstado(p: PaginaDelManifiesto) {
  return { pagina: p.pagina, eventos: p.eventos, eventosEscritos: p.eventosEscritos };
}

/**
 * Compara la reproducción con la original. Con `exacta`, **todo** es
 * exigible; sin ella, solo lo que sale del crudo.
 */
export function compararConOriginal(
  original: Manifiesto,
  reproducido: Manifiesto,
  exacta: boolean,
  propios: readonly CampoComparable[] = [],
): readonly Diferencia[] {
  const campo = (
    nombre: string,
    exigible: boolean,
    a: unknown,
    b: unknown,
  ): Diferencia => ({
    campo: nombre,
    exigible,
    igual: mismoValorJson(a, b),
    original: a,
    reproducido: b,
  });

  return [
    campo("estado", true, original.estado, reproducido.estado),
    campo("ventana", true, original.ventana, reproducido.ventana),
    campo("ahora", true, original.ahora, reproducido.ahora),
    campo(
      "páginas (crudo: cursores, hasMore, avisos, fechas)",
      true,
      original.paginas.map(paginaDelCrudo),
      reproducido.paginas.map(paginaDelCrudo),
    ),
    campo(
      "páginas (estado: eventos por página)",
      exacta,
      original.paginas.map(paginaDelEstado),
      reproducido.paginas.map(paginaDelEstado),
    ),
    campo(
      "resumen del informe",
      exacta,
      original.resumen ?? null,
      reproducido.resumen ?? null,
    ),
    campo(
      "horizonte (completo, desaparecidas, muestra)",
      exacta,
      original.horizonte ?? null,
      reproducido.horizonte ?? null,
    ),
    ...propios.map((p) =>
      campo(
        p.campo,
        p.delCrudo || exacta,
        p.leer(original) ?? null,
        p.leer(reproducido) ?? null,
      ),
    ),
  ];
}
