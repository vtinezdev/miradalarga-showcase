/**
 * **Formato v1 del crudo del seed** (ADR 0009 §4): el contrato de lo que la
 * captura deja en disco y de lo que la verificación y la carga leen.
 *
 * ```
 * .seed-runs/<capturaId>/
 *   plan.json                            se escribe ANTES de la primera request
 *   paginas/0001-netflix-movie-r01.json  cuerpo exacto de cada respuesta
 *   …
 *   manifiesto.json                      índice página a página; se cierra al terminar
 *   SHA256SUMS                           sha256 de plan, páginas y manifiesto
 * ```
 *
 * ⚖️ **Cada fichero nuestro lleva `formato` y `v`.** Un lector que no reconoce
 * la versión **se niega**: no interpreta «lo mejor posible». Evolucionar el
 * formato es añadir un `v: 2` con su propio schema, nunca aflojar el v1.
 *
 * ⚖️ **Las páginas son el cuerpo exacto del proveedor, sin envoltorio.** El
 * `{meta, body}` del Spike ya costó una request y un `ZodError`
 * (`docs/DATA-SOURCES.md` §1.9 bis). Los metadatos viven en el manifiesto.
 *
 * Este fichero no lee ni escribe nada: solo define formas. No importa ningún
 * módulo capaz de llamar a la API ni a una base de datos.
 */
import { z } from "zod";

import { PLATAFORMAS_MVP } from "../plataformas.ts";

export const VERSION_DEL_CRUDO = 1;

export const FORMATO_DEL_PLAN = "mirada-larga.seed.plan";
export const FORMATO_DEL_MANIFIESTO = "mirada-larga.seed.manifiesto";

export const FICHERO_DEL_PLAN = "plan.json";
export const FICHERO_DEL_MANIFIESTO = "manifiesto.json";
export const FICHERO_DE_SUMAS = "SHA256SUMS";
export const DIRECTORIO_DE_PAGINAS = "paginas";

/** ⚖️ Objetivo provisional de D2 (ADR 0009 §1). No es un suelo contractual. */
export const OBJETIVO_DE_UNICOS = 5000;

/** ⚖️ `S = T0 truncado al segundo − 1 h` (ADR 0009 §7). */
export const MARGEN_DEL_ANCLA_SEGUNDOS = 3600;

/**
 * ⚖️ **72 h desde `S`** para cargar y ejecutar el primer `deltas` (ADR 0009
 * §7). Es el mismo umbral que `UMBRAL_DE_RETRASO_MS` de `deltas/programado.ts`;
 * un test exige que coincidan. No se importa de allí porque ese módulo arrastra
 * el transporte, y la verificación no puede depender de nada que llame a la API.
 */
export const PLAZO_DEL_ANCLA_SEGUNDOS = 72 * 3600;

/** Parámetros de `search/filters` comunes a los 12 estratos (📏 Spike 1, bloque B). */
export const PARAMETROS_COMUNES = {
  country: "es",
  series_granularity: "show",
  output_language: "es",
} as const;

/** Las claves que una query guardada puede llevar. Ninguna otra: ni la credencial. */
export const CLAVES_DE_QUERY = [
  "country",
  "catalogs",
  "show_type",
  "series_granularity",
  "output_language",
  "order_by",
  "order_direction",
  "cursor",
] as const;

export const TIPOS_DE_SHOW = ["movie", "series"] as const;
export type TipoDeShow = (typeof TIPOS_DE_SHOW)[number];

/**
 * ⚖️ Órdenes admitidos por estrato: `popularity_alltime` y, **solo** donde M1
 * falle, `rating` como respaldo (ADR 0009 §1). Qué usó cada estrato queda en
 * el plan.
 */
export const ORDENES_ADMITIDOS = ["popularity_alltime", "rating"] as const;
export type OrdenDeEstrato = (typeof ORDENES_ADMITIDOS)[number];

/** Un estrato: una plataforma del MVP y un tipo de show. */
export interface EstratoDelMvp {
  /** `<nuestro id>-<tipo>`: `max-movie`, no `hbo-movie`. */
  readonly estrato: string;
  /** Nuestro `id` de plataforma. */
  readonly plataforma: string;
  /** El `source_id` del proveedor: el valor de `catalogs`. */
  readonly catalogo: string;
  readonly showType: TipoDeShow;
}

/**
 * **Los 12 estratos, en su orden fijo** (ADR 0009 §1): las seis plataformas en
 * el orden de `PLATAFORMAS_MVP` —netflix, prime, disney, max, apple,
 * skyshowtime— y dentro de cada una `movie` antes que `series`.
 */
export const ESTRATOS_DEL_MVP: readonly EstratoDelMvp[] = PLATAFORMAS_MVP.flatMap((p) =>
  TIPOS_DE_SHOW.map((showType) => ({
    estrato: `${p.id}-${showType}`,
    plataforma: p.id,
    catalogo: p.sourceId,
    showType,
  })),
);

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "sha256 en hexadecimal minúsculo");
const instante = z.iso.datetime({ offset: false });

/**
 * **El id de una fila de `ops_sync_runs`, como texto decimal.** Es `bigint` en la
 * base, y estos ficheros viajan entre bases: un `number` de JSON perdería
 * precisión por encima de `Number.MAX_SAFE_INTEGER` sin avisar. Sin ceros a la
 * izquierda, sin signo.
 */
export const idDeOps = z
  .string()
  .regex(/^[1-9][0-9]*$/, "id de ops_sync_runs en decimal");

/** Un id de fila, venga como venga del driver, en su forma de texto decimal. */
export function idDeOpsComoTexto(id: number | bigint | string): string {
  const texto = typeof id === "string" ? id : id.toString();
  return idDeOps.parse(texto);
}

/** `YYYYMM` de un ciclo de cuota: la misma clave que el lock B (`presupuesto.ts`). */
export const claveDeCiclo = z
  .number()
  .int()
  .refine((c) => c >= 200001 && c <= 999912 && c % 100 >= 1 && c % 100 <= 12, {
    message: "clave de ciclo YYYYMM inválida",
  });

/** El ciclo inmediatamente siguiente a `clave`. */
export function cicloSiguiente(clave: number): number {
  const anio = Math.floor(clave / 100);
  const mes = clave % 100;
  return mes === 12 ? (anio + 1) * 100 + 1 : anio * 100 + mes + 1;
}

// ── plan.json ────────────────────────────────────────────────────────────────

const estratoDelPlan = z.strictObject({
  estrato: z.string().min(1),
  plataforma: z.string().min(1),
  catalogo: z.string().min(1),
  showType: z.enum(TIPOS_DE_SHOW),
  orderBy: z.enum(ORDENES_ADMITIDOS),
  orderDirection: z.literal("desc"),
});

export type EstratoDelPlan = z.infer<typeof estratoDelPlan>;

/**
 * **`plan.json` v1.** Se escribe antes de la primera request; su sha256 es la
 * **huella del plan**, y una reanudación con otro plan no arranca.
 */
export const planV1 = z
  .strictObject({
    formato: z.literal(FORMATO_DEL_PLAN),
    v: z.literal(VERSION_DEL_CRUDO),
    capturaId: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,80}$/, "capturaId con caracteres seguros"),
    /** El commit que fijó el plan. `null` si no se conoce. */
    commit: z
      .string()
      .regex(/^[0-9a-f]{7,40}$/)
      .nullable(),
    pais: z.literal("es"),
    parametrosComunes: z.strictObject({
      country: z.literal(PARAMETROS_COMUNES.country),
      series_granularity: z.literal(PARAMETROS_COMUNES.series_granularity),
      output_language: z.literal(PARAMETROS_COMUNES.output_language),
    }),
    /** Los 12, en el orden de `ESTRATOS_DEL_MVP`. */
    estratos: z.array(estratoDelPlan).length(ESTRATOS_DEL_MVP.length),
    /** Títulos elegibles únicos. Se evalúa **al cerrar cada ronda**, nunca a mitad. */
    objetivoUnicos: z.number().int().positive(),
    /** Tope de requests autorizado para la captura. */
    tope: z.number().int().positive(),
    margenDelAnclaSegundos: z.literal(MARGEN_DEL_ANCLA_SEGUNDOS),
    plazoDelAnclaSegundos: z.literal(PLAZO_DEL_ANCLA_SEGUNDOS),
    /**
     * La M1 que respalda el plan: su fila y **el ciclo de cuota en que corrió**.
     * La captura solo es válida en el ciclo inmediatamente siguiente (§3).
     */
    m1: z.strictObject({
      runId: idDeOps,
      cicloClave: claveDeCiclo,
      /** El día de corte con el que se calcula el ciclo de `T0`, en UTC. */
      diaDeCiclo: z.number().int().min(1).max(28),
      /**
       * sha256 de `m1.json`, el resultado verificado de la sonda (`m1.ts`). Ata
       * el plan a la medición concreta. Ausente solo en planes de ensayo.
       */
      huellaDelResultado: sha256Hex.optional(),
      /**
       * **El resultado de M1, persistido en el plan**: el orden de cada
       * plataforma, de dónde sale y por qué. `popularity_alltime` solo si sus
       * dos estratos pasaron M1; si no, `rating` (respaldo por plataforma).
       */
      decisiones: z
        .array(
          z.strictObject({
            plataforma: z.string().min(1),
            orderBy: z.enum(ORDENES_ADMITIDOS),
            fuente: z.enum(["medido", "evidencia_historica"]),
            motivo: z.string().min(1),
          }),
        )
        .optional(),
    }),
  })
  .superRefine((plan, ctx) => {
    const decisiones = plan.m1.decisiones;
    if (decisiones !== undefined) {
      const plataformas = PLATAFORMAS_MVP.map((p) => p.id);
      if (
        decisiones.length !== plataformas.length ||
        decisiones.some((d, i) => d.plataforma !== plataformas[i])
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["m1", "decisiones"],
          message: `una decisión por plataforma, en el orden ${plataformas.join(", ")}`,
        });
      }
      plan.estratos.forEach((e, i) => {
        const d = decisiones.find((x) => x.plataforma === e.plataforma);
        if (d !== undefined && d.orderBy !== e.orderBy) {
          ctx.addIssue({
            code: "custom",
            path: ["estratos", i, "orderBy"],
            message: `M1 decidió ${d.orderBy} para ${e.plataforma}`,
          });
        }
      });
    }
    plan.estratos.forEach((e, i) => {
      const esperado = ESTRATOS_DEL_MVP[i];
      if (
        e.estrato !== esperado?.estrato ||
        e.plataforma !== esperado.plataforma ||
        e.catalogo !== esperado.catalogo ||
        e.showType !== esperado.showType
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["estratos", i],
          message: `el estrato ${String(i + 1)} tiene que ser ${esperado?.estrato ?? "?"}, en el orden fijo`,
        });
      }
    });
  });

export type PlanDelSeed = z.infer<typeof planV1>;

// ── manifiesto.json ──────────────────────────────────────────────────────────

export const ESTADOS_DE_PAGINA = ["confirmada", "invalida", "adoptada"] as const;
export type EstadoDePagina = (typeof ESTADOS_DE_PAGINA)[number];

/**
 * **Una entrada del manifiesto por página** (el «manifiesto por página»).
 * `hasMore`, `nextCursor` y `shows` son lo que dice el cuerpo; la verificación
 * lo contrasta con él.
 */
export const entradaDePaginaV1 = z.strictObject({
  /** 1, 2, 3… en el orden en que se pidieron. */
  n: z.number().int().positive(),
  estrato: z.string().min(1),
  ronda: z.number().int().positive(),
  /** `paginas/<nnnn>-<estrato>-r<rr>.json`. */
  fichero: z.string().min(1),
  /** `null` en la primera página de un estrato. */
  cursorDeEntrada: z.string().min(1).nullable(),
  /** La query tal y como viajó, **sin credencial**: la clave va en `X-API-Key`. */
  query: z.record(z.string(), z.string()),
  reservadaEn: instante,
  respondidaEn: instante,
  http: z.number().int().min(100).max(599),
  bytes: z.number().int().nonnegative(),
  sha256: sha256Hex,
  /** Shows en el cuerpo. `null` si el cuerpo no se pudo leer. */
  shows: z.number().int().nonnegative().nullable(),
  hasMore: z.boolean().nullable(),
  nextCursor: z.string().nullable(),
  cuota: z
    .strictObject({
      usada: z.number().int().nonnegative(),
      concedida: z.number().int().nonnegative(),
      reinicio: z.string().min(1),
    })
    .nullable(),
  /** La fila de `ops_sync_runs` que la pagó. `null` si no hubo fila. */
  runId: idDeOps.nullable(),
  estado: z.enum(ESTADOS_DE_PAGINA),
});

export type EntradaDePagina = z.infer<typeof entradaDePaginaV1>;

export const ESTADOS_DE_CAPTURA = ["succeeded", "budget_stopped", "failed"] as const;
export type EstadoDeCaptura = (typeof ESTADOS_DE_CAPTURA)[number];

/** Motivos con los que una captura termina bien (ADR 0009 §1, criterio de parada). */
export const MOTIVOS_DE_EXITO = ["objetivo_alcanzado", "catalogo_agotado"] as const;

/** Lo que el manifiesto añade al cerrarse. */
export const cierreV1 = z.strictObject({
  /** Inmediatamente antes de reservar la primera request. */
  T0: instante,
  /** **El ancla**: `T0` truncado al segundo − margen. */
  ancla: instante,
  /** La última respuesta. */
  T1: instante,
  estado: z.enum(ESTADOS_DE_CAPTURA),
  motivo: z.string().min(1),
  /** El crudo es válido y cargable, pero corto (ADR 0009 §1). */
  cortadoPorTope: z.boolean(),
  /**
   * Rondas con todas sus páginas. Se reproduce desde las páginas.
   */
  rondasCompletas: z.number().int().nonnegative(),
  /**
   * **Se detuvo en una frontera de ronda** —ninguna ronda a medias— con al
   * menos una completa. Condición para cargar un `budget_stopped`: un corte a
   * mitad de ronda es íntegro y reanudable, **nunca cargable**.
   */
  rondaCompleta: z.boolean(),
  requestsReservadas: z.number().int().nonnegative(),
  respuestas: z.number().int().nonnegative(),
  /** Filas de `ops_sync_runs` que la produjeron. */
  filasDeOps: z.array(idDeOps),
  /** En qué base viven esas filas. */
  destino: z.string().min(1),
});

export type CierreDeCaptura = z.infer<typeof cierreV1>;

export type MotivoNoCargable = "captura_fallida" | "ronda_incompleta";

/**
 * **Qué captura puede pasar al loader** (ADR 0009 §1, enmienda del
 * 2026-09-27). Una sola regla, la misma en la verificación y en la carga:
 *
 *   · `succeeded` → cargable.
 *   · `budget_stopped` en una frontera de ronda (`rondaCompleta`) → cargable,
 *     aunque tenga menos de 5.000 únicos.
 *   · `budget_stopped` a mitad de ronda → `ronda_incompleta`: íntegro y
 *     reanudable, **nunca** cargable.
 *   · `failed` → `captura_fallida`.
 */
export function motivoNoCargable(cierre: CierreDeCaptura): MotivoNoCargable | null {
  if (cierre.estado === "failed") return "captura_fallida";
  if (!cierre.rondaCompleta) return "ronda_incompleta";
  return null;
}

/** **`manifiesto.json` v1** (el «manifiesto global»). */
export const manifiestoV1 = z.strictObject({
  formato: z.literal(FORMATO_DEL_MANIFIESTO),
  v: z.literal(VERSION_DEL_CRUDO),
  capturaId: z.string().min(1),
  /** sha256 de los bytes de `plan.json`. */
  huellaDelPlan: sha256Hex,
  paginas: z.array(entradaDePaginaV1),
  /** `null` mientras la captura sigue abierta: un crudo abierto no se verifica. */
  cierre: cierreV1.nullable(),
});

export type ManifiestoDelSeed = z.infer<typeof manifiestoV1>;

// ── Páginas ─────────────────────────────────────────────────────────────────

/**
 * **El envoltorio de una página de `search/filters`**, con los shows sin
 * validar.
 *
 * ⚖️ Un show inválido **dentro de una página válida** se rechaza y se cuenta
 * (ADR 0009 §10); por eso aquí no se usa `respuestaBusquedaProveedor`, que
 * tumbaría la página entera por un show. Cada show pasa `showProveedor` por
 * separado en la selección.
 */
export const paginaCrudaV1 = z.looseObject({
  shows: z.array(z.unknown()),
  hasMore: z.boolean().optional(),
  nextCursor: z.string().optional(),
});

/** El nombre del fichero de una página: `paginas/0001-netflix-movie-r01.json`. */
export function ficheroDePagina(n: number, estrato: string, ronda: number): string {
  return `${DIRECTORIO_DE_PAGINAS}/${String(n).padStart(4, "0")}-${estrato}-r${String(ronda).padStart(2, "0")}.json`;
}

/** La query exacta de una página del estrato, sin credencial. */
export function queryDePagina(
  estrato: EstratoDelPlan,
  cursor: string | null,
): Readonly<Record<string, string>> {
  return {
    ...PARAMETROS_COMUNES,
    catalogs: estrato.catalogo,
    show_type: estrato.showType,
    order_by: estrato.orderBy,
    order_direction: estrato.orderDirection,
    ...(cursor === null ? {} : { cursor }),
  };
}

/** `S` a partir de `T0`: truncado al segundo, menos el margen. */
export function anclaDesdeT0(t0: Date): Date {
  return new Date(
    Math.floor(t0.getTime() / 1000) * 1000 - MARGEN_DEL_ANCLA_SEGUNDOS * 1000,
  );
}
