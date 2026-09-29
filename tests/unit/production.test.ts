/**
 * **El bloque de `production`** (ADR 0010), sin red y sin base:
 *
 *   · sus guardas de entorno, con variables propias que no conviven con las de
 *     validación;
 *   · la autorización en código, **vacía**, y atada a lo que autoriza;
 *   · la compuerta del crudo: aceptación en validación y **M4 recalculado**, de
 *     modo que un crudo refutado nunca pasa;
 *   · la decisión de la migración (virgen · exacta · negada);
 *   · la congelación de la rama histórica en el ciclo de la captura.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DESTINO_PRODUCTION,
  VARIABLES_DE_PRODUCTION,
  verificarDestinoDeProduction,
} from "../../destino-production.ts";
import type { AutorizacionDelSeed } from "../../jobs/ops/autorizacion-del-seed.ts";
import { AUTORIZACIONES_DEL_SEED } from "../../jobs/ops/autorizacion-del-seed.ts";
import type { AutorizacionDeProduction } from "../../jobs/ops/autorizacion-de-production.ts";
import {
  AUTORIZACIONES_DE_PRODUCTION,
  exigirAutorizacionDeProduction,
  validarAutorizacionesDeProduction,
} from "../../jobs/ops/autorizacion-de-production.ts";
import {
  congelacionDelDestino,
  regimenDelDestino,
} from "../../jobs/pipelines/arranque.ts";
import type {
  EntradaDeLaCompuerta,
  ReciboDeAceptacion,
} from "../../jobs/pipelines/seed/compuerta-production.ts";
import { evaluarCompuertaDeProduction } from "../../jobs/pipelines/seed/compuerta-production.ts";
import { escribirCrudo } from "../../jobs/pipelines/seed/crudo/disco.ts";
import { verificarCrudo } from "../../jobs/pipelines/seed/crudo/verificar.ts";
import type { EstadoParaMigrar } from "../../scripts/migracion-destino.ts";
import {
  decidirMigracion,
  migracionesLocales,
} from "../../scripts/migracion-destino.ts";
import {
  RAMA_DE_ACEPTACION,
  compuertaDesdeDisco,
  escribirReciboDeAceptacion,
  rutaDelM4,
} from "../../scripts/production-comun.ts";
import { TABLAS_V1, exigirCrudoParaRama } from "../../scripts/seed-comun.ts";
import { capturar, fijarReloj } from "./ayudas-seed.ts";
import { PAGINAS_BASE } from "./ayudas-seed-fixtures.ts";

const HOST = "ep-produccion-999.eu-central-1.aws.neon.tech";
const URL_PROD = `postgresql://dueno:secreto@${HOST}/neondb?sslmode=require`;
const HUELLA = "a".repeat(64);
const OTRA = "b".repeat(64);

function entornoProd(extra: Record<string, string | undefined> = {}) {
  return {
    PRODUCTION_DATABASE_URL_DIRECT: URL_PROD,
    NEON_PRODUCTION_HOST: HOST,
    PRODUCTION_TARGET: "production",
    ...extra,
  };
}

// ── Guardas de entorno ──────────────────────────────────────────────────────

describe("verificarDestinoDeProduction", () => {
  it("con sus tres variables exactas, alcanza production por conexión directa", () => {
    expect(verificarDestinoDeProduction(entornoProd())).toEqual({
      url: URL_PROD,
      hostname: HOST,
      esConexionDirecta: true,
      rama: DESTINO_PRODUCTION,
    });
  });

  it("se niega si la sesión lleva CUALQUIER variable de validación", () => {
    for (const v of [
      "DATABASE_URL_DIRECT",
      "NEON_VALIDATION_HOST",
      "MIGRATION_TARGET",
    ]) {
      expect(() => verificarDestinoDeProduction(entornoProd({ [v]: "x" })), v).toThrow(
        /variables de validación/,
      );
    }
    // Vacía o en blanco no cuenta como definida.
    expect(() =>
      verificarDestinoDeProduction(entornoProd({ MIGRATION_TARGET: "  " })),
    ).not.toThrow();
  });

  it("exige la URL, que sea URL, directa y con el hostname exacto", () => {
    expect(() =>
      verificarDestinoDeProduction(entornoProd({ PRODUCTION_DATABASE_URL_DIRECT: "" })),
    ).toThrow(/Falta PRODUCTION_DATABASE_URL_DIRECT/);
    expect(() =>
      verificarDestinoDeProduction(
        entornoProd({ PRODUCTION_DATABASE_URL_DIRECT: "no es una url" }),
      ),
    ).toThrow(/no es una URL/);
    const pooler = HOST.replace("ep-produccion-999", "ep-produccion-999-pooler");
    expect(() =>
      verificarDestinoDeProduction(
        entornoProd({
          PRODUCTION_DATABASE_URL_DIRECT: URL_PROD.replace(HOST, pooler),
          NEON_PRODUCTION_HOST: pooler,
        }),
      ),
    ).toThrow(/pooler/);
    expect(() =>
      verificarDestinoDeProduction(
        entornoProd({ NEON_PRODUCTION_HOST: "ep-otra.neon.tech" }),
      ),
    ).toThrow(/hostname/);
    expect(() =>
      verificarDestinoDeProduction(entornoProd({ NEON_PRODUCTION_HOST: "" })),
    ).toThrow(/Falta NEON_PRODUCTION_HOST/);
  });

  it("PRODUCTION_TARGET tiene que valer exactamente production", () => {
    for (const valor of [undefined, "", "Production", "production ", "prod", "main"]) {
      expect(
        () => verificarDestinoDeProduction(entornoProd({ PRODUCTION_TARGET: valor })),
        String(valor),
      ).toThrow(/PRODUCTION_TARGET/);
    }
  });

  it("nunca imprime la cadena de conexión ni la contraseña", () => {
    for (const extra of [
      { NEON_PRODUCTION_HOST: "otro" },
      { PRODUCTION_TARGET: "x" },
      { MIGRATION_TARGET: "x" },
    ]) {
      try {
        verificarDestinoDeProduction(entornoProd(extra));
      } catch (error) {
        expect(String(error)).not.toContain("secreto");
        expect(String(error)).not.toContain(URL_PROD);
      }
    }
  });

  it("production no es un destino de validación ni tiene régimen histórico", () => {
    expect(regimenDelDestino(DESTINO_PRODUCTION)).toBe("bootstrap_del_seed");
    expect(VARIABLES_DE_PRODUCTION).toEqual([
      "PRODUCTION_DATABASE_URL_DIRECT",
      "NEON_PRODUCTION_HOST",
      "PRODUCTION_TARGET",
    ]);
  });

  it("un crudo de ensayo nunca va a production; uno real, sí (tras la compuerta)", () => {
    expect(() => exigirCrudoParaRama(true, DESTINO_PRODUCTION)).toThrow(/ensayo/);
    expect(() => exigirCrudoParaRama(false, DESTINO_PRODUCTION)).not.toThrow();
  });
});

// ── Autorización en código ──────────────────────────────────────────────────

describe("AUTORIZACIONES_DE_PRODUCTION", () => {
  const migrar: AutorizacionDeProduction = {
    operacion: "migrar",
    hastaMigracion: "0004_imdb_id_no_vacio",
    aprobadaEl: "2026-10-01",
    referencia: "prueba",
  };
  const cargar: AutorizacionDeProduction = {
    operacion: "cargar",
    huellaDelCrudo: HUELLA,
    aprobadaEl: "2026-10-01",
    referencia: "prueba",
  };

  it("el repositorio solo autoriza migrar production hasta 0004 (2026-09-27)", () => {
    expect(
      AUTORIZACIONES_DE_PRODUCTION.map((a) => [a.operacion, a.hastaMigracion]),
    ).toEqual([["migrar", "0004_imdb_id_no_vacio"]]);
    expect(
      exigirAutorizacionDeProduction({
        operacion: "migrar",
        hastaMigracion: "0004_imdb_id_no_vacio",
      }).aprobadaEl,
    ).toBe("2026-09-27");
    expect(() =>
      exigirAutorizacionDeProduction({
        operacion: "migrar",
        hastaMigracion: "0005_futura",
      }),
    ).toThrow(/no está autorizado/);
    for (const operacion of ["cargar", "primer_deltas"] as const) {
      expect(() =>
        exigirAutorizacionDeProduction({ operacion, huellaDelCrudo: HUELLA }),
      ).toThrow(/no está autorizado/);
    }
  });

  it("migrar se ata a la última migración: una 0005 no queda cubierta", () => {
    const lista = [migrar];
    expect(
      exigirAutorizacionDeProduction(
        { operacion: "migrar", hastaMigracion: "0004_imdb_id_no_vacio" },
        lista,
      ),
    ).toBe(migrar);
    expect(() =>
      exigirAutorizacionDeProduction(
        { operacion: "migrar", hastaMigracion: "0005_otra" },
        lista,
      ),
    ).toThrow(/no está autorizado/);
  });

  it("cargar se ata a la huella del crudo, y no vale para primer_deltas", () => {
    const lista = [cargar];
    expect(
      exigirAutorizacionDeProduction(
        { operacion: "cargar", huellaDelCrudo: HUELLA },
        lista,
      ),
    ).toBe(cargar);
    expect(() =>
      exigirAutorizacionDeProduction(
        { operacion: "cargar", huellaDelCrudo: OTRA },
        lista,
      ),
    ).toThrow();
    expect(() =>
      exigirAutorizacionDeProduction(
        { operacion: "primer_deltas", huellaDelCrudo: HUELLA },
        lista,
      ),
    ).toThrow();
  });

  it("una lista incoherente niega todo (fail closed)", () => {
    const malas: AutorizacionDeProduction[] = [
      { ...cargar, huellaDelCrudo: "corta" },
      { operacion: "cargar", aprobadaEl: "2026-10-01", referencia: "prueba" },
      { operacion: "migrar", aprobadaEl: "2026-10-01", referencia: "prueba" },
      { ...migrar, huellaDelCrudo: HUELLA },
      { ...cargar, hastaMigracion: "0004_imdb_id_no_vacio" },
      { ...cargar, referencia: " " },
      { ...cargar, operacion: "borrar" as unknown as "cargar" },
    ];
    for (const mala of malas) {
      expect(
        () => validarAutorizacionesDeProduction([mala]),
        JSON.stringify(mala),
      ).toThrow();
      expect(() =>
        exigirAutorizacionDeProduction(
          { operacion: "cargar", huellaDelCrudo: HUELLA },
          [cargar, mala],
        ),
      ).toThrow();
    }
  });
});

// ── La compuerta ─────────────────────────────────────────────────────────────

const S = new Date("2026-10-05T08:00:00.000Z");

function recibo(parcial: Partial<ReciboDeAceptacion> = {}): ReciboDeAceptacion {
  return {
    formato: "mirada-larga.seed.aceptacion",
    v: 1,
    capturaId: "seed-es-202610",
    huella: HUELLA,
    ancla: S.toISOString(),
    rama: RAMA_DE_ACEPTACION,
    carga: { huellaCanonicaLeida: "c".repeat(64), anclaRunId: "9", validadaEl: "x" },
    primerDeltas: {
      bootstrapRunId: "10",
      primerFrom: S.toISOString(),
      addedSobreOfertasDelSeed: 0,
      validadoEl: "x",
    },
    ...parcial,
  };
}

function entrada(parcial: Partial<EntradaDeLaCompuerta> = {}): EntradaDeLaCompuerta {
  return {
    crudo: {
      huella: HUELLA,
      huellaCanonica: "c".repeat(64),
      capturaId: "seed-es-202610",
      ancla: S,
      esEnsayo: false,
    },
    ramaDeAceptacion: RAMA_DE_ACEPTACION,
    aceptacion: recibo(),
    m4Guardado: {
      capturaId: "seed-es-202610",
      huellaDelCrudo: HUELLA,
      deltas: ["2026-10-05T10-00-00-000Z-primer-deltas"],
      resultado: "sin_muestras",
      permiteProduction: true,
      muestras: 0,
      retrasoMaximoObservadoSegundos: null,
    },
    m4Recalculado: {
      resultado: "sin_muestras",
      muestras: 0,
      retrasoMaximoObservadoSegundos: null,
    },
    ...parcial,
  };
}

describe("evaluarCompuertaDeProduction", () => {
  it("aceptado en validación y M4 no refutado (recalculado igual): abierta", () => {
    expect(evaluarCompuertaDeProduction(entrada())).toEqual({
      ok: true,
      problemas: [],
    });
    const compatible = {
      resultado: "compatible" as const,
      muestras: 2,
      retrasoMaximoObservadoSegundos: 40,
    };
    const e = entrada();
    expect(
      evaluarCompuertaDeProduction({
        ...e,
        m4Guardado: e.m4Guardado === null ? null : { ...e.m4Guardado, ...compatible },
        m4Recalculado: compatible,
      }).ok,
    ).toBe(true);
  });

  it("⛔ M4 refutado nunca pasa: ni guardado, ni recalculado, ni los dos", () => {
    const refutado = {
      resultado: "refutado" as const,
      muestras: 1,
      retrasoMaximoObservadoSegundos: 4000,
    };
    const e = entrada();
    const guardado = e.m4Guardado;
    if (guardado === null) throw new Error("fixture");
    for (const caso of [
      { m4Guardado: { ...guardado, ...refutado, permiteProduction: false } },
      { m4Recalculado: refutado },
      {
        m4Guardado: { ...guardado, ...refutado, permiteProduction: false },
        m4Recalculado: refutado,
      },
    ]) {
      const r = evaluarCompuertaDeProduction({ ...e, ...caso });
      expect(r.ok).toBe(false);
      expect(r.problemas.join()).toMatch(/REFUTA/);
    }
  });

  it("no se fía del informe guardado: si el recalculado difiere, cerrada", () => {
    const e = entrada();
    const r = evaluarCompuertaDeProduction({
      ...e,
      m4Recalculado: {
        resultado: "compatible",
        muestras: 3,
        retrasoMaximoObservadoSegundos: 10,
      },
    });
    expect(r.ok).toBe(false);
    expect(r.problemas.join()).toMatch(/no coincide con el recalculado/);
  });

  it("sin M4, sin recálculo o sin aceptación: cerrada", () => {
    expect(evaluarCompuertaDeProduction(entrada({ m4Guardado: null })).ok).toBe(false);
    expect(evaluarCompuertaDeProduction(entrada({ m4Recalculado: null })).ok).toBe(
      false,
    );
    expect(evaluarCompuertaDeProduction(entrada({ aceptacion: null })).ok).toBe(false);
  });

  it("la aceptación tiene que ser de ESTE crudo, de la rama del seed real y completa", () => {
    const casos: Partial<ReciboDeAceptacion>[] = [
      { huella: OTRA },
      { capturaId: "seed-es-202611" },
      { ancla: new Date(S.getTime() + 1000).toISOString() },
      { rama: "seed-bootstrap-v1-test" },
      {
        carga: {
          huellaCanonicaLeida: "d".repeat(64),
          anclaRunId: "9",
          validadaEl: "x",
        },
      },
      { primerDeltas: null },
      {
        primerDeltas: {
          bootstrapRunId: "10",
          primerFrom: new Date(S.getTime() + 1000).toISOString(),
          addedSobreOfertasDelSeed: 0,
          validadoEl: "x",
        },
      },
      {
        primerDeltas: {
          bootstrapRunId: "10",
          primerFrom: S.toISOString(),
          addedSobreOfertasDelSeed: 1,
          validadoEl: "x",
        },
      },
    ];
    for (const caso of casos) {
      expect(
        evaluarCompuertaDeProduction(entrada({ aceptacion: recibo(caso) })).ok,
        JSON.stringify(caso),
      ).toBe(false);
    }
  });

  it("un crudo de ensayo o un M4 de otro crudo: cerrada", () => {
    const e = entrada();
    expect(
      evaluarCompuertaDeProduction({ ...e, crudo: { ...e.crudo, esEnsayo: true } }).ok,
    ).toBe(false);
    const guardado = e.m4Guardado;
    if (guardado === null) throw new Error("fixture");
    expect(
      evaluarCompuertaDeProduction({
        ...e,
        m4Guardado: { ...guardado, huellaDelCrudo: OTRA },
      }).ok,
    ).toBe(false);
  });
});

// ── La compuerta desde disco: M4 se RECALCULA ────────────────────────────────

describe("compuertaDesdeDisco", () => {
  let raiz: string;
  beforeEach(() => {
    raiz = mkdtempSync(join(tmpdir(), "compuerta-"));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(raiz, { recursive: true, force: true });
  });

  async function preparar() {
    fijarReloj();
    const c = await capturar({ paginas: PAGINAS_BASE });
    vi.useRealTimers();
    const dir = join(raiz, "seeds", "seed-es-prueba");
    escribirCrudo(dir, c.contenido);
    const v = verificarCrudo(c.contenido);
    if (v.crudo === null) throw new Error("no verifica");
    // Un primer deltas con una página real de /changes (fila 21).
    const deltas = join(raiz, "deltas", "2026-11-03T11-30-00-000Z-primer-deltas");
    mkdirSync(deltas, { recursive: true });
    const fixture = JSON.parse(
      readFileSync(
        join(
          import.meta.dirname,
          "../fixtures/changes/deltas-fila21-new-solapados.json",
        ),
        "utf8",
      ),
    ) as { body?: unknown };
    writeFileSync(join(deltas, "r1.json"), JSON.stringify(fixture.body ?? fixture));
    writeFileSync(
      join(deltas, "manifiesto.json"),
      JSON.stringify({
        pipeline: "deltas",
        ventana: {},
        respuestas: [{ fichero: "r1.json", status: 200 }],
      }),
    );
    return { dir, crudo: v.crudo, deltas };
  }

  it("sin recibo ni M4: cerrada", async () => {
    const { dir, crudo } = await preparar();
    const r = compuertaDesdeDisco(dir, crudo, join(raiz, "deltas"));
    expect(r.ok).toBe(false);
    expect(r.problemas.join()).toMatch(/sin recibo de aceptación/);
    expect(r.problemas.join()).toMatch(/sin informe de M4/);
  });

  it("recibo + M4 guardado que coincide con el recalculado y no refuta: abierta", async () => {
    const { dir, crudo, deltas } = await preparar();
    const r0 = compuertaDesdeDisco(dir, crudo, join(raiz, "deltas"));
    expect(r0.ok).toBe(false);
    // Recalcular primero para escribir un informe honesto.
    const { m4DesdeDisco } = await import("../../scripts/m4-desde-disco.ts");
    const informe = m4DesdeDisco(dir, [deltas]).informe;
    writeFileSync(
      rutaDelM4(dir),
      JSON.stringify({
        capturaId: crudo.plan.capturaId,
        huellaDelCrudo: crudo.huella,
        deltas: [basename(deltas)],
        permiteProduction: informe.resultado !== "refutado",
        ...informe,
      }),
    );
    escribirReciboDeAceptacion(dir, {
      formato: "mirada-larga.seed.aceptacion",
      v: 1,
      capturaId: crudo.plan.capturaId,
      huella: crudo.huella,
      ancla: crudo.ancla.toISOString(),
      rama: RAMA_DE_ACEPTACION,
      carga: {
        huellaCanonicaLeida: crudo.huellaCanonica,
        anclaRunId: "7",
        validadaEl: "x",
      },
      primerDeltas: {
        bootstrapRunId: "9",
        primerFrom: crudo.ancla.toISOString(),
        addedSobreOfertasDelSeed: 0,
        validadoEl: "x",
      },
    });
    const r = compuertaDesdeDisco(dir, crudo, join(raiz, "deltas"));
    expect(informe.resultado).not.toBe("refutado");
    expect(r).toMatchObject({ ok: true, problemas: [] });

    // Un informe editado a mano (resultado cambiado) ya no coincide: cerrada.
    const editado = JSON.parse(readFileSync(rutaDelM4(dir), "utf8")) as Record<
      string,
      unknown
    >;
    writeFileSync(
      rutaDelM4(dir),
      JSON.stringify({
        ...editado,
        resultado: informe.resultado === "compatible" ? "sin_muestras" : "compatible",
        muestras: 99,
      }),
    );
    expect(compuertaDesdeDisco(dir, crudo, join(raiz, "deltas")).ok).toBe(false);

    // Sin los crudos del primer deltas, M4 no se puede recalcular: cerrada.
    writeFileSync(rutaDelM4(dir), JSON.stringify(editado));
    rmSync(deltas, { recursive: true, force: true });
    const sinDeltas = compuertaDesdeDisco(dir, crudo, join(raiz, "deltas"));
    expect(sinDeltas.ok).toBe(false);
    expect(sinDeltas.problemas.join()).toMatch(/recálculo de M4/);
  });

  it("un recibo mal formado cierra, no lanza", async () => {
    const { dir, crudo } = await preparar();
    writeFileSync(rutaDelM4(dir), JSON.stringify({ deltas: [] }));
    writeFileSync(join(raiz, "seeds", "seed-es-prueba.aceptacion.json"), "{");
    const r = compuertaDesdeDisco(dir, crudo, join(raiz, "deltas"));
    expect(r.ok).toBe(false);
  });
});

// ── La decisión de la migración ──────────────────────────────────────────────

describe("decidirMigracion", () => {
  const locales = migracionesLocales();
  const exactas = locales.map((m) => ({ hash: m.hash, createdAt: m.when }));
  const estado = (e: Partial<EstadoParaMigrar>): EstadoParaMigrar => ({
    tablasPublicas: [],
    aplicadas: [],
    ...e,
  });

  it("las migraciones locales son exactamente 0000–0004", () => {
    expect(locales.map((m) => m.tag.slice(0, 4))).toEqual([
      "0000",
      "0001",
      "0002",
      "0003",
      "0004",
    ]);
  });

  it("virgen (vacía, o solo con spike_ping de production): aplica las cinco", () => {
    for (const tablas of [[], ["spike_ping"]]) {
      expect(decidirMigracion(estado({ tablasPublicas: tablas }), locales)).toEqual({
        tipo: "aplicar",
        pendientes: locales.map((m) => m.tag),
      });
    }
  });

  it("exactamente 0000–0004 con las 15 tablas: nada que hacer (idempotente)", () => {
    expect(
      decidirMigracion(
        estado({ tablasPublicas: [...TABLAS_V1, "spike_ping"], aplicadas: exactas }),
        locales,
      ),
    ).toEqual({ tipo: "nada" });
  });

  it("todo lo demás se niega sin escribir", () => {
    const casos: EstadoParaMigrar[] = [
      estado({ tablasPublicas: ["spike_ping", "otra_tabla"] }),
      estado({ tablasPublicas: [...TABLAS_V1], aplicadas: exactas.slice(0, 3) }),
      estado({
        tablasPublicas: [...TABLAS_V1],
        aplicadas: exactas.map((a, i) => (i === 2 ? { ...a, hash: "x" } : a)),
      }),
      estado({
        tablasPublicas: [...TABLAS_V1],
        aplicadas: exactas.map((a, i) => (i === 4 ? { ...a, createdAt: 1 } : a)),
      }),
      estado({
        tablasPublicas: [...TABLAS_V1],
        aplicadas: [...exactas, { hash: "y", createdAt: 9 }],
      }),
      estado({ tablasPublicas: ["spike_ping"], aplicadas: exactas }),
    ];
    for (const c of casos) {
      expect(decidirMigracion(c, locales).tipo, JSON.stringify(c).slice(0, 120)).toBe(
        "negada",
      );
    }
  });
});

// ── La rama histórica, congelada en el ciclo de la captura ───────────────────

describe("congelacionDelDestino", () => {
  const captura: AutorizacionDelSeed = {
    ciclo: 202610,
    fase: "captura",
    tope: 450,
    techo: 450,
    aprobadaEl: "2026-10-01",
    referencia: "prueba",
  };
  const octubre = new Date("2026-10-05T04:37:00Z");

  it("la captura de 202610 del repositorio congela la histórica en octubre, y solo en octubre", () => {
    expect(
      AUTORIZACIONES_DEL_SEED.filter((a) => a.fase === "captura").map((a) => a.ciclo),
    ).toEqual([202610]);
    // Septiembre sigue operando: deltas 28–30 y expiring el lunes 28.
    for (const d of [
      "2026-09-28T04:37:00Z",
      "2026-09-28T05:17:00Z",
      "2026-09-30T04:37:00Z",
      "2026-09-30T23:59:59Z",
      "2026-11-01T04:37:00Z",
    ]) {
      expect(
        congelacionDelDestino("drizzle-schema-v1-test", new Date(d), 1),
        d,
      ).toBeNull();
    }
    // Primer cron del ciclo (deltas 04:37 del jueves 1), upcoming ese jueves, expiring el lunes 5.
    for (const d of [
      "2026-10-01T00:00:00Z",
      "2026-10-01T04:37:00Z",
      "2026-10-01T05:17:00Z",
      "2026-10-05T05:17:00Z",
      "2026-10-31T23:59:59Z",
    ]) {
      expect(
        congelacionDelDestino("drizzle-schema-v1-test", new Date(d), 1)?.ciclo,
        d,
      ).toBe(202610);
    }
  });

  it("con la captura autorizada, la histórica queda congelada todo ese ciclo, y solo ese", () => {
    const lista = [captura];
    expect(congelacionDelDestino("drizzle-schema-v1-test", octubre, 1, lista)).toBe(
      captura,
    );
    expect(
      congelacionDelDestino(
        "drizzle-schema-v1-test",
        new Date("2026-10-01T00:00:00Z"),
        1,
        lista,
      ),
    ).toBe(captura);
    expect(
      congelacionDelDestino(
        "drizzle-schema-v1-test",
        new Date("2026-09-30T23:59:59Z"),
        1,
        lista,
      ),
    ).toBeNull();
    expect(
      congelacionDelDestino(
        "drizzle-schema-v1-test",
        new Date("2026-11-01T00:00:00Z"),
        1,
        lista,
      ),
    ).toBeNull();
  });

  it("un día de ciclo local distinto no abre un hueco: congela con el suyo y con el del repositorio", () => {
    const lista = [captura];
    // Con STREAMING_API_BUDGET_CYCLE_DAY=2 el 1 de octubre aún sería 202609.
    const primero = new Date("2026-10-01T04:37:00Z");
    expect(congelacionDelDestino("drizzle-schema-v1-test", primero, 2, lista)).toBe(
      captura,
    );
    expect(
      congelacionDelDestino(
        "drizzle-schema-v1-test",
        new Date("2026-11-01T12:00:00Z"),
        2,
        lista,
      ),
    ).toBe(captura);
    expect(
      congelacionDelDestino(
        "drizzle-schema-v1-test",
        new Date("2026-09-30T23:59:59Z"),
        2,
        lista,
      ),
    ).toBeNull();
  });

  it("nunca congela las ramas del seed ni production", () => {
    const lista = [captura];
    for (const rama of ["seed-real-v1-test", "seed-bootstrap-v1-test", "production"]) {
      expect(congelacionDelDestino(rama, octubre, 1, lista)).toBeNull();
    }
  });

  it("pnpm job y los scripts manuales comprueban la congelación antes de conectar", () => {
    const raizRepo = join(import.meta.dirname, "../..");
    const registro = readFileSync(join(raizRepo, "jobs/registro.ts"), "utf8");
    expect(registro.indexOf("congelacionDelDestino(")).toBeGreaterThan(-1);
    expect(registro.indexOf("congelacionDelDestino(")).toBeLessThan(
      registro.indexOf("await ejecutar({ entorno, destino, conectar })"),
    );
    const manual = readFileSync(join(raizRepo, "scripts/manual-comun.ts"), "utf8");
    expect(manual.indexOf("congelacionDelDestino(")).toBeGreaterThan(-1);
    expect(manual.indexOf("congelacionDelDestino(")).toBeLessThan(
      manual.indexOf("return destino.url;"),
    );
    const cambios = readFileSync(
      join(raizRepo, "scripts/validate-changes-live.ts"),
      "utf8",
    );
    expect(cambios.indexOf("congelacionDelDestino(")).toBeGreaterThan(-1);
    expect(cambios.indexOf("congelacionDelDestino(")).toBeLessThan(
      cambios.indexOf("await cliente.connect()"),
    );
  });
});
