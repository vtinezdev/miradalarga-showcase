/**
 * El checkpoint de `updated`: la misma forma v1 contigua que `deltas`
 * (`checkpointsContiguos`), con **su** tipo. Uno nunca pasa por el otro.
 */
import { describe, expect, it } from "vitest";

import { ArranqueDenegado } from "../../jobs/ops/contratos.ts";
import { checkpointV1 } from "../../jobs/pipelines/deltas/checkpoint.ts";
import type { RegistroDePagina } from "../../jobs/pipelines/deltas/index.ts";
import {
  CHECKPOINTS_DE_UPDATED,
  TIPOS_DE_UPDATED,
} from "../../jobs/pipelines/updated/checkpoint.ts";

const T = new Date("2026-09-25T06:00:00.000Z");
const S = Math.floor(T.getTime() / 1000);

const inicial = () =>
  CHECKPOINTS_DE_UPDATED.inicial({
    ventana: { from: S - 86_400, to: S },
    tipos: TIPOS_DE_UPDATED,
  });

const pagina = (extra: Partial<RegistroDePagina> = {}): RegistroDePagina => ({
  tipo: "updated",
  pagina: 1,
  cursorDeEntrada: null,
  hayMas: false,
  cursorSiguiente: null,
  avisos: 25,
  ultimoTimestamp: new Date(T.getTime() - 3_600_000),
  eventos: {},
  eventosEscritos: 0,
  filasPorTabla: {},
  multiLinkOffers: 0,
  farFutureExpiries: 0,
  ...extra,
});

describe("forma", () => {
  it("nace con la primera página de updated pendiente", () => {
    expect(inicial()).toEqual({
      v: 1,
      ventana: { from: S - 86_400, to: S },
      tipos: ["updated"],
      pendiente: { changeType: "updated", cursorDeEntrada: null },
      ultimoTimestampConfirmado: null,
      paginasConfirmadas: 0,
      reanudaDe: null,
    });
  });

  it("uno de updated no pasa por el de deltas, ni al revés", () => {
    expect(checkpointV1.safeParse(inicial()).success).toBe(false);
    expect(
      CHECKPOINTS_DE_UPDATED.esquema.safeParse({
        ...inicial(),
        tipos: ["removed", "new"],
        pendiente: { changeType: "new", cursorDeEntrada: null },
      }).success,
    ).toBe(false);
  });

  it("una versión desconocida se rechaza nombrando el pipeline", () => {
    expect(() => CHECKPOINTS_DE_UPDATED.leer({ ...inicial(), v: 2 }, 9)).toThrow(
      ArranqueDenegado,
    );
    expect(() => CHECKPOINTS_DE_UPDATED.leer({ ...inicial(), v: 2 }, 9)).toThrow(
      /checkpoint_version_desconocida.*de updated/,
    );
  });
});

describe("avanzar", () => {
  it("con hasMore y cursor, la pendiente es la página siguiente", () => {
    const cp = CHECKPOINTS_DE_UPDATED.avanzar(
      inicial(),
      pagina({ hayMas: true, cursorSiguiente: "1789929846:264318125" }),
    );
    expect(cp.pendiente).toEqual({
      changeType: "updated",
      cursorDeEntrada: "1789929846:264318125",
    });
    expect(cp.paginasConfirmadas).toBe(1);
  });

  it("sin hasMore, la ventana queda agotada", () => {
    const cp = CHECKPOINTS_DE_UPDATED.avanzar(inicial(), pagina());
    expect(cp.pendiente).toBeNull();
    expect(cp.ultimoTimestampConfirmado).toBe(
      new Date(T.getTime() - 3_600_000).toISOString(),
    );
  });

  it("una página de otra lista no avanza un checkpoint de updated", () => {
    expect(() =>
      CHECKPOINTS_DE_UPDATED.avanzar(inicial(), pagina({ tipo: "new" })),
    ).toThrow();
  });
});

describe("planificar", () => {
  const registrado = (checkpoint: unknown, runId = 9) => ({
    runId,
    status: "budget_stopped",
    checkpoint,
  });

  it("pendiente ≠ null: reanuda la misma ventana y el mismo cursor", () => {
    const cortado = CHECKPOINTS_DE_UPDATED.avanzar(
      inicial(),
      pagina({ hayMas: true, cursorSiguiente: "C" }),
    );
    const plan = CHECKPOINTS_DE_UPDATED.planificarDesde({
      ultimo: registrado(cortado),
      ahora: new Date(T.getTime() + 3_600_000),
      sinCheckpoint: "prohibido",
      tipos: TIPOS_DE_UPDATED,
    });
    expect(plan.ventana).toEqual(cortado.ventana);
    expect(plan.pendiente).toEqual({ changeType: "updated", cursorDeEntrada: "C" });
    expect(plan.reanudaDe).toBe(9);
  });

  it("pendiente = null: la siguiente ventana es contigua", () => {
    const agotado = CHECKPOINTS_DE_UPDATED.avanzar(inicial(), pagina());
    const despues = new Date(T.getTime() + 86_400_000);
    const plan = CHECKPOINTS_DE_UPDATED.planificarDesde({
      ultimo: registrado(agotado),
      ahora: despues,
      sinCheckpoint: "prohibido",
      tipos: TIPOS_DE_UPDATED,
    });
    expect(plan.ventana).toEqual({ from: S, to: Math.floor(despues.getTime() / 1000) });
  });

  it("un hueco que /changes ya no cubre: hueco_irrecuperable, sin inventar ventana", () => {
    const agotado = CHECKPOINTS_DE_UPDATED.avanzar(inicial(), pagina());
    expect(() =>
      CHECKPOINTS_DE_UPDATED.planificarDesde({
        ultimo: registrado(agotado),
        ahora: new Date(T.getTime() + 40 * 86_400_000),
        sinCheckpoint: "prohibido",
        tipos: TIPOS_DE_UPDATED,
      }),
    ).toThrow(/hueco_irrecuperable/);
  });

  it("sin checkpoint y prohibido: sin_checkpoint, nombrando updated", () => {
    expect(() =>
      CHECKPOINTS_DE_UPDATED.planificarDesde({
        ultimo: null,
        ahora: T,
        sinCheckpoint: "prohibido",
        tipos: TIPOS_DE_UPDATED,
      }),
    ).toThrow(/sin_checkpoint.*de updated/);
  });
});
