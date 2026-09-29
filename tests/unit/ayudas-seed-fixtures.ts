/**
 * El fixture base del seed: pequeño, pero con todo lo que el ADR 0009 exige
 * probar. Objetivo 5.
 *
 * Ronda 1 (12 páginas, todas las del plan):
 *   · netflix-movie p1 — A (netflix) · B (netflix L1 + apple buy) · hasMore
 *   · netflix-series p1 — C (serie) · sin imdb · solo mubi
 *   · prime-movie p1 — A otra vez (netflix + prime): **mismo IMDb en dos
 *     plataformas**, observado después
 *   · disney-movie p1 — D · hasMore
 *   · los otros ocho estratos, vacíos y agotados en su primera página
 *   → 4 elegibles únicos (A, B, C, D): la ronda 2 es obligatoria.
 *
 * Ronda 2 (2 páginas: solo los estratos no agotados):
 *   · netflix-movie p2 — B otra vez, **solo netflix L2**: la apple y L1
 *     desaparecieron · E
 *   · disney-movie p2 — F
 *   → el objetivo (5) se cruza **a mitad de la ronda 2**, tras netflix-movie
 *     p2, y aun así se pide disney-movie p2: 6 elegibles, `objetivo_alcanzado`.
 */
import type { PaginaFalsa } from "./ayudas-seed.ts";
import { show } from "./ayudas-seed.ts";

export const A = "tt0000001";
export const B = "tt0000002";
export const C = "tt0000003";
export const D = "tt0000004";
export const E = "tt0000005";
export const F = "tt0000006";
export const SOLO_MUBI = "tt9000001";

export const L1 = "https://netflix.test/b-antiguo";
export const L2 = "https://netflix.test/b-nuevo";

export const PAGINAS_BASE: Readonly<Record<string, readonly PaginaFalsa[]>> = {
  "netflix-movie": [
    {
      shows: [
        show(A, { opciones: [{ service: "netflix" }] }),
        show(B, {
          opciones: [
            { service: "netflix", link: L1 },
            {
              service: "apple",
              type: "buy",
              price: { amount: "9.99", currency: "EUR" },
            },
          ],
        }),
      ],
    },
    { shows: [show(B, { opciones: [{ service: "netflix", link: L2 }] }), show(E)] },
  ],
  "netflix-series": [
    {
      shows: [
        show(C, { tipo: "series" }),
        show(null),
        show(SOLO_MUBI, { opciones: [{ service: "mubi" }] }),
      ],
    },
  ],
  "prime-movie": [
    {
      shows: [
        show(A, {
          opciones: [
            { service: "netflix" },
            { service: "prime", link: "https://prime.test/a" },
          ],
        }),
      ],
    },
  ],
  "disney-movie": [
    { shows: [show(D, { opciones: [{ service: "disney" }] })] },
    { shows: [show(F, { opciones: [{ service: "disney" }] })] },
  ],
};
