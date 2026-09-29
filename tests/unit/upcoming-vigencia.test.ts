/**
 * **La vigencia de un anuncio es derivada** (ADR 0007, `upcoming/vigencia.ts`):
 * `announced_for > ahora` no basta; hace falta que lo haya observado el último
 * recorrido completo y válido de `upcoming`, o uno posterior.
 *
 * El job entero sobre el libro y la base en memoria, y después la lectura de
 * «Próximamente» tal y como la hará el producto.
 */
import { describe, expect, it } from "vitest";

import { crearLibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import type { LibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import { leerPresupuesto } from "../../jobs/ops/presupuesto.ts";
import type { FuenteDeCuota, Transporte } from "../../jobs/ops/transporte.ts";
import { transaccionPorPagina } from "../../jobs/pipelines/deltas/job.ts";
import { ejecutarJobDeUpcoming } from "../../jobs/pipelines/upcoming/job.ts";
import {
  SQL_ANUNCIOS_VIGENTES,
  SQL_RECORRIDO_DE_REFERENCIA,
  leerAnunciosVigentes,
  leerRecorridoDeReferencia,
  vigenciaDeAnuncio,
} from "../../jobs/pipelines/upcoming/vigencia.ts";
import { conexionDeDatos } from "./ayudas-checkpoint.ts";
import { respuestaCruda, showCrudo } from "./ayudas-deltas.ts";
import type { BaseEnMemoria } from "./base-en-memoria.ts";
import { crearBaseEnMemoria } from "./base-en-memoria.ts";

const DIA = 86_400_000;
const T = new Date("2026-09-24T10:00:00.000Z");
const en = (dias: number, desde = T) => new Date(desde.getTime() + dias * DIA);
const seg = (d: Date) => Math.floor(d.getTime() / 1000);

// ── Dobles ───────────────────────────────────────────────────────────────────

type Listas = ReadonlyMap<string, unknown>;

interface Mundo {
  readonly libro: LibroEnMemoria;
  readonly base: BaseEnMemoria;
}

const crearMundo = (): Mundo => ({
  libro: crearLibroEnMemoria(),
  base: crearBaseEnMemoria(),
});

async function recorrer(
  mundo: Mundo,
  entrada: { readonly listas: Listas; readonly ahora: Date; readonly tope?: number },
) {
  const datos = conexionDeDatos(mundo.base, mundo.libro);
  const crear =
    (fuente: FuenteDeCuota): Transporte =>
    async (url) => {
      await fuente.pedirCuota();
      const u = new URL(url);
      const clave = `${u.searchParams.get("change_type") ?? "?"}|${u.searchParams.get("cursor") ?? ""}`;
      const cuerpo = entrada.listas.get(clave);
      if (cuerpo === undefined) throw new Error(`sin página para ${clave}`);
      return new Response(JSON.stringify(cuerpo), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-quota-used": "1",
          "x-quota-granted": "1000",
          "x-quota-reset": "2026-10-01T00:00:00Z",
        },
      });
    };
  const salida = await ejecutarJobDeUpcoming({
    // El destino histórico, declarado: el régimen por defecto es el estricto.
    regimen: "historico",
    ejecutorOps: mundo.libro.ejecutor,
    ejecutorDatos: datos.ejecutor,
    transaccion: transaccionPorPagina(datos.ejecutor),
    presupuesto: leerPresupuesto({
      STREAMING_API_PER_RUN_CAPS: `upcoming=${String(entrada.tope ?? 12)}`,
    }),
    crearLlamada: crear,
    apiKey: "k",
    plan: { origen: "persistente" },
    ahora: entrada.ahora,
    crearRegistro: null,
    vincularEventos: true,
  });
  if (!salida.resultado.ejecutado) throw new Error("no se ejecutó");
  const runId = salida.resultado.runId;
  return {
    salida,
    runId,
    estado: salida.resultado.estado,
    fila: mundo.libro.filas.find((f) => f.id === runId),
  };
}

const imdb = (id: string) => `tt${id.padStart(7, "0")}`;

function anuncio(id: string, estreno: Date, servicio = "netflix") {
  return {
    cambio: {
      changeType: "upcoming",
      showId: id,
      service: servicio,
      type: "subscription",
      link: `https://${servicio}.test/${id}`,
      timestamp: seg(estreno),
    },
    show: showCrudo({ id, imdbId: imdb(id), opciones: [] }),
  };
}

function paginaDe(
  avisos: readonly ReturnType<typeof anuncio>[],
  nextCursor?: string,
): Record<string, unknown> {
  return respuestaCruda({
    cambios: avisos.map((a) => a.cambio),
    shows: avisos.map((a) => a.show),
    hasMore: nextCursor !== undefined,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  });
}

const soloPagina = (avisos: readonly ReturnType<typeof anuncio>[]): Listas =>
  new Map([["upcoming|", paginaDe(avisos)]]);

/** «Próximamente» en `ahora`: los imdb vigentes, ordenados. */
async function proximamente(mundo: Mundo, ahora: Date): Promise<string[]> {
  const vigentes = await leerAnunciosVigentes(
    { datos: mundo.base.ejecutor, ops: mundo.libro.ejecutor },
    ahora,
  );
  return vigentes.map((v) => `${v.imdbId}|${v.plataforma}`).sort();
}

const clave = (id: string, plataforma = "netflix") => `${imdb(id)}|${plataforma}`;

// ── La regla, pura ───────────────────────────────────────────────────────────

describe("vigenciaDeAnuncio", () => {
  const futuro = (run: number | null, platformId = "netflix") => ({
    platformId,
    announcedFor: en(10),
    lastSeenRunId: run,
  });

  it("fecha futura y visto en el recorrido de referencia: vigente", () => {
    expect(vigenciaDeAnuncio(futuro(7), 7, T)).toEqual({
      vigente: true,
      motivo: "observado",
    });
  });

  it("visto en un recorrido POSTERIOR a la referencia (incompleto): vigente", () => {
    expect(vigenciaDeAnuncio(futuro(9), 7, T).vigente).toBe(true);
  });

  it("⚖️ fecha futura pero no visto en el último completo: NO vigente", () => {
    expect(vigenciaDeAnuncio(futuro(5), 7, T)).toEqual({
      vigente: false,
      motivo: "no_observado",
    });
    // Un run borrado (SET NULL) o de un ensayo tampoco demuestra nada.
    expect(vigenciaDeAnuncio(futuro(null), 7, T).motivo).toBe("no_observado");
  });

  it("sin recorrido de referencia no se afirma nada: NO vigente", () => {
    expect(vigenciaDeAnuncio(futuro(9), null, T)).toEqual({
      vigente: false,
      motivo: "sin_referencia",
    });
  });

  it("fecha que ya llegó: vencido, aunque se viera ayer", () => {
    expect(
      vigenciaDeAnuncio(
        { platformId: "netflix", announcedFor: T, lastSeenRunId: 7 },
        7,
        T,
      ),
    ).toEqual({ vigente: false, motivo: "vencido" });
  });

  it("SkyShowtime no se interpreta con esta señal: solo la fecha", () => {
    expect(vigenciaDeAnuncio(futuro(1, "skyshowtime"), 7, T)).toEqual({
      vigente: true,
      motivo: "sin_cobertura",
    });
    expect(vigenciaDeAnuncio(futuro(null, "skyshowtime"), null, T).vigente).toBe(true);
    expect(
      vigenciaDeAnuncio(
        { platformId: "skyshowtime", announcedFor: en(-1), lastSeenRunId: 7 },
        7,
        T,
      ).motivo,
    ).toBe("vencido");
  });

  it("el SQL repite la regla, sin escribir nada", () => {
    const vigentes = SQL_ANUNCIOS_VIGENTES.replace(/\s+/g, " ");
    expect(vigentes).toContain("proximo.announced_for > $2::timestamptz");
    expect(vigentes).toContain("proximo.platform_id = ANY($3::text[])");
    expect(vigentes).toContain("proximo.last_seen_run_id >= $4::bigint");
    const referencia = SQL_RECORRIDO_DE_REFERENCIA.replace(/\s+/g, " ");
    expect(referencia).toContain("status = 'succeeded'");
    expect(referencia).toContain("error_count = 0");
    expect(referencia).toContain("checkpoint -> 'pendiente' = 'null'::jsonb");
    expect(referencia).toContain("ORDER BY id DESC");
    for (const sql of [vigentes, referencia]) {
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    }
  });
});

// ── Sobre ejecuciones reales del job ─────────────────────────────────────────

describe("«Próximamente» sale de la vigencia, no de la fecha", () => {
  it("anuncio futuro visto en el último recorrido completo → vigente", async () => {
    const mundo = crearMundo();
    const r1 = await recorrer(mundo, {
      listas: soloPagina([anuncio("1", en(10)), anuncio("2", en(12))]),
      ahora: T,
    });
    expect(r1.estado).toBe("succeeded");
    expect(await leerRecorridoDeReferencia(mundo.libro.ejecutor)).toBe(r1.runId);
    expect(await proximamente(mundo, en(0.5))).toEqual([clave("1"), clave("2")]);
  });

  it("anuncio futuro NO visto en el último completo → no vigente, y la fila sigue", async () => {
    const mundo = crearMundo();
    await recorrer(mundo, {
      listas: soloPagina([anuncio("1", en(10)), anuncio("2", en(12))]),
      ahora: T,
    });
    const r2 = await recorrer(mundo, {
      listas: soloPagina([anuncio("1", en(10))]),
      ahora: en(1),
    });
    expect(await leerRecorridoDeReferencia(mundo.libro.ejecutor)).toBe(r2.runId);
    expect(await proximamente(mundo, en(1.5))).toEqual([clave("1")]);
    // La fila del 2 sigue ahí, con su fecha futura: nada se borra ni se marca.
    expect(mundo.base.anuncios().map((a) => a.imdbId)).toEqual([imdb("1"), imdb("2")]);
    expect(r2.salida.horizonte).toMatchObject({ desaparecidas: 1 });
  });

  it("y si vuelve a aparecer en un recorrido completo posterior, vuelve a ser vigente", async () => {
    const mundo = crearMundo();
    const ambos = soloPagina([anuncio("1", en(10)), anuncio("2", en(12))]);
    await recorrer(mundo, { listas: ambos, ahora: T });
    await recorrer(mundo, { listas: soloPagina([anuncio("1", en(10))]), ahora: en(1) });
    await recorrer(mundo, { listas: ambos, ahora: en(2) });
    expect(await proximamente(mundo, en(2.5))).toEqual([clave("1"), clave("2")]);
  });

  it("⚖️ un recorrido posterior INCOMPLETO no invalida ningún anuncio", async () => {
    const mundo = crearMundo();
    const r1 = await recorrer(mundo, {
      listas: soloPagina([anuncio("1", en(10)), anuncio("2", en(12))]),
      ahora: T,
    });
    // Corte de tope tras la página 1: solo ve el 1; el 2 iba en la página 2.
    const r2 = await recorrer(mundo, {
      tope: 1,
      ahora: en(1),
      listas: new Map([
        ["upcoming|", paginaDe([anuncio("1", en(10))], "c1")],
        ["upcoming|c1", paginaDe([anuncio("2", en(12))])],
      ]),
    });
    expect(r2.estado).toBe("budget_stopped");
    // La referencia sigue siendo el completo.
    expect(await leerRecorridoDeReferencia(mundo.libro.ejecutor)).toBe(r1.runId);
    // El 1 lo vio el incompleto (run posterior) y el 2 el completo: los dos.
    const [uno] = mundo.base.anuncios();
    expect(uno?.lastSeenRunId).toBe(r2.runId);
    expect(await proximamente(mundo, en(1.5))).toEqual([clave("1"), clave("2")]);
  });

  it("un recorrido que termina con avisos sin su show no sirve de referencia", async () => {
    const mundo = crearMundo();
    const r1 = await recorrer(mundo, {
      listas: soloPagina([anuncio("1", en(10)), anuncio("2", en(12))]),
      ahora: T,
    });
    // Completo, pero el aviso del 2 llega sin su show: no se puede atribuir.
    const huerfano = paginaDe([anuncio("1", en(10))]) as { changes: unknown[] };
    huerfano.changes.push({
      ...(anuncio("2", en(12)).cambio as object),
      itemType: "show",
      showType: "movie",
      service: { id: "netflix", name: "netflix" },
      streamingOptionType: "subscription",
    });
    const r2 = await recorrer(mundo, {
      listas: new Map([["upcoming|", huerfano]]),
      ahora: en(1),
    });
    expect(r2.estado).toBe("succeeded");
    expect(r2.fila?.errorCount).toBe(1);
    expect(r2.fila?.errorSamples).toEqual([{ motivo: "avisos_sin_show", avisos: 1 }]);
    expect(await leerRecorridoDeReferencia(mundo.libro.ejecutor)).toBe(r1.runId);
    // El 2 sigue vigente: un recorrido que no pudo atribuirlo no lo descuenta.
    expect(await proximamente(mundo, en(1.5))).toEqual([clave("1"), clave("2")]);
  });

  it("sin ningún recorrido completo, nada es vigente", async () => {
    const mundo = crearMundo();
    await recorrer(mundo, {
      tope: 1,
      ahora: T,
      listas: new Map([
        ["upcoming|", paginaDe([anuncio("1", en(10))], "c1")],
        ["upcoming|c1", paginaDe([anuncio("2", en(12))])],
      ]),
    });
    expect(await leerRecorridoDeReferencia(mundo.libro.ejecutor)).toBeNull();
    expect(mundo.base.anuncios()).toHaveLength(1);
    expect(await proximamente(mundo, en(0.5))).toEqual([]);
  });

  it("una fecha que ya llegó deja de ser vigente aunque la viera la referencia", async () => {
    const mundo = crearMundo();
    await recorrer(mundo, {
      listas: soloPagina([anuncio("1", en(2)), anuncio("2", en(12))]),
      ahora: T,
    });
    expect(await proximamente(mundo, en(3))).toEqual([clave("2")]);
  });

  it("SkyShowtime no se interpreta mediante esta señal", async () => {
    const mundo = crearMundo();
    await recorrer(mundo, {
      listas: soloPagina([anuncio("1", en(10)), anuncio("3", en(14), "skyshowtime")]),
      ahora: T,
    });
    // El siguiente recorrido completo no la lista: para una plataforma que el
    // endpoint no cubre, eso no significa nada.
    const r2 = await recorrer(mundo, {
      listas: soloPagina([anuncio("1", en(10))]),
      ahora: en(1),
    });
    expect(r2.salida.horizonte).toMatchObject({
      desaparecidas: 0,
      fueraDeCobertura: 1,
    });
    expect(await proximamente(mundo, en(1.5))).toEqual([
      clave("1"),
      clave("3", "skyshowtime"),
    ]);
  });
});
