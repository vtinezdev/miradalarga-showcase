/**
 * `seed:verificar` (ADR 0009 §4): **0 API, sin base de datos**. Integridad,
 * formatos, coherencia plan ↔ manifiesto ↔ páginas, rondas, cursores,
 * instantes, ancla y huellas.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { ContenidoDelCrudo } from "../../jobs/pipelines/seed/crudo/disco.ts";
import {
  escribirCrudo,
  leerDirectorioDelCrudo,
} from "../../jobs/pipelines/seed/crudo/disco.ts";
import {
  FICHERO_DE_SUMAS,
  FICHERO_DEL_MANIFIESTO,
  FICHERO_DEL_PLAN,
  cicloSiguiente,
  planV1,
} from "../../jobs/pipelines/seed/crudo/formato.ts";
import {
  construirSumas,
  jsonCanonico,
  leerSumas,
  sha256,
} from "../../jobs/pipelines/seed/crudo/huella.ts";
import type { CodigoDeProblema } from "../../jobs/pipelines/seed/crudo/verificar.ts";
import {
  describirVerificacion,
  verificarCrudo,
} from "../../jobs/pipelines/seed/crudo/verificar.ts";
import {
  capturar,
  crearPlan,
  fijarReloj,
  reempaquetar,
  resellar,
} from "./ayudas-seed.ts";
import { PAGINAS_BASE } from "./ayudas-seed-fixtures.ts";

let CRUDO: ContenidoDelCrudo;

beforeAll(async () => {
  fijarReloj();
  CRUDO = (await capturar({ paginas: PAGINAS_BASE })).contenido;
  vi.useRealTimers();
});
afterEach(() => vi.useRealTimers());

const codigos = (c: ContenidoDelCrudo): readonly CodigoDeProblema[] =>
  verificarCrudo(c).problemas.map((p) => p.codigo);

const codificar = (s: string) => new TextEncoder().encode(s);

describe("crudo íntegro", () => {
  it("pasa sin un solo problema y calcula las tres huellas", () => {
    const r = verificarCrudo(CRUDO);
    expect(r.problemas).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.huellaDelCrudo).toBe(
      sha256(CRUDO.get(FICHERO_DE_SUMAS) ?? new Uint8Array()),
    );
    expect(r.huellaDelPlan).toBe(
      sha256(CRUDO.get(FICHERO_DEL_PLAN) ?? new Uint8Array()),
    );
    expect(r.huellaCanonica).toMatch(/^[0-9a-f]{64}$/);
    expect(r.crudo?.cargable).toBe(true);
    expect(r.resumen).toMatchObject({
      estado: "succeeded",
      motivo: "objetivo_alcanzado",
      rondas: 2,
      unicosElegibles: 6,
    });
  });

  it("SHA256SUMS lista plan, manifiesto y las 14 páginas, ordenados, verificable con sha256sum -c", () => {
    const texto = new TextDecoder().decode(CRUDO.get(FICHERO_DE_SUMAS));
    const r = leerSumas(texto);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sumas).toHaveLength(16);
    expect(r.sumas.map((s) => s.ruta)).toContain("paginas/0001-netflix-movie-r01.json");
    expect(r.sumas.map((s) => s.ruta)).toContain("paginas/0014-disney-movie-r02.json");
    expect(texto).toMatch(/^[0-9a-f]{64} {2}\S/);
  });

  it("de ida y vuelta por disco da el mismo resultado", () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-verificar-"));
    try {
      escribirCrudo(join(dir, "c"), CRUDO);
      const r = verificarCrudo(leerDirectorioDelCrudo(join(dir, "c")));
      expect(r.ok).toBe(true);
      expect(r.huellaDelCrudo).toBe(verificarCrudo(CRUDO).huellaDelCrudo);
      // Inmutable: un segundo volcado al mismo sitio se niega.
      expect(() => escribirCrudo(join(dir, "c"), CRUDO)).toThrow(/inmutable/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("el resumen se imprime sin problemas", () => {
    const lineas = describirVerificacion(verificarCrudo(CRUDO));
    expect(lineas[0]).toBe("seed:verificar · OK");
    expect(lineas.join("\n")).toMatch(/objetivo_alcanzado/);
  });
});

describe("integridad", () => {
  it("checksum incorrecto: un byte cambiado en una página", () => {
    const c = new Map(CRUDO);
    const ruta = "paginas/0003-prime-movie-r01.json";
    const bytes = new Uint8Array(c.get(ruta) ?? []);
    bytes[10] = (bytes[10] ?? 0) ^ 1;
    c.set(ruta, bytes);
    expect(codigos(c)).toContain("sha256_incorrecto");
    expect(verificarCrudo(c).crudo).toBeNull();
  });

  it("checksum incorrecto: SHA256SUMS con un hash alterado", () => {
    const c = new Map(CRUDO);
    const texto = new TextDecoder().decode(c.get(FICHERO_DE_SUMAS));
    c.set(
      FICHERO_DE_SUMAS,
      codificar(texto.replace(/^[0-9a-f]/, (x) => (x === "0" ? "1" : "0"))),
    );
    expect(codigos(c)).toContain("sha256_incorrecto");
  });

  it("página corrupta aunque se reselle: el sha256 del manifiesto no cuadra", () => {
    const c = new Map(CRUDO);
    c.set("paginas/0003-prime-movie-r01.json", codificar("{ roto"));
    expect(codigos(resellar(c))).toContain("sha256_incorrecto");
  });

  it("archivo ausente", () => {
    const c = new Map(CRUDO);
    c.delete("paginas/0007-max-movie-r01.json");
    expect(codigos(c)).toContain("fichero_ausente");
  });

  it("archivo extra fuera de SHA256SUMS", () => {
    const c = new Map(CRUDO);
    c.set("notas.txt", codificar("hola"));
    expect(codigos(c)).toEqual(["fichero_extra"]);
  });

  it("archivo extra dentro de SHA256SUMS pero no en el manifiesto", () => {
    const c = new Map(CRUDO);
    c.set("paginas/0099-netflix-movie-r09.json", codificar("{}"));
    expect(codigos(resellar(c))).toContain("fichero_extra");
  });

  it("sin SHA256SUMS no hay huella", () => {
    const c = new Map(CRUDO);
    c.delete(FICHERO_DE_SUMAS);
    const r = verificarCrudo(c);
    expect(r.problemas.map((p) => p.codigo)).toEqual(["fichero_ausente"]);
    expect(r.huellaDelCrudo).toBeNull();
  });

  it("SHA256SUMS desordenado se rechaza, no se normaliza", () => {
    const c = new Map(CRUDO);
    const lineas = new TextDecoder()
      .decode(c.get(FICHERO_DE_SUMAS))
      .trimEnd()
      .split("\n")
      .reverse();
    c.set(FICHERO_DE_SUMAS, codificar(`${lineas.join("\n")}\n`));
    expect(codigos(c)).toEqual(["sha256sums_invalido"]);
  });

  it("una ruta que sale del directorio no es una ruta del crudo", () => {
    expect(leerSumas(`${"a".repeat(64)}  ../fuera\n`).ok).toBe(false);
  });
});

describe("formatos y versión", () => {
  it("un plan v2 se rechaza como versión desconocida, no se interpreta", () => {
    const c = new Map(CRUDO);
    const plan = JSON.parse(
      new TextDecoder().decode(c.get(FICHERO_DEL_PLAN)),
    ) as Record<string, unknown>;
    c.set(FICHERO_DEL_PLAN, codificar(JSON.stringify({ ...plan, v: 2 })));
    expect(codigos(resellar(c))).toContain("version_desconocida");
  });

  it("el plan exige los 12 estratos en el orden fijo", () => {
    const plan = crearPlan();
    const alReves = { ...plan, estratos: [...plan.estratos].reverse() };
    expect(planV1.safeParse(plan).success).toBe(true);
    expect(planV1.safeParse(alReves).success).toBe(false);
    expect(
      planV1.safeParse({ ...plan, estratos: plan.estratos.slice(1) }).success,
    ).toBe(false);
  });

  it("el plan no admite claves de más ni otro margen del ancla", () => {
    expect(planV1.safeParse({ ...crearPlan(), extra: 1 }).success).toBe(false);
    expect(
      planV1.safeParse({ ...crearPlan(), margenDelAnclaSegundos: 60 }).success,
    ).toBe(false);
  });

  it("un manifiesto abierto no se verifica", () => {
    expect(codigos(reempaquetar(CRUDO, (m) => ({ ...m, cierre: null })))).toEqual([
      "manifiesto_abierto",
    ]);
  });

  it("un manifiesto de otro plan: huella del plan distinta", () => {
    expect(
      codigos(reempaquetar(CRUDO, (m) => ({ ...m, huellaDelPlan: "0".repeat(64) }))),
    ).toContain("huella_del_plan_distinta");
  });
});

describe("coherencia plan ↔ manifiesto ↔ páginas", () => {
  it("cursor incoherente: la página 2 del estrato no entra con el nextCursor de la 1", () => {
    const c = reempaquetar(CRUDO, (m) => {
      const p = m.paginas.find((x) => x.estrato === "netflix-movie" && x.ronda === 2);
      if (p === undefined) throw new Error("fixture");
      return {
        ...m,
        paginas: m.paginas.map((x) =>
          x === p
            ? { ...p, cursorDeEntrada: "otro", query: { ...p.query, cursor: "otro" } }
            : x,
        ),
      };
    });
    expect(codigos(c)).toContain("cursor_incoherente");
  });

  it("manifiesto incoherente: hasMore distinto del cuerpo", () => {
    const c = reempaquetar(CRUDO, (m) => ({
      ...m,
      paginas: m.paginas.map((x) => (x.n === 2 ? { ...x, hasMore: true } : x)),
    }));
    expect(codigos(c)).toContain("pagina_incoherente");
  });

  it("manifiesto incoherente: un motivo de parada que las páginas no reproducen", () => {
    const c = reempaquetar(CRUDO, (m) =>
      m.cierre === null
        ? m
        : { ...m, cierre: { ...m.cierre, motivo: "catalogo_agotado" } },
    );
    expect(codigos(c)).toContain("parada_incoherente");
  });

  it("succeeded a mitad de ronda: parada incoherente", () => {
    const c = reempaquetar(
      CRUDO,
      (m) => ({ ...m, paginas: m.paginas.slice(0, 13) }),
      (f) => f.delete("paginas/0014-disney-movie-r02.json"),
    );
    expect(codigos(c)).toContain("parada_incoherente");
  });

  it("orden de ronda: dos páginas intercambiadas", () => {
    const c = reempaquetar(CRUDO, (m) => {
      const [p1, p2, ...resto] = m.paginas;
      if (p1 === undefined || p2 === undefined) throw new Error("fixture");
      return { ...m, paginas: [{ ...p2, n: 1 }, { ...p1, n: 2 }, ...resto] };
    });
    const r = codigos(c);
    expect(r).toContain("orden_de_ronda");
  });

  it("una clave ajena en la query se trata como posible credencial, sin imprimir su valor", () => {
    const c = reempaquetar(CRUDO, (m) => ({
      ...m,
      paginas: m.paginas.map((x) =>
        x.n === 1 ? { ...x, query: { ...x.query, api_key: "SECRETO" } } : x,
      ),
    }));
    const r = verificarCrudo(c);
    expect(r.problemas.map((p) => p.codigo)).toContain("credencial_en_query");
    expect(JSON.stringify(r.problemas)).not.toContain("SECRETO");
  });

  it("instantes: una respuesta anterior a su reserva", () => {
    const c = reempaquetar(CRUDO, (m) => ({
      ...m,
      paginas: m.paginas.map((x) =>
        x.n === 1 ? { ...x, respondidaEn: "2026-11-03T08:00:00.000Z" } : x,
      ),
    }));
    expect(codigos(c)).toContain("instantes_incoherentes");
  });

  it("ancla: S distinto de T0 truncado − 1 h", () => {
    const c = reempaquetar(CRUDO, (m) =>
      m.cierre === null ? m : { ...m, cierre: { ...m.cierre, ancla: m.cierre.T0 } },
    );
    expect(codigos(c)).toContain("ancla_incoherente");
  });

  it("m1_caducada: una M1 de dos ciclos antes no respalda el crudo", () => {
    const c = new Map(CRUDO);
    const plan = crearPlan({ m1: { runId: "3", cicloClave: 202609, diaDeCiclo: 1 } });
    const bytes = codificar(`${JSON.stringify(plan, null, 2)}\n`);
    c.set(FICHERO_DEL_PLAN, bytes);
    const r = codigos(
      resellar(reempaquetar(c, (m) => ({ ...m, huellaDelPlan: sha256(bytes) }))),
    );
    expect(r).toEqual(["m1_caducada"]);
    expect(cicloSiguiente(202612)).toBe(202701);
  });

  it("contadores: más páginas que respuestas", () => {
    const c = reempaquetar(CRUDO, (m) =>
      m.cierre === null ? m : { ...m, cierre: { ...m.cierre, respuestas: 3 } },
    );
    expect(codigos(c)).toContain("contadores_incoherentes");
  });
});

describe("frontera de ronda, shows fuera de contrato e ids de ops", () => {
  it("un crudo cortado a mitad de ronda no puede declararse rondaCompleta", async () => {
    fijarReloj();
    const cortado = (await capturar({ paginas: PAGINAS_BASE, tope: 5 })).contenido;
    expect(verificarCrudo(cortado).crudo?.motivoNoCargable).toBe("ronda_incompleta");
    const mentira = reempaquetar(cortado, (m) =>
      m.cierre === null
        ? m
        : { ...m, cierre: { ...m.cierre, rondaCompleta: true, rondasCompletas: 1 } },
    );
    const r = verificarCrudo(mentira);
    expect(r.problemas.map((p) => p.codigo)).toContain("contadores_incoherentes");
    expect(r.crudo).toBeNull();
  });

  it("succeeded sin frontera de ronda: incoherente", () => {
    const c = reempaquetar(CRUDO, (m) =>
      m.cierre === null ? m : { ...m, cierre: { ...m.cierre, rondaCompleta: false } },
    );
    expect(codigos(c)).toContain("parada_incoherente");
  });

  it("una página confirmada con un show fuera del schema es pagina_invalida", () => {
    const ruta = "paginas/0003-prime-movie-r01.json";
    const cuerpo = codificar(
      JSON.stringify({
        shows: [{ itemType: "show", showType: "movie", imdbId: "tt1" }],
        hasMore: false,
      }),
    );
    const c = reempaquetar(
      CRUDO,
      (m) => ({
        ...m,
        paginas: m.paginas.map((p) =>
          p.fichero === ruta
            ? { ...p, bytes: cuerpo.length, sha256: sha256(cuerpo), shows: 1 }
            : p,
        ),
      }),
      (f) => f.set(ruta, cuerpo),
    );
    const r = verificarCrudo(c);
    expect(r.problemas.map((p) => p.codigo)).toEqual(["pagina_invalida"]);
    expect(r.problemas[0]?.detalle).toMatch(/posición 0/);
  });

  it("los ids de ops_sync_runs viajan como texto decimal; un number se rechaza", () => {
    const conNumero = reempaquetar(CRUDO, (m) => ({
      ...m,
      paginas: m.paginas.map((p) => ({ ...p, runId: 1 as unknown as string })),
    }));
    expect(codigos(conNumero)).toContain("manifiesto_invalido");
    const conCero = reempaquetar(CRUDO, (m) =>
      m.cierre === null ? m : { ...m, cierre: { ...m.cierre, filasDeOps: ["01"] } },
    );
    expect(codigos(conCero)).toContain("manifiesto_invalido");
  });

  it("un id mayor que Number.MAX_SAFE_INTEGER se conserva exacto", () => {
    const grande = "9007199254740993";
    // Como number de JSON se redondearía en silencio a otra fila.
    expect(String(Number(grande))).not.toBe(grande);
    const c = reempaquetar(CRUDO, (m) => ({
      ...m,
      paginas: m.paginas.map((p) => ({ ...p, runId: grande })),
      cierre: m.cierre === null ? null : { ...m.cierre, filasDeOps: [grande] },
    }));
    const r = verificarCrudo(c);
    expect(r.problemas).toEqual([]);
    expect(r.crudo?.cierre.filasDeOps).toEqual([grande]);
  });
});

describe("huellas deterministas", () => {
  it("dos capturas idénticas dan el mismo crudo, byte a byte, y la misma huella", async () => {
    fijarReloj();
    const otra = (await capturar({ paginas: PAGINAS_BASE })).contenido;
    expect(verificarCrudo(otra).huellaDelCrudo).toBe(
      verificarCrudo(CRUDO).huellaDelCrudo,
    );
    expect(verificarCrudo(otra).huellaCanonica).toBe(
      verificarCrudo(CRUDO).huellaCanonica,
    );
  });

  it("el orden en que se leen los ficheros no cambia nada", () => {
    const alReves = new Map([...CRUDO].reverse());
    const a = verificarCrudo(CRUDO);
    const b = verificarCrudo(alReves);
    expect(b.huellaDelCrudo).toBe(a.huellaDelCrudo);
    expect(b.huellaCanonica).toBe(a.huellaCanonica);
  });

  it("jsonCanonico ordena claves y construirSumas ordena rutas", () => {
    expect(jsonCanonico({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(
      '{"a":[2,{"c":4,"d":3}],"b":1}',
    );
    const a = construirSumas([
      { ruta: "b", sha256: "1".repeat(64) },
      { ruta: "a", sha256: "2".repeat(64) },
    ]);
    expect(a.startsWith("2")).toBe(true);
  });

  it("el script no necesita variables ni credenciales: lee un directorio y verifica", () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-verificar-"));
    try {
      escribirCrudo(join(dir, "c"), CRUDO);
      writeFileSync(join(dir, "c", "sobra.txt"), "x");
      const r = verificarCrudo(leerDirectorioDelCrudo(join(dir, "c")));
      expect(r.problemas.map((p) => p.codigo)).toEqual(["fichero_extra"]);
      expect(r.problemas[0]?.fichero).toBe("sobra.txt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FICHERO_DEL_MANIFIESTO forma parte de las sumas", () => {
    expect(new TextDecoder().decode(CRUDO.get(FICHERO_DE_SUMAS))).toContain(
      FICHERO_DEL_MANIFIESTO,
    );
  });
});
