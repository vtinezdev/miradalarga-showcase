/**
 * La carga del seed (ADR 0009 §5, §9, §10) contra un almacén en memoria que
 * obedece al SQL del upsert. **0 API, 0 Neon.**
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { NS_CATALOGO, NS_PIPELINE } from "../../jobs/ops/bloqueo.ts";
import type { EjecutorSql } from "../../jobs/ops/contratos.ts";
import { crearLibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import { leerPresupuesto } from "../../jobs/ops/presupuesto.ts";
import {
  leerAnclaDelSeed,
  PLAZO_DEL_ANCLA_MS,
} from "../../jobs/pipelines/seed/ancla.ts";
import { CAPACIDADES_MVP } from "../../jobs/pipelines/seed/capacidades.ts";
import type { OpcionesDeCarga } from "../../jobs/pipelines/seed/carga.ts";
import {
  codigoDeSalidaDeLaCarga,
  decidirCarga,
  ejecutarCargaDelSeed,
  transaccionUnica,
} from "../../jobs/pipelines/seed/carga.ts";
import type { ManifiestoDelSeed } from "../../jobs/pipelines/seed/crudo/formato.ts";
import type { CrudoVerificado } from "../../jobs/pipelines/seed/crudo/verificar.ts";
import { verificarCrudo } from "../../jobs/pipelines/seed/crudo/verificar.ts";
import type { CheckpointDeCarga } from "../../jobs/pipelines/seed/fases.ts";
import { huellaCanonicaDelCatalogo } from "../../jobs/pipelines/seed/huella-catalogo.ts";
import { ejecutarSeed } from "../../jobs/pipelines/seed/index.ts";
import type { AlmacenDelSeed } from "./ayudas-seed.ts";
import {
  capturar,
  crearAlmacenDelSeed,
  crearPlan,
  fijarReloj,
  reempaquetar,
  show,
} from "./ayudas-seed.ts";
import { PAGINAS_BASE } from "./ayudas-seed-fixtures.ts";

/** El presupuesto del REPOSITORIO: seed 0/0. La carga no necesita ni una request. */
const PRESUPUESTO = leerPresupuesto({});

let CRUDO: CrudoVerificado;
let OTRO: CrudoVerificado;
let FALLIDO: CrudoVerificado;
let MEDIA_RONDA: CrudoVerificado;
let FRONTERA: CrudoVerificado;
let ID_GRANDE: CrudoVerificado;

/** Un id de ops_sync_runs por encima de Number.MAX_SAFE_INTEGER. */
const GRANDE = "9007199254740993";

async function verificado(
  paginas: Parameters<typeof capturar>[0]["paginas"],
  capturaId = "prueba-001",
  extra: {
    readonly tope?: number;
    readonly mutar?: (m: ManifiestoDelSeed) => ManifiestoDelSeed;
  } = {},
) {
  const c = await capturar({
    paginas,
    plan: crearPlan({ capturaId }),
    ...(extra.tope === undefined ? {} : { tope: extra.tope }),
  });
  const contenido =
    extra.mutar === undefined ? c.contenido : reempaquetar(c.contenido, extra.mutar);
  const v = verificarCrudo(contenido);
  if (v.crudo === null) throw new Error(JSON.stringify(v.problemas));
  return v.crudo;
}

beforeAll(async () => {
  fijarReloj();
  CRUDO = await verificado(PAGINAS_BASE);
  OTRO = await verificado(
    { "netflix-movie": [{ shows: [show("tt7777777")] }] },
    "prueba-002",
  );
  FALLIDO = await verificado(
    { "netflix-movie": [{ cuerpoCrudo: "no json" }] },
    "prueba-003",
  );
  MEDIA_RONDA = await verificado(PAGINAS_BASE, "prueba-004", { tope: 5 });
  FRONTERA = await verificado(PAGINAS_BASE, "prueba-005", { tope: 12 });
  ID_GRANDE = await verificado(PAGINAS_BASE, "prueba-006", {
    mutar: (m) => ({
      ...m,
      paginas: m.paginas.map((p) => ({ ...p, runId: GRANDE })),
      cierre: m.cierre === null ? null : { ...m.cierre, filasDeOps: [GRANDE] },
    }),
  });
  vi.useRealTimers();
});
afterEach(() => vi.useRealTimers());

/** Dos horas después de S: dentro del plazo. */
const dentroDelPlazo = () => new Date(CRUDO.ancla.getTime() + 2 * 3_600_000);

function cargar(almacen: AlmacenDelSeed, parcial: Partial<OpcionesDeCarga> = {}) {
  return ejecutarCargaDelSeed({
    ejecutorOps: almacen.libro.ejecutor,
    ejecutorDatos: almacen.ejecutor,
    transaccion: transaccionUnica(almacen.ejecutor),
    presupuesto: PRESUPUESTO,
    ahora: dentroDelPlazo(),
    crudo: CRUDO,
    ...parcial,
  });
}

const huellaDelAlmacen = (a: AlmacenDelSeed) =>
  huellaCanonicaDelCatalogo(a.filasCanonicas());

describe("carga en un destino virgen", () => {
  it("succeeded, requests_made = 0, ancla = S del crudo y huella canónica idéntica a la offline", async () => {
    const almacen = crearAlmacenDelSeed();
    const r = await cargar(almacen);
    expect(r.resultado).toMatchObject({ ejecutado: true, estado: "succeeded" });
    expect(r.decision).toEqual({ tipo: "virgen" });
    const fila = almacen.libro.filas[0];
    expect(fila?.pipeline).toBe("seed");
    expect(fila?.requestsMade).toBe(0);
    const cp = fila?.checkpoint as CheckpointDeCarga;
    expect(cp).toMatchObject({
      fase: "carga",
      estado: "cargada",
      huella: CRUDO.huella,
    });
    expect(cp.ancla).toBe(CRUDO.ancla.toISOString());
    expect(cp.observacion).toEqual({
      desde: CRUDO.T0.toISOString(),
      hasta: CRUDO.T1.toISOString(),
    });
    // Replay exacto: lo cargado es lo que seed:verificar calculó sin base.
    expect(huellaDelAlmacen(almacen)).toBe(CRUDO.huellaCanonica);
    expect(fila?.rowsAffected?.external_titles).toBe(6);
  });

  it("el ancla se lee como la leerá deltas", async () => {
    const almacen = crearAlmacenDelSeed();
    await cargar(almacen);
    const ancla = await leerAnclaDelSeed(almacen.libro.ejecutor);
    expect(ancla?.ancla.toISOString()).toBe(CRUDO.ancla.toISOString());
  });

  it("orden: plataformas → capacidades → títulos → … → ancla, la ÚLTIMA sentencia antes del COMMIT", async () => {
    const almacen = crearAlmacenDelSeed();
    await cargar(almacen);
    const s = almacen.sentencias;
    const i = (patron: string) => s.findIndex((x) => x.includes(patron));
    expect(i("INSERT INTO external_platforms ")).toBeLessThan(
      i("INSERT INTO external_platform_capabilities"),
    );
    expect(i("INSERT INTO external_platform_capabilities")).toBeLessThan(
      i("INSERT INTO external_titles "),
    );
    expect(s.at(-1)).toBe("COMMIT");
    expect(s.at(-2)).toContain("SET checkpoint = $2::jsonb");
    expect(s[0]).toBe("BEGIN");
    expect(s[1]).toContain("AS escritores");
  });

  it("escribe las 30 capacidades del MVP", async () => {
    const almacen = crearAlmacenDelSeed();
    await cargar(almacen);
    expect(almacen.filas("external_platform_capabilities")).toHaveLength(30);
    expect(almacen.filasCanonicas().external_platform_capabilities).toEqual(
      CAPACIDADES_MVP.map((c) => ({
        platform_id: c.platformId,
        country: c.country,
        capability: c.capability,
        status: c.status,
      })),
    );
  });
});

describe("determinista, idempotente y reproducible", () => {
  it("cargar dos veces el mismo crudo: mismo estado, 0 inserciones, ids estables, mismo S", async () => {
    const almacen = crearAlmacenDelSeed();
    await cargar(almacen);
    const antes = huellaDelAlmacen(almacen);
    const ids = almacen.idsDeTitulo();
    const r = await cargar(almacen, {
      ahora: new Date(dentroDelPlazo().getTime() + 60_000),
    });
    expect(r.resultado).toMatchObject({ ejecutado: true, estado: "succeeded" });
    expect(r.decision).toMatchObject({ tipo: "reejecucion" });
    expect(r.informe?.tablas.every((t) => t.insertadas === 0)).toBe(true);
    expect(huellaDelAlmacen(almacen)).toBe(antes);
    expect(almacen.idsDeTitulo()).toEqual(ids);
    const [a, b] = almacen.libro.filas.map(
      (f) => (f.checkpoint as CheckpointDeCarga).ancla,
    );
    expect(b).toBe(a);
    expect(almacen.libro.filas.map((f) => f.requestsMade)).toEqual([0, 0]);
  });

  it("el mismo crudo en dos destinos, cargado en instantes distintos, deja el mismo catálogo", async () => {
    const validacion = crearAlmacenDelSeed();
    const produccion = crearAlmacenDelSeed();
    await cargar(validacion);
    await cargar(produccion, {
      ahora: new Date(CRUDO.ancla.getTime() + 50 * 3_600_000),
    });
    expect(huellaDelAlmacen(produccion)).toBe(huellaDelAlmacen(validacion));
    expect(huellaDelAlmacen(produccion)).toBe(CRUDO.huellaCanonica);
  });
});

describe("una sola transacción", () => {
  it("un fallo a mitad: ROLLBACK completo, ni catálogo ni ancla; se repite y entra", async () => {
    const almacen = crearAlmacenDelSeed();
    almacen.fallarUnaVezEn((t) =>
      t.startsWith("INSERT INTO external_availability_options"),
    );
    const r = await cargar(almacen);
    expect(r.resultado).toMatchObject({ ejecutado: true, estado: "failed" });
    expect(almacen.filas("external_titles")).toHaveLength(0);
    expect(almacen.filas("external_platform_capabilities")).toHaveLength(0);
    expect(await leerAnclaDelSeed(almacen.libro.ejecutor)).toBeNull();
    expect((almacen.libro.filas[0]?.checkpoint as CheckpointDeCarga).estado).toBe(
      "pendiente",
    );
    expect(r.informe).toBeNull();
    expect(almacen.libro.filas[0]?.rowsAffected).toBeNull();

    const otra = await cargar(almacen);
    expect(otra.resultado).toMatchObject({ ejecutado: true, estado: "succeeded" });
    expect(otra.decision).toEqual({ tipo: "virgen" });
  });
});

describe("las negativas, con 0 escrituras", () => {
  it("ancla_caducada en S + 72 h exactos: ni transacción", async () => {
    const almacen = crearAlmacenDelSeed();
    const r = await cargar(almacen, {
      ahora: new Date(CRUDO.ancla.getTime() + PLAZO_DEL_ANCLA_MS),
    });
    expect(r.resultado).toMatchObject({ ejecutado: true, estado: "failed" });
    if (!r.resultado.ejecutado) return;
    expect(r.resultado.metricas.errorSamples[0]?.motivo).toBe("ancla_caducada");
    expect(almacen.sentencias).toEqual([]);
    expect(codigoDeSalidaDeLaCarga(r.resultado)).toBe(1);
  });

  it("un segundo antes del vencimiento, todavía entra", async () => {
    const almacen = crearAlmacenDelSeed();
    const r = await cargar(almacen, {
      ahora: new Date(CRUDO.ancla.getTime() + PLAZO_DEL_ANCLA_MS - 1000),
    });
    expect(r.resultado).toMatchObject({ estado: "succeeded" });
  });

  it("seed_distinto: el destino ya se cargó con otro crudo", async () => {
    const almacen = crearAlmacenDelSeed();
    await cargar(almacen, {
      crudo: OTRO,
      ahora: new Date(OTRO.ancla.getTime() + 3_600_000),
    });
    const antes = huellaDelAlmacen(almacen);
    const r = await cargar(almacen);
    expect(r.resultado).toMatchObject({ estado: "failed" });
    if (!r.resultado.ejecutado) return;
    expect(r.resultado.metricas.errorSamples[0]?.motivo).toBe("seed_distinto");
    expect(huellaDelAlmacen(almacen)).toBe(antes);
  });

  it("catalogo_ya_mantenido: después de un deltas, el seed no vuelve a escribir", async () => {
    const almacen = crearAlmacenDelSeed();
    await cargar(almacen);
    almacen.libro.sembrarFila({ pipeline: "deltas", status: "succeeded" });
    const r = await cargar(almacen);
    if (!r.resultado.ejecutado) throw new Error("tenía que ejecutarse");
    expect(r.resultado.metricas.errorSamples[0]?.motivo).toBe("catalogo_ya_mantenido");
  });

  it("destino_no_virgen: catálogo sin ancla", async () => {
    const almacen = crearAlmacenDelSeed();
    await ejecutarSeed(almacen.ejecutor, OTRO.filas);
    const r = await cargar(almacen);
    if (!r.resultado.ejecutado) throw new Error("tenía que ejecutarse");
    expect(r.resultado.metricas.errorSamples[0]?.motivo).toBe("destino_no_virgen");
  });

  it("crudo_no_cargable: una captura failed se verifica pero no se carga", async () => {
    expect(FALLIDO.cargable).toBe(false);
    const almacen = crearAlmacenDelSeed();
    const r = await cargar(almacen, {
      crudo: FALLIDO,
      ahora: new Date(FALLIDO.ancla.getTime() + 3_600_000),
    });
    if (!r.resultado.ejecutado) throw new Error("tenía que ejecutarse");
    expect(r.resultado.metricas.errorSamples[0]?.motivo).toBe("crudo_no_cargable");
    expect(almacen.sentencias).toEqual([]);
  });

  it("decidirCarga, pura", () => {
    const vacio = { titulos: 0, ofertas: 0, eventos: 0, anuncios: 0, escritores: 0 };
    expect(decidirCarga(vacio, null, "h")).toEqual({ tipo: "virgen" });
    expect(decidirCarga({ ...vacio, eventos: 1 }, null, "h")).toMatchObject({
      motivo: "catalogo_ya_mantenido",
    });
    expect(decidirCarga({ ...vacio, titulos: 3 }, null, "h")).toMatchObject({
      motivo: "destino_no_virgen",
    });
  });
});

describe("locks y salida de la carga", () => {
  it("toma A y después C; libera C y después A", async () => {
    const almacen = crearAlmacenDelSeed();
    const locks: string[] = [];
    const ops: EjecutorSql = {
      ejecutar(texto, valores = []) {
        const m = /pg_(try_advisory_lock|advisory_unlock)/.exec(texto);
        if (m !== null)
          locks.push(`${m[1] === "advisory_unlock" ? "-" : "+"}${String(valores[0])}`);
        return almacen.libro.ejecutor.ejecutar(texto, valores);
      },
    };
    await cargar(almacen, { ejecutorOps: ops });
    expect(locks).toEqual([
      `+${String(NS_PIPELINE)}`,
      `+${String(NS_CATALOGO)}`,
      `-${String(NS_CATALOGO)}`,
      `-${String(NS_PIPELINE)}`,
    ]);
  });

  it("lock ocupado: exit 2, sin fila ni escrituras", async () => {
    const almacen = crearAlmacenDelSeed();
    const libro = crearLibroEnMemoria();
    const ocupado: EjecutorSql = {
      ejecutar(texto, valores = []) {
        if (texto.includes("pg_try_advisory_lock"))
          return Promise.resolve([{ tomado: false }] as never);
        return libro.ejecutor.ejecutar(texto, valores);
      },
    };
    const r = await cargar(almacen, { ejecutorOps: ocupado });
    expect(r.resultado).toEqual({ ejecutado: false, motivo: "ya_hay_una_viva" });
    expect(codigoDeSalidaDeLaCarga(r.resultado)).toBe(2);
    expect(almacen.sentencias).toEqual([]);
  });

  it("succeeded → exit 0", async () => {
    const r = await cargar(crearAlmacenDelSeed());
    expect(codigoDeSalidaDeLaCarga(r.resultado)).toBe(0);
  });
});

describe("nunca se carga media ronda", () => {
  it("budget_stopped a mitad de ronda: crudo_no_cargable (ronda_incompleta), 0 escrituras", async () => {
    expect(MEDIA_RONDA.cierre).toMatchObject({
      estado: "budget_stopped",
      rondaCompleta: false,
    });
    const almacen = crearAlmacenDelSeed();
    const r = await cargar(almacen, {
      crudo: MEDIA_RONDA,
      ahora: new Date(MEDIA_RONDA.ancla.getTime() + 3_600_000),
    });
    if (!r.resultado.ejecutado) throw new Error("tenía que ejecutarse");
    expect(r.resultado.metricas.errorSamples[0]).toMatchObject({
      motivo: "crudo_no_cargable",
      razon: "ronda_incompleta",
    });
    expect(almacen.sentencias).toEqual([]);
  });

  it("aunque alguien marque el crudo como cargable, el cierre manda", async () => {
    const trucado: CrudoVerificado = {
      ...MEDIA_RONDA,
      cargable: true,
      motivoNoCargable: null,
    };
    const almacen = crearAlmacenDelSeed();
    const r = await cargar(almacen, {
      crudo: trucado,
      ahora: new Date(MEDIA_RONDA.ancla.getTime() + 3_600_000),
    });
    if (!r.resultado.ejecutado) throw new Error("tenía que ejecutarse");
    expect(r.resultado.metricas.errorSamples[0]?.motivo).toBe("crudo_no_cargable");
    expect(almacen.filas("external_titles")).toHaveLength(0);
  });

  it("budget_stopped en una frontera de ronda: se carga, con menos títulos que el objetivo", async () => {
    const almacen = crearAlmacenDelSeed();
    const r = await cargar(almacen, {
      crudo: FRONTERA,
      ahora: new Date(FRONTERA.ancla.getTime() + 3_600_000),
    });
    expect(r.resultado).toMatchObject({ ejecutado: true, estado: "succeeded" });
    expect(almacen.filas("external_titles")).toHaveLength(4);
    expect(huellaDelAlmacen(almacen)).toBe(FRONTERA.huellaCanonica);
  });
});

describe("capturaRunIds como texto decimal", () => {
  it("el checkpoint de la carga los guarda como strings", async () => {
    const almacen = crearAlmacenDelSeed();
    await cargar(almacen);
    const cp = almacen.libro.filas[0]?.checkpoint as CheckpointDeCarga;
    expect(cp.capturaRunIds).toEqual(CRUDO.cierre.filasDeOps);
    expect(cp.capturaRunIds.every((id) => typeof id === "string")).toBe(true);
  });

  it("un id mayor que Number.MAX_SAFE_INTEGER llega exacto al checkpoint y al ancla", async () => {
    const almacen = crearAlmacenDelSeed();
    const r = await cargar(almacen, {
      crudo: ID_GRANDE,
      ahora: new Date(ID_GRANDE.ancla.getTime() + 3_600_000),
    });
    expect(r.resultado).toMatchObject({ ejecutado: true, estado: "succeeded" });
    const cp = almacen.libro.filas[0]?.checkpoint as CheckpointDeCarga;
    expect(cp.capturaRunIds).toEqual([GRANDE]);
    // Tal cual viaja a jsonb: como texto, sin redondeo.
    expect(JSON.stringify(cp)).toContain(`"capturaRunIds":["${GRANDE}"]`);
    const ancla = await leerAnclaDelSeed(almacen.libro.ejecutor);
    expect(ancla?.checkpoint.capturaRunIds).toEqual([GRANDE]);
  });
});
