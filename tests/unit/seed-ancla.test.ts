/**
 * El ancla inicial de `deltas` y la compuerta del bootstrap (ADR 0009 §7), con
 * el ejemplo temporal del ADR: `T0 = 2026-11-03 09:00Z`, **`S = 08:00Z`**,
 * vence `2026-11-06 08:00Z`. Reloj inyectado; sin red y sin base.
 *
 *   A · sin checkpoint y sin ancla        → `sin_seed`, 0 requests
 *   B · ancla vigente, sin checkpoint     → `[S, ahora]`
 *   C · `ahora ≥ S + 72 h` sin checkpoint → `ancla_caducada`, 0 requests
 *   D · con checkpoint propio             → el de siempre; el ancla se ignora
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MuestraDeError } from "../../jobs/ops/contratos.ts";
import { crearLibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import type { LibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import { leerPresupuesto } from "../../jobs/ops/presupuesto.ts";
import type { FuenteDeCuota, Transporte } from "../../jobs/ops/transporte.ts";
import {
  conCompuertaDeBootstrap,
  DESTINOS_HISTORICOS,
  politicaDeDeltasSinCheckpoint,
  REGIMEN_POR_DEFECTO,
  regimenDelDestino,
} from "../../jobs/pipelines/arranque.ts";
import type { CheckpointDeDeltas } from "../../jobs/pipelines/deltas/checkpoint.ts";
import {
  checkpointInicial,
  evaluarBootstrap,
  planificarDeltas,
  planificarDesde,
} from "../../jobs/pipelines/deltas/checkpoint.ts";
import type { PlanDelJob } from "../../jobs/pipelines/deltas/job.ts";
import {
  ejecutarJobDeDeltas,
  estrategiaDeDeltas,
  transaccionPorPagina,
} from "../../jobs/pipelines/deltas/job.ts";
import { UMBRAL_DE_RETRASO_MS } from "../../jobs/pipelines/deltas/programado.ts";
import {
  ejecutarJobDeExpiring,
  estrategiaDeExpiring,
} from "../../jobs/pipelines/expiring/job.ts";
import type { RegimenDeArranque } from "../../jobs/pipelines/arranque.ts";
import {
  leerAnclaDelSeed,
  PLAZO_DEL_ANCLA_MS,
} from "../../jobs/pipelines/seed/ancla.ts";
import type { AnclaDelSeed } from "../../jobs/pipelines/seed/ancla.ts";
import type { CheckpointDeCarga } from "../../jobs/pipelines/seed/fases.ts";
import { checkpointDeCargaV1 } from "../../jobs/pipelines/seed/fases.ts";
import {
  ejecutarJobDeUpcoming,
  estrategiaDeUpcoming,
} from "../../jobs/pipelines/upcoming/job.ts";
import {
  ejecutarJobDeUpdated,
  estrategiaDeUpdated,
} from "../../jobs/pipelines/updated/job.ts";
import { conexionDeDatos } from "./ayudas-checkpoint.ts";
import { respuestaCruda, showCrudo } from "./ayudas-deltas.ts";
import type { BaseEnMemoria } from "./base-en-memoria.ts";
import { crearBaseEnMemoria } from "./base-en-memoria.ts";

const T0 = new Date("2026-11-03T09:00:00.000Z");
const S = new Date("2026-11-03T08:00:00.000Z");
const S_SEG = S.getTime() / 1000;
const VENCE = new Date(S.getTime() + PLAZO_DEL_ANCLA_MS);
const T2 = new Date("2026-11-03T11:30:00.000Z"); // primer deltas de validación
const T4 = new Date("2026-11-05T10:30:00.000Z"); // primer deltas de production, ~50,5 h
const TIPOS = ["removed", "new"] as const;

afterEach(() => vi.useRealTimers());

function checkpointDeCarga(
  estado: "pendiente" | "cargada" = "cargada",
): CheckpointDeCarga {
  return checkpointDeCargaV1.parse({
    v: 1,
    fase: "carga",
    estado,
    huella: "a".repeat(64),
    huellaCanonica: "b".repeat(64),
    capturaId: "captura-ejemplo",
    capturaRunIds: ["61"],
    destinoDeLaCaptura: "rama-limpia",
    ancla: S.toISOString(),
    observacion: { desde: T0.toISOString(), hasta: "2026-11-03T09:14:10.000Z" },
    recuentos: { titulos: 5000 },
  });
}

const ANCLA: AnclaDelSeed = {
  runId: 62,
  status: "succeeded",
  checkpoint: checkpointDeCarga(),
  ancla: S,
};

function motivo(f: () => unknown): string {
  try {
    f();
  } catch (error) {
    return (error as { motivo?: string }).motivo ?? "sin_motivo";
  }
  return "no_lanzo";
}

// ── 1 · La planificación, pura ──────────────────────────────────────────────

describe("planificarDesde con ancla_del_seed", () => {
  const plan = (
    ancla: AnclaDelSeed | null,
    ahora: Date,
    ultimo: Parameters<typeof planificarDesde>[0]["ultimo"] = null,
    bootstrapCompleto?: boolean,
  ) =>
    planificarDesde({
      ultimo,
      ahora,
      sinCheckpoint: "ancla_del_seed",
      tipos: TIPOS,
      ancla,
      ...(bootstrapCompleto === undefined ? {} : { bootstrapCompleto }),
    });

  /** El checkpoint de un primer deltas cortado: ventana desde S, `new` pendiente. */
  const cortado: CheckpointDeDeltas = {
    ...checkpointInicial({
      ventana: { from: S_SEG, to: T2.getTime() / 1000 },
      tipos: TIPOS,
    }),
    pendiente: { changeType: "new", cursorDeEntrada: "c1" },
  };

  it("A · sin seed ni checkpoint: sin_seed", () => {
    expect(motivo(() => plan(null, T2))).toBe("sin_seed");
  });

  it("B · ancla vigente: [S, ahora] con el checkpoint v1 de siempre", () => {
    const cp = plan(ANCLA, T2);
    expect(cp).toEqual(
      checkpointInicial({
        ventana: { from: S_SEG, to: T2.getTime() / 1000 },
        tipos: TIPOS,
      }),
    );
    expect(cp.pendiente).toEqual({ changeType: "removed", cursorDeEntrada: null });
    // El ejemplo del ADR: production a las ~50,5 h, desde el MISMO S.
    expect(plan(ANCLA, T4).ventana).toEqual({ from: S_SEG, to: T4.getTime() / 1000 });
  });

  it("C · en S + 72 h exactos, ancla_caducada; un segundo antes, todavía vale", () => {
    expect(motivo(() => plan(ANCLA, VENCE))).toBe("ancla_caducada");
    expect(plan(ANCLA, new Date(VENCE.getTime() - 1000)).ventana.from).toBe(S_SEG);
  });

  it("reanudar el primer deltas a S + 71 h: misma ventana, mismo cursor", () => {
    const a71 = new Date(S.getTime() + 71 * 3_600_000);
    const cp = plan(ANCLA, a71, {
      runId: 70,
      status: "budget_stopped",
      checkpoint: cortado,
    });
    expect(cp.ventana).toEqual(cortado.ventana);
    expect(cp.pendiente).toEqual(cortado.pendiente);
    expect(cp.reanudaDe).toBe(70);
  });

  it("el mismo checkpoint a S + 72 h + 1 s: ancla_caducada, sin reanudar", () => {
    const tarde = new Date(VENCE.getTime() + 1000);
    for (const status of ["budget_stopped", "failed"]) {
      expect(
        motivo(() => plan(ANCLA, tarde, { runId: 70, status, checkpoint: cortado })),
      ).toBe("ancla_caducada");
    }
    // Sin declarar que el bootstrap terminó, el valor por defecto es el estricto.
    expect(
      motivo(() =>
        plan(ANCLA, tarde, { runId: 70, status: "succeeded", checkpoint: cortado }),
      ),
    ).toBe("ancla_caducada");
  });

  it("D · con el bootstrap completo el ancla se ignora, aunque esté caducada", () => {
    const previo: CheckpointDeDeltas = {
      ...checkpointInicial({
        ventana: { from: S_SEG, to: T2.getTime() / 1000 },
        tipos: TIPOS,
      }),
      pendiente: null,
    };
    const despues = new Date(VENCE.getTime() + 86_400_000);
    const cp = plan(
      ANCLA,
      despues,
      { runId: 70, status: "succeeded", checkpoint: previo },
      true,
    );
    expect(cp.ventana).toEqual({
      from: T2.getTime() / 1000,
      to: despues.getTime() / 1000,
    });
    expect(
      motivo(() =>
        plan(
          null,
          despues,
          { runId: 70, status: "succeeded", checkpoint: previo },
          true,
        ),
      ),
    ).toBe("no_lanzo");
  });

  it("ahora no posterior a S: ventana_vacia, no una ventana invertida", () => {
    expect(motivo(() => plan(ANCLA, S))).toBe("ventana_vacia");
  });

  it("regresión: el histórico conserva ventana_de_validacion y no mira ningún ancla", () => {
    const cp = planificarDesde({
      ultimo: null,
      ahora: T2,
      sinCheckpoint: "ventana_de_validacion",
      tipos: TIPOS,
      ancla: ANCLA,
    });
    expect(cp.ventana).toEqual({
      from: T2.getTime() / 1000 - 86_400,
      to: T2.getTime() / 1000,
    });
    expect(
      motivo(() =>
        planificarDesde({
          ultimo: null,
          ahora: T2,
          sinCheckpoint: "prohibido",
          tipos: TIPOS,
        }),
      ),
    ).toBe("sin_checkpoint");
  });

  it("el plazo del ancla es el mismo umbral de retraso que ya aplica deltas", () => {
    expect(PLAZO_DEL_ANCLA_MS).toBe(UMBRAL_DE_RETRASO_MS);
  });
});

describe("el ancla se lee del checkpoint de la carga", () => {
  it("la última carga confirmada; una pendiente no es ancla", async () => {
    const libro = crearLibroEnMemoria();
    libro.sembrarFila({
      pipeline: "seed",
      status: "failed",
      checkpoint: checkpointDeCarga("pendiente"),
    });
    expect(await leerAnclaDelSeed(libro.ejecutor)).toBeNull();
    // Una huérfana `failed` con `cargada` sigue siendo ancla: el COMMIT ocurrió.
    libro.sembrarFila({
      pipeline: "seed",
      status: "failed",
      checkpoint: checkpointDeCarga(),
    });
    expect((await leerAnclaDelSeed(libro.ejecutor))?.ancla.toISOString()).toBe(
      S.toISOString(),
    );
  });

  it("planificarDeltas lee el ancla solo si no hay checkpoint propio", async () => {
    const libro = crearLibroEnMemoria();
    libro.sembrarFila({
      pipeline: "seed",
      status: "succeeded",
      checkpoint: checkpointDeCarga(),
    });
    const cp = await planificarDeltas(libro.ejecutor, {
      ahora: T2,
      sinCheckpoint: "ancla_del_seed",
      tipos: TIPOS,
    });
    expect(cp.ventana.from).toBe(S_SEG);
  });

  it("un checkpoint de carga ilegible no se salta", async () => {
    const libro = crearLibroEnMemoria();
    libro.sembrarFila({
      pipeline: "seed",
      status: "succeeded",
      checkpoint: { v: 1, fase: "carga", estado: "cargada", ancla: "ayer" },
    });
    await expect(leerAnclaDelSeed(libro.ejecutor)).rejects.toMatchObject({
      motivo: "checkpoint_invalido",
    });
  });
});

// ── 2 · El job de deltas de punta a punta ───────────────────────────────────

const VACIA = { changes: [], shows: {}, hasMore: false };
const CUOTA = {
  "x-quota-used": "130",
  "x-quota-granted": "1000",
  "x-quota-reset": "2026-12-01T00:00:00Z",
};

function red() {
  let llamadas = 0;
  const crear =
    (fuente: FuenteDeCuota): Transporte =>
    async () => {
      await fuente.pedirCuota();
      llamadas++;
      return new Response(JSON.stringify(VACIA), {
        status: 200,
        headers: { "content-type": "application/json", ...CUOTA },
      });
    };
  return { crear, llamadas: () => llamadas };
}

function comunes(
  libro: LibroEnMemoria,
  ahora: Date,
  crear: (f: FuenteDeCuota) => Transporte,
  tope: Record<string, number> = {},
  base: BaseEnMemoria = crearBaseEnMemoria(),
) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ahora);
  const datos = conexionDeDatos(base, libro);
  const topes = Object.entries(tope)
    .map(([p, n]) => `${p}=${String(n)}`)
    .join(",");
  return {
    ejecutorOps: libro.ejecutor,
    ejecutorDatos: datos.ejecutor,
    transaccion: transaccionPorPagina(datos.ejecutor),
    presupuesto: leerPresupuesto(
      topes === "" ? {} : { STREAMING_API_PER_RUN_CAPS: topes },
    ),
    crearLlamada: crear,
    apiKey: "k",
    ahora,
    crearRegistro: null,
    vincularEventos: true,
  } as const;
}

const ANCLA_DEL_SEED: PlanDelJob = {
  origen: "persistente",
  sinCheckpoint: "ancla_del_seed",
};
const primerMotivo = (m: readonly MuestraDeError[]) => m[0]?.motivo;

function destinoCargado(): LibroEnMemoria {
  const libro = crearLibroEnMemoria();
  libro.sembrarFila({
    pipeline: "seed",
    status: "succeeded",
    checkpoint: checkpointDeCarga(),
  });
  return libro;
}

describe("deltas en un destino bootstrappeado", () => {
  it("A · sin seed: failed sin_seed, 0 requests, ni una llamada", async () => {
    const libro = crearLibroEnMemoria();
    const r = red();
    const s = await ejecutarJobDeDeltas({
      ...comunes(libro, T2, r.crear),
      plan: ANCLA_DEL_SEED,
    });
    expect(s.resultado).toMatchObject({ ejecutado: true, estado: "failed" });
    if (!s.resultado.ejecutado) return;
    expect(primerMotivo(s.resultado.metricas.errorSamples)).toBe("sin_seed");
    expect(r.llamadas()).toBe(0);
    expect(libro.filas.map((f) => [f.pipeline, f.requestsMade])).toEqual([
      ["deltas", 0],
    ]);
  });

  it("C · ancla caducada: failed ancla_caducada, 0 requests", async () => {
    const libro = destinoCargado();
    const r = red();
    const s = await ejecutarJobDeDeltas({
      ...comunes(libro, VENCE, r.crear),
      plan: ANCLA_DEL_SEED,
    });
    if (!s.resultado.ejecutado) throw new Error("tenía que ejecutarse");
    expect(primerMotivo(s.resultado.metricas.errorSamples)).toBe("ancla_caducada");
    expect(r.llamadas()).toBe(0);
  });

  it("B · primer deltas: [S, ahora], sin fila falsa; D · el siguiente sigue contiguo desde su checkpoint", async () => {
    const libro = destinoCargado();
    // Antes del primer deltas no hay ninguna fila de deltas: nadie la inventó.
    expect(libro.filas.map((f) => f.pipeline)).toEqual(["seed"]);

    const r = red();
    const primero = await ejecutarJobDeDeltas({
      ...comunes(libro, T2, r.crear),
      plan: ANCLA_DEL_SEED,
    });
    expect(primero.resultado).toMatchObject({ ejecutado: true, estado: "succeeded" });
    expect(primero.checkpoint?.ventana).toEqual({
      from: S_SEG,
      to: T2.getTime() / 1000,
    });
    expect(r.llamadas()).toBe(2); // removed + new, vacías

    // Pasado S + 72 h ya no importa: el bootstrap terminó con el primer deltas.
    const tarde = new Date(VENCE.getTime() + 3_600_000);
    const segundo = await ejecutarJobDeDeltas({
      ...comunes(libro, tarde, red().crear),
      plan: ANCLA_DEL_SEED,
    });
    expect(segundo.resultado).toMatchObject({ ejecutado: true, estado: "succeeded" });
    expect(segundo.checkpoint?.ventana).toEqual({
      from: T2.getTime() / 1000,
      to: tarde.getTime() / 1000,
    });
  });
});

// ── 3 · La compuerta del bootstrap ──────────────────────────────────────────

type Pipeline = "expiring" | "upcoming" | "updated";

async function correr(
  pipeline: Pipeline,
  libro: LibroEnMemoria,
  regimen?: RegimenDeArranque,
) {
  const r = red();
  const base = comunes(libro, T2, r.crear, { updated: 4 });
  const extra = regimen === undefined ? {} : { regimen };
  const salida =
    pipeline === "expiring"
      ? await ejecutarJobDeExpiring({
          ...base,
          plan: { origen: "persistente" },
          ...extra,
        })
      : pipeline === "upcoming"
        ? await ejecutarJobDeUpcoming({
            ...base,
            plan: { origen: "persistente" },
            ...extra,
          })
        : await ejecutarJobDeUpdated({
            ...base,
            plan: { origen: "persistente", sinCheckpoint: "ventana_de_validacion" },
            ...extra,
          });
  return { salida, llamadas: r.llamadas() };
}

const PIPELINES: readonly Pipeline[] = ["expiring", "upcoming", "updated"];
const HORIZONTES: readonly Pipeline[] = ["expiring", "upcoming"];

/** Un checkpoint v1 de deltas desde S, completo o con una página pendiente. */
function checkpointDeDeltas(completo: boolean): CheckpointDeDeltas {
  const cp = checkpointInicial({
    ventana: { from: S_SEG, to: T2.getTime() / 1000 - 60 },
    tipos: TIPOS,
  });
  return completo
    ? { ...cp, pendiente: null }
    : { ...cp, pendiente: { changeType: "new", cursorDeEntrada: "c1" } };
}

function sembrarDeltas(
  libro: LibroEnMemoria,
  checkpoint: unknown,
  status: "succeeded" | "failed" | "budget_stopped" = "succeeded",
  finishedAt: Date | null = T2,
) {
  libro.sembrarFila({ pipeline: "deltas", status, checkpoint, finishedAt });
}

async function motivoYCausa(
  p: Pipeline,
  libro: LibroEnMemoria,
  regimen?: RegimenDeArranque,
) {
  const { salida, llamadas } = await correr(p, libro, regimen);
  if (!salida.resultado.ejecutado) throw new Error("tenía que ejecutarse");
  const m = salida.resultado.metricas.errorSamples[0];
  return {
    estado: salida.resultado.estado,
    motivo: m?.motivo,
    causa: m?.causa,
    llamadas,
  };
}

describe("bootstrap_incompleto: el bootstrap solo termina con un primer deltas completo", () => {
  it.each(PIPELINES)(
    "%s: seed cargado y sin primer deltas → failed, 0 requests",
    async (p) => {
      const libro = destinoCargado();
      const r = await motivoYCausa(p, libro, "bootstrap_del_seed");
      expect(r).toEqual({
        estado: "failed",
        motivo: "bootstrap_incompleto",
        causa: "sin_primer_deltas",
        llamadas: 0,
      });
      expect(libro.filas.find((f) => f.pipeline === p)?.requestsMade).toBe(0);
    },
  );

  it.each(HORIZONTES)(
    "%s: primer deltas succeeded y sin página pendiente → arranca",
    async (p) => {
      const libro = destinoCargado();
      sembrarDeltas(libro, checkpointDeDeltas(true), "succeeded");
      const { salida, llamadas } = await correr(p, libro, "bootstrap_del_seed");
      expect(salida.resultado).toMatchObject({ ejecutado: true, estado: "succeeded" });
      expect(llamadas).toBeGreaterThan(0);
    },
  );

  it.each(PIPELINES)(
    "%s: primer deltas failed, aunque su checkpoint esté completo → incompleto",
    async (p) => {
      const libro = destinoCargado();
      sembrarDeltas(libro, checkpointDeDeltas(true), "failed");
      expect(await motivoYCausa(p, libro, "bootstrap_del_seed")).toEqual({
        estado: "failed",
        motivo: "bootstrap_incompleto",
        causa: "deltas_sin_completar",
        llamadas: 0,
      });
    },
  );

  it.each(PIPELINES)(
    "%s: primer deltas budget_stopped con página pendiente → incompleto",
    async (p) => {
      const libro = destinoCargado();
      sembrarDeltas(libro, checkpointDeDeltas(false), "budget_stopped");
      expect(await motivoYCausa(p, libro, "bootstrap_del_seed")).toMatchObject({
        motivo: "bootstrap_incompleto",
        causa: "deltas_sin_completar",
        llamadas: 0,
      });
    },
  );

  it("un succeeded que dejara página pendiente tampoco cuenta", async () => {
    const libro = destinoCargado();
    sembrarDeltas(libro, checkpointDeDeltas(false), "succeeded");
    expect((await motivoYCausa("expiring", libro, "bootstrap_del_seed")).motivo).toBe(
      "bootstrap_incompleto",
    );
  });

  it("un checkpoint de deltas ilegible no cuenta como primer deltas", async () => {
    const libro = destinoCargado();
    sembrarDeltas(libro, { v: 1, roto: true });
    expect(await motivoYCausa("expiring", libro, "bootstrap_del_seed")).toMatchObject({
      motivo: "bootstrap_incompleto",
      causa: "checkpoint_invalido",
      llamadas: 0,
    });
  });

  it("de punta a punta: un deltas cortado por tope no termina el bootstrap; su reanudación completa, sí", async () => {
    const libro = destinoCargado();
    // Tope 1: la lista removed entra, la new se queda pendiente.
    const cortado = await ejecutarJobDeDeltas({
      ...comunes(libro, T2, red().crear, { deltas: 1 }),
      plan: ANCLA_DEL_SEED,
    });
    expect(cortado.resultado).toMatchObject({
      ejecutado: true,
      estado: "budget_stopped",
    });
    expect(cortado.checkpoint?.pendiente).not.toBeNull();
    expect((await motivoYCausa("expiring", libro, "bootstrap_del_seed")).causa).toBe(
      "deltas_sin_completar",
    );

    const despues = new Date(T2.getTime() + 3_600_000);
    const reanudado = await ejecutarJobDeDeltas({
      ...comunes(libro, despues, red().crear),
      plan: ANCLA_DEL_SEED,
    });
    expect(reanudado.resultado).toMatchObject({ ejecutado: true, estado: "succeeded" });
    // Reanudó la ventana inicial desde S, no una nueva.
    expect(reanudado.checkpoint?.ventana.from).toBe(S_SEG);
    expect(reanudado.checkpoint?.pendiente).toBeNull();
    const { salida } = await correr("expiring", libro, "bootstrap_del_seed");
    expect(salida.resultado).toMatchObject({ ejecutado: true, estado: "succeeded" });
  });

  it("updated fuera del histórico: pasa la compuerta, pero ventana_de_validacion degrada a prohibido", async () => {
    const libro = destinoCargado();
    sembrarDeltas(libro, checkpointDeDeltas(true), "succeeded");
    expect(await motivoYCausa("updated", libro, "bootstrap_del_seed")).toMatchObject({
      estado: "failed",
      motivo: "sin_checkpoint",
      llamadas: 0,
    });
  });
});

describe("fail-safe: quien no declara el régimen queda en el estricto", () => {
  it("el régimen por defecto es bootstrap_del_seed", () => {
    expect(REGIMEN_POR_DEFECTO).toBe("bootstrap_del_seed");
  });

  it.each(PIPELINES)(
    "%s sin régimen, en un destino vacío: bootstrap_incompleto, 0 requests",
    async (p) => {
      const libro = crearLibroEnMemoria();
      expect(await motivoYCausa(p, libro)).toMatchObject({
        estado: "failed",
        motivo: "bootstrap_incompleto",
        llamadas: 0,
      });
    },
  );

  it("las estrategias sin régimen también llevan la compuerta", async () => {
    const libro = crearLibroEnMemoria();
    for (const e of [
      estrategiaDeExpiring(),
      estrategiaDeUpcoming(),
      estrategiaDeUpdated("ventana_de_validacion"),
    ]) {
      await expect(e.planificar(libro.ejecutor, T2)).rejects.toMatchObject({
        motivo: "bootstrap_incompleto",
      });
    }
  });

  it.each(PIPELINES)(
    "regresión: %s con el régimen histórico DECLARADO no tiene compuerta",
    async (p) => {
      const libro = crearLibroEnMemoria();
      const { salida } = await correr(p, libro, "historico");
      expect(salida.resultado).toMatchObject({ ejecutado: true, estado: "succeeded" });
    },
  );

  it("los programados solo obtienen el histórico por el nombre exacto de la rama", () => {
    expect(regimenDelDestino("drizzle-schema-v1-test")).toBe("historico");
    expect(regimenDelDestino("drizzle-schema-v1-test ")).toBe("bootstrap_del_seed");
    expect(regimenDelDestino("DRIZZLE-SCHEMA-V1-TEST")).toBe("bootstrap_del_seed");
  });
});

describe("régimen por destino, explícito en código", () => {
  it("drizzle-schema-v1-test es el único histórico; todo lo demás, estricto", () => {
    expect(DESTINOS_HISTORICOS).toEqual({ "drizzle-schema-v1-test": "historico" });
    expect(regimenDelDestino("drizzle-schema-v1-test")).toBe("historico");
    for (const otro of [
      "production",
      "seed-bootstrap-v1",
      "",
      "constructor",
      "toString",
    ]) {
      expect(regimenDelDestino(otro)).toBe("bootstrap_del_seed");
    }
  });

  it("deltas: histórico → ventana_de_validacion; bootstrap → ancla_del_seed", () => {
    expect(politicaDeDeltasSinCheckpoint("historico")).toBe("ventana_de_validacion");
    expect(politicaDeDeltasSinCheckpoint("bootstrap_del_seed")).toBe("ancla_del_seed");
  });

  it("la compuerta no se aplica a deltas y en el histórico devuelve la misma estrategia", () => {
    expect(() =>
      conCompuertaDeBootstrap(
        estrategiaDeDeltas("ancla_del_seed"),
        "bootstrap_del_seed",
      ),
    ).toThrow();
    const e = estrategiaDeExpiring();
    expect(conCompuertaDeBootstrap(e, "historico")).toBe(e);
  });

  it("la compuerta no toca fijo (ensayo y reproducción no gastan cuota)", () => {
    const e = estrategiaDeExpiring();
    const ventana = { from: S_SEG, to: S_SEG + 3600 };
    // Sin ejecutor: si consultara la base para decidir, no podría ni llamarse.
    expect(conCompuertaDeBootstrap(e, "bootstrap_del_seed").fijo(ventana)).toEqual(
      e.fijo(ventana),
    );
  });
});

describe("plazo del bootstrap: 72 h desde S, también para reanudar el primer deltas", () => {
  const A71 = new Date(S.getTime() + 71 * 3_600_000);
  const TARDE = new Date(VENCE.getTime() + 1000);

  /** Un destino cargado cuyo primer deltas se cortó por tope a las T2. */
  async function primerDeltasCortado() {
    const libro = destinoCargado();
    const base = crearBaseEnMemoria();
    const primero = await ejecutarJobDeDeltas({
      ...comunes(libro, T2, red().crear, { deltas: 1 }, base),
      plan: ANCLA_DEL_SEED,
    });
    expect(primero.resultado).toMatchObject({
      ejecutado: true,
      estado: "budget_stopped",
    });
    return {
      libro,
      base,
      runId: primero.resultado.ejecutado ? primero.resultado.runId : -1,
    };
  }

  it("1 · un budget_stopped a S + 71 h reanuda su ventana y completa el bootstrap", async () => {
    const { libro, base, runId } = await primerDeltasCortado();
    const r = red();
    const s = await ejecutarJobDeDeltas({
      ...comunes(libro, A71, r.crear, {}, base),
      plan: ANCLA_DEL_SEED,
    });
    expect(s.resultado).toMatchObject({ ejecutado: true, estado: "succeeded" });
    expect(s.checkpoint).toMatchObject({ reanudaDe: runId, pendiente: null });
    expect(s.checkpoint?.ventana.from).toBe(S_SEG);
    expect(r.llamadas()).toBeGreaterThan(0);
  });

  it("2 y 3 · el mismo checkpoint a S + 72 h + 1 s: ancla_caducada, 0 reservas, 0 API, nada tocado", async () => {
    const { libro, base, runId } = await primerDeltasCortado();
    const checkpointAntes = structuredClone(
      libro.filas.find((f) => f.id === runId)?.checkpoint,
    );
    const fotoAntes = base.foto();
    const r = red();
    const s = await ejecutarJobDeDeltas({
      ...comunes(libro, TARDE, r.crear, {}, base),
      plan: ANCLA_DEL_SEED,
    });
    if (!s.resultado.ejecutado) throw new Error("tenía que ejecutarse");
    expect(s.resultado.estado).toBe("failed");
    expect(s.resultado.metricas.errorSamples[0]).toMatchObject({
      motivo: "ancla_caducada",
      checkpoint_run_id: runId,
      checkpoint_estado: "budget_stopped",
    });
    // 0 reservas y 0 llamadas.
    expect(r.llamadas()).toBe(0);
    const nueva = s.resultado.runId;
    expect(libro.filas.find((f) => f.id === nueva)?.requestsMade).toBe(0);
    // Ni el checkpoint interrumpido ni el catálogo cambian.
    expect(libro.filas.find((f) => f.id === runId)?.checkpoint).toEqual(
      checkpointAntes,
    );
    expect(base.foto()).toEqual(fotoAntes);
    // Inerte: los demás siguen bloqueados y un nuevo intento de deltas, también.
    expect((await motivoYCausa("expiring", libro, "bootstrap_del_seed")).motivo).toBe(
      "bootstrap_incompleto",
    );
    const otra = await ejecutarJobDeDeltas({
      ...comunes(libro, new Date(TARDE.getTime() + 86_400_000), red().crear, {}, base),
      plan: ANCLA_DEL_SEED,
    });
    if (!otra.resultado.ejecutado) throw new Error("tenía que ejecutarse");
    expect(otra.resultado.metricas.errorSamples[0]?.motivo).toBe("ancla_caducada");
  });

  it("4 · un primer deltas failed caducado tampoco reanuda, con o sin página pendiente", async () => {
    for (const completo of [false, true]) {
      const libro = destinoCargado();
      sembrarDeltas(libro, checkpointDeDeltas(completo), "failed");
      const r = red();
      const s = await ejecutarJobDeDeltas({
        ...comunes(libro, TARDE, r.crear),
        plan: ANCLA_DEL_SEED,
      });
      if (!s.resultado.ejecutado) throw new Error("tenía que ejecutarse");
      expect(s.resultado.metricas.errorSamples[0]).toMatchObject({
        motivo: "ancla_caducada",
        checkpoint_estado: "failed",
      });
      expect(r.llamadas()).toBe(0);
    }
  });

  it("5 · un primer deltas succeeded antes de las 72 h desbloquea el destino", async () => {
    const libro = destinoCargado();
    const primero = await ejecutarJobDeDeltas({
      ...comunes(libro, T2, red().crear),
      plan: ANCLA_DEL_SEED,
    });
    expect(primero.resultado).toMatchObject({ ejecutado: true, estado: "succeeded" });
    for (const p of HORIZONTES) {
      const { salida } = await correr(p, libro, "bootstrap_del_seed");
      expect(salida.resultado).toMatchObject({ ejecutado: true, estado: "succeeded" });
    }
  });

  it("6 · cruzar las 72 h después del primer deltas completo no cambia el régimen normal", async () => {
    const libro = destinoCargado();
    await ejecutarJobDeDeltas({
      ...comunes(libro, T2, red().crear),
      plan: ANCLA_DEL_SEED,
    });
    const mucho = new Date(VENCE.getTime() + 30 * 3_600_000);
    // Cortado por tope después de las 72 h: sigue siendo régimen normal y reanuda.
    const cortadoTarde = await ejecutarJobDeDeltas({
      ...comunes(libro, mucho, red().crear, { deltas: 1 }),
      plan: ANCLA_DEL_SEED,
    });
    expect(cortadoTarde.resultado).toMatchObject({
      ejecutado: true,
      estado: "budget_stopped",
    });
    expect(cortadoTarde.checkpoint?.ventana.from).toBe(T2.getTime() / 1000);
    const masTarde = new Date(mucho.getTime() + 3_600_000);
    const reanuda = await ejecutarJobDeDeltas({
      ...comunes(libro, masTarde, red().crear),
      plan: ANCLA_DEL_SEED,
    });
    expect(reanuda.resultado).toMatchObject({ ejecutado: true, estado: "succeeded" });
    expect(reanuda.checkpoint?.reanudaDe).not.toBeNull();
    const { salida } = await correr("upcoming", libro, "bootstrap_del_seed");
    expect(salida.resultado).toMatchObject({ ejecutado: true, estado: "succeeded" });
  });
});

describe("el primer deltas tiene que TERMINAR antes de S + 72 h", () => {
  const MIN = 60_000;
  const LINK = "https://netflix.test/tardio";

  /**
   * Un `/changes` con un alta real en `new` —para que el run escriba catálogo—
   * y un reloj que salta a `fin` en la primera request: el cierre de la fila
   * (`finished_at`, el now() del libro) cae en `fin`.
   */
  function redQueTermina(fin: Date) {
    let llamadas = 0;
    const alta = respuestaCruda({
      cambios: [
        {
          changeType: "new",
          showId: "77",
          service: "netflix",
          type: "subscription",
          link: LINK,
          timestamp: S_SEG + 3600,
        },
      ],
      shows: [
        showCrudo({
          id: "77",
          imdbId: "tt0000077",
          opciones: [{ service: "netflix", type: "subscription", link: LINK }],
        }),
      ],
    });
    const crear =
      (fuente: FuenteDeCuota): Transporte =>
      async (url) => {
        await fuente.pedirCuota();
        if (llamadas === 0) vi.setSystemTime(fin);
        llamadas++;
        const tipo = new URL(url).searchParams.get("change_type");
        return new Response(JSON.stringify(tipo === "new" ? alta : VACIA), {
          status: 200,
          headers: { "content-type": "application/json", ...CUOTA },
        });
      };
    return { crear, llamadas: () => llamadas };
  }

  /** Un destino cargado cuyo primer deltas empieza en `inicio` y termina en `fin`. */
  async function primerDeltas(inicio: Date, fin: Date) {
    const libro = destinoCargado();
    const base = crearBaseEnMemoria();
    const s = await ejecutarJobDeDeltas({
      ...comunes(libro, inicio, redQueTermina(fin).crear, {}, base),
      plan: ANCLA_DEL_SEED,
    });
    expect(s.resultado).toMatchObject({ ejecutado: true, estado: "succeeded" });
    expect(s.checkpoint).toMatchObject({ pendiente: null, ventana: { from: S_SEG } });
    const runId = s.resultado.ejecutado ? s.resultado.runId : -1;
    expect(libro.filas.find((f) => f.id === runId)?.finishedAt?.toISOString()).toBe(
      fin.toISOString(),
    );
    return { libro, base };
  }

  it("1 · termina a S + 71 h 59 min: bootstrap válido", async () => {
    const { libro } = await primerDeltas(
      new Date(VENCE.getTime() - 2 * MIN),
      new Date(VENCE.getTime() - MIN),
    );
    expect(await evaluarBootstrap(libro.ejecutor)).toMatchObject({ completo: true });
    for (const p of HORIZONTES) {
      const { salida } = await correr(p, libro, "bootstrap_del_seed");
      expect(salida.resultado).toMatchObject({ ejecutado: true, estado: "succeeded" });
    }
  });

  it.each([
    ["2 · termina exactamente a S + 72 h", 0],
    ["3 · termina a S + 72 h 01 min", MIN],
  ])(
    "%s: caducado; la compuerta no se levanta y deltas no continúa",
    async (_, extra) => {
      const fin = new Date(VENCE.getTime() + extra);
      const { libro } = await primerDeltas(new Date(VENCE.getTime() - MIN), fin);
      expect(await evaluarBootstrap(libro.ejecutor)).toMatchObject({
        completo: false,
        causa: "primer_deltas_tardio",
      });
      // 5 · Ni expiring, ni upcoming, ni updated.
      for (const p of PIPELINES) {
        const r = await motivoYCausa(p, libro, "bootstrap_del_seed");
        expect(r).toMatchObject({
          estado: "failed",
          motivo: "bootstrap_incompleto",
          causa: "ancla_caducada",
          llamadas: 0,
        });
      }
      // Y ningún deltas de bootstrap posterior continúa: 0 requests.
      const r = red();
      const otro = await ejecutarJobDeDeltas({
        ...comunes(libro, new Date(fin.getTime() + 3_600_000), r.crear),
        plan: ANCLA_DEL_SEED,
      });
      if (!otro.resultado.ejecutado) throw new Error("tenía que ejecutarse");
      expect(otro.resultado.metricas.errorSamples[0]).toMatchObject({
        motivo: "ancla_caducada",
        causa_del_bootstrap: "primer_deltas_tardio",
      });
      expect(r.llamadas()).toBe(0);
    },
  );

  it("4 · lo que escribió el run tardío no se borra ni se revierte", async () => {
    const { libro, base } = await primerDeltas(
      new Date(VENCE.getTime() - MIN),
      new Date(VENCE.getTime() + MIN),
    );
    expect(base.opcion(LINK)).toBeDefined();
    const antes = base.foto();
    const tarde = new Date(VENCE.getTime() + 3_600_000);
    await ejecutarJobDeDeltas({
      ...comunes(libro, tarde, red().crear, {}, base),
      plan: ANCLA_DEL_SEED,
    });
    await motivoYCausa("expiring", libro, "bootstrap_del_seed");
    expect(base.foto()).toEqual(antes);
    expect(base.opcion(LINK)).toBeDefined();
  });

  it("6 · completado antes del límite, el plazo deja de importar", async () => {
    const { libro, base } = await primerDeltas(
      new Date(VENCE.getTime() - 2 * MIN),
      new Date(VENCE.getTime() - MIN),
    );
    const mucho = new Date(VENCE.getTime() + 40 * 3_600_000);
    const siguiente = await ejecutarJobDeDeltas({
      ...comunes(libro, mucho, red().crear, {}, base),
      plan: ANCLA_DEL_SEED,
    });
    expect(siguiente.resultado).toMatchObject({ ejecutado: true, estado: "succeeded" });
    // Contigua desde el to del primero, no desde S: régimen normal.
    expect(siguiente.checkpoint?.ventana.from).toBe(
      Math.floor((VENCE.getTime() - 2 * MIN) / 1000),
    );
    const { salida } = await correr("upcoming", libro, "bootstrap_del_seed");
    expect(salida.resultado).toMatchObject({ ejecutado: true, estado: "succeeded" });
  });

  it("evaluarBootstrap, con filas sembradas: el borde, un finished_at nulo y una ventana que no arranca en S", async () => {
    const casos: [Date | null, number, string | true][] = [
      [new Date(VENCE.getTime() - 1), S_SEG, true],
      [VENCE, S_SEG, "primer_deltas_tardio"],
      [null, S_SEG, "primer_deltas_tardio"],
      [T2, S_SEG + 60, "ventana_no_arranca_en_el_ancla"],
    ];
    for (const [finishedAt, from, esperado] of casos) {
      const libro = destinoCargado();
      sembrarDeltas(
        libro,
        {
          ...checkpointInicial({
            ventana: { from, to: T2.getTime() / 1000 },
            tipos: TIPOS,
          }),
          pendiente: null,
        },
        "succeeded",
        finishedAt,
      );
      const e = await evaluarBootstrap(libro.ejecutor);
      if (esperado === true) expect(e.completo).toBe(true);
      else expect(e).toMatchObject({ completo: false, causa: esperado });
    }
  });
});
