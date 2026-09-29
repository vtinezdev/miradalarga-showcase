/**
 * `missing_streak`: **una ausencia lógica cuenta una sola vez.**
 *
 *   primera observación real de la ausencia   → 0 → 1
 *   reprocesos de ESA observación             → sigue en 1
 *   siguiente observación independiente       → 1 → 2
 *
 * Una observación se identifica por su instante —el `ahora` de la ejecución
 * que pidió el snapshot—, persistido en `external_availability.last_checked_at`,
 * que solo avanza. Aquí se ejecuta el pipeline real, página a página, contra
 * una base en memoria con estado y transacciones.
 */
import { describe, expect, it } from "vitest";

import { ejecutarDeltas } from "../../jobs/pipelines/deltas/index.ts";
import { transaccionPorPagina } from "../../jobs/pipelines/deltas/job.ts";
import { esObservacionNueva } from "../../jobs/pipelines/deltas/opciones.ts";
import type { TipoDeCambio } from "../../jobs/adapters/contracts.ts";
import { crearBaseEnMemoria } from "./base-en-memoria.ts";
import type { BaseEnMemoria } from "./base-en-memoria.ts";
import type { OpcionCruda } from "./ayudas-deltas.ts";
import { crearTransporteFalso, respuestaCruda, showCrudo } from "./ayudas-deltas.ts";

const T0 = new Date("2026-09-23T06:00:00.000Z");
const T1 = new Date("2026-09-24T06:00:00.000Z");
const T2 = new Date("2026-09-25T06:00:00.000Z");

const A = "https://netflix.test/9-a";
const B = "https://netflix.test/9-b";
const OPCION_A: OpcionCruda = {
  service: "netflix",
  type: "subscription",
  link: A,
  quality: "hd",
};
const OPCION_B: OpcionCruda = {
  service: "netflix",
  type: "subscription",
  link: B,
  quality: "hd",
};

/** Una página con UN aviso sobre la oferta de Netflix del título 9. */
function pagina(
  opciones: readonly OpcionCruda[],
  tipo: TipoDeCambio,
  extra: {
    id?: string;
    hasMore?: boolean;
    nextCursor?: string;
    link?: string;
    timestamp?: number;
  } = {},
) {
  const id = extra.id ?? "9";
  return respuestaCruda({
    cambios: [
      {
        changeType: tipo,
        showId: id,
        service: "netflix",
        type: "subscription",
        link: extra.link ?? A,
        timestamp: extra.timestamp ?? Math.floor(T0.getTime() / 1000),
      },
    ],
    shows: [showCrudo({ id, imdbId: `tt${id.padStart(7, "0")}`, opciones })],
    ...(extra.hasMore === undefined ? {} : { hasMore: extra.hasMore }),
    ...(extra.nextCursor === undefined ? {} : { nextCursor: extra.nextCursor }),
  });
}

/** Una observación: una ejecución de `deltas` en el instante `ahora`. */
async function observar(
  base: BaseEnMemoria,
  ahora: Date,
  paginas: readonly Record<string, unknown>[],
  tipo: TipoDeCambio = "updated",
) {
  const red = crearTransporteFalso(paginas);
  return ejecutarDeltas({
    ejecutor: base.ejecutor,
    peticion: { transporte: red.transporte, apiKey: "k" },
    tipos: [tipo],
    ventana: null,
    ahora,
    maximoDePaginas: 10,
    transaccion: transaccionPorPagina(base.ejecutor),
  });
}

const racha = (base: BaseEnMemoria, link: string) => base.opcion(link)?.missingStreak;

/** Estado de partida: A y B presentes, observadas en T0. */
async function conAyB(): Promise<BaseEnMemoria> {
  const base = crearBaseEnMemoria();
  await observar(base, T0, [pagina([OPCION_A, OPCION_B], "new")], "new");
  expect(racha(base, A)).toBe(0);
  expect(racha(base, B)).toBe(0);
  return base;
}

describe("la identidad de una observación", () => {
  it("nueva si su instante es posterior a la última aplicada; si no, ya aplicada", () => {
    expect(esObservacionNueva(null, T1)).toBe(true);
    expect(esObservacionNueva(T0, T1)).toBe(true);
    expect(esObservacionNueva(T1, T1)).toBe(false);
    expect(esObservacionNueva(T2, T1)).toBe(false);
  });

  it("last_checked_at se escribe con GREATEST: una observación antigua no lo hace retroceder", async () => {
    const base = await conAyB();
    await observar(base, T2, [pagina([OPCION_A, OPCION_B], "updated")]);
    await observar(base, T1, [pagina([OPCION_A, OPCION_B], "updated")]);
    expect(base.ultimaComprobacion("netflix")?.toISOString()).toBe(T2.toISOString());
    expect(
      base.sentencias.some((s) =>
        s.includes(
          'GREATEST(external_availability."last_checked_at", EXCLUDED."last_checked_at")',
        ),
      ),
    ).toBe(true);
  });
});

describe("missing_streak: una ausencia lógica cuenta una vez", () => {
  it("1 · presente → ausente: 0 → 1", async () => {
    const base = await conAyB();
    await observar(base, T1, [pagina([OPCION_A], "updated")]);
    expect(racha(base, B)).toBe(1);
    expect(racha(base, A)).toBe(0);
  });

  it("2 · reproceso exacto de la misma página y ventana: sigue en 1", async () => {
    const base = await conAyB();
    await observar(base, T1, [pagina([OPCION_A], "updated")]);
    const replay = await observar(base, T1, [pagina([OPCION_A], "updated")]);
    expect(racha(base, B)).toBe(1);
    expect(replay.observacionesYaAplicadas).toBe(1);
    // Nada que contar: el reproceso no produce eventos.
    expect(replay.eventos).toEqual({});
    // Y ni siquiera emite la escritura de la racha.
    const tras = base.sentencias.slice(base.sentencias.lastIndexOf("BEGIN"));
    expect(tras.some((s) => s.includes("SET missing_streak"))).toBe(false);
  });

  it("3 · segunda observación independiente de la ausencia: 1 → 2, y la opción se retira", async () => {
    const base = await conAyB();
    await observar(base, T1, [pagina([OPCION_A], "updated")]);
    const segunda = await observar(base, T2, [pagina([OPCION_A], "updated")]);
    expect(racha(base, B)).toBe(2);
    expect(segunda.eventos).toEqual({ changed: 1 });
  });

  it("4 · reaparición: vuelve a 0", async () => {
    const base = await conAyB();
    await observar(base, T1, [pagina([OPCION_A], "updated")]);
    expect(racha(base, B)).toBe(1);
    await observar(base, T2, [pagina([OPCION_A, OPCION_B], "updated")]);
    expect(racha(base, B)).toBe(0);
  });

  it("5 · reproceso tras un fallo parcial no acelera la desaparición", async () => {
    const base = await conAyB();
    // Ejecución en T1 con dos páginas: la 1 observa la ausencia de B; la 2
    // (otro título) falla después de escribir su estado.
    const paginas = [
      pagina([OPCION_A], "updated", { hasMore: true, nextCursor: "c1" }),
      pagina([{ ...OPCION_A, link: "https://netflix.test/10" }], "updated", {
        id: "10",
        link: "https://netflix.test/10",
      }),
    ];
    // Falla la escritura de opciones de la página 2: sus títulos y ofertas ya
    // se habían escrito dentro de la transacción.
    let upsertsDeOpciones = 0;
    base.fallarUnaVezEn(
      (t) =>
        t.startsWith("INSERT INTO external_availability_options") &&
        ++upsertsDeOpciones === 2,
    );
    await expect(observar(base, T1, paginas)).rejects.toThrow("fallo inyectado");
    expect(racha(base, B)).toBe(1);
    // La página 2 se revirtió entera: su título no existe.
    expect(base.opcion("https://netflix.test/10")).toBeUndefined();

    // Reproceso de TODA la ejecución, con el mismo instante (el del manifiesto).
    await observar(base, T1, paginas);
    expect(racha(base, B)).toBe(1);
    expect(base.opcion("https://netflix.test/10")).toBeDefined();

    // Y otro reproceso más, por si acaso: sigue en 1. Hace falta T2.
    await observar(base, T1, paginas);
    expect(racha(base, B)).toBe(1);
    await observar(base, T2, [pagina([OPCION_A], "updated")]);
    expect(racha(base, B)).toBe(2);
  });

  it("5 bis · la misma oferta en dos páginas de UNA ejecución es una sola observación", async () => {
    const base = await conAyB();
    await observar(base, T1, [
      pagina([OPCION_A], "updated", { hasMore: true, nextCursor: "c1" }),
      pagina([OPCION_A], "updated"),
    ]);
    expect(racha(base, B)).toBe(1);
  });

  it("6 · una opción futura cuya available_since no ha llegado no acumula ausencia", async () => {
    const base = crearBaseEnMemoria();
    const F = "https://netflix.test/9-estreno";
    const estreno = Math.floor(T2.getTime() / 1000) + 30 * 86_400;
    // T0: el catálogo lista F con fecha de alta futura. (Ya no la sintetiza un
    // `upcoming`: desde el ADR 0007 un anuncio vive en su propia tabla. La
    // regla sigue valiendo para una opción futura OBSERVADA en el catálogo.)
    await observar(
      base,
      T0,
      [
        pagina(
          [
            {
              service: "netflix",
              type: "subscription",
              link: F,
              availableSince: estreno,
            },
          ],
          "new",
          { link: F },
        ),
      ],
      "new",
    );
    expect(racha(base, F)).toBe(0);
    // T1 y T2: el catálogo ya lista A, pero no F. F no puede morir antes de
    // estrenarse.
    await observar(base, T1, [pagina([OPCION_A], "updated")]);
    await observar(base, T2, [pagina([OPCION_A], "updated")]);
    expect(racha(base, F)).toBe(0);
  });

  it("una observación ANTERIOR reprocesada no deshace una posterior", async () => {
    const base = await conAyB();
    await observar(base, T1, [pagina([OPCION_A], "updated")]); // B ausente → 1
    await observar(base, T2, [pagina([OPCION_A], "updated")]); // B ausente → 2
    // Reprocesar la de T0, donde B estaba presente, no la resucita.
    await observar(base, T0, [pagina([OPCION_A, OPCION_B], "updated")]);
    expect(racha(base, B)).toBe(2);
  });

  it("un `removed` reprocesado tras una reaparición no vuelve a matar la oferta", async () => {
    const base = await conAyB();
    const retirada = pagina([], "removed", { link: A });
    await observar(base, T1, [retirada], "removed"); // retirada: A y B a 2
    expect(racha(base, A)).toBe(2);
    await observar(base, T2, [pagina([OPCION_A, OPCION_B], "updated")]); // vuelven
    expect(racha(base, A)).toBe(0);
    await observar(base, T1, [retirada], "removed"); // reproceso de la retirada
    expect(racha(base, A)).toBe(0);
    expect(racha(base, B)).toBe(0);
  });
});
