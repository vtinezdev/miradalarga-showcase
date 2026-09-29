/**
 * **`updated` es no destructivo respecto a las opciones** (decidido el
 * 2026-09-25).
 *
 * El núcleo común colapsa una opción `(link, NULL)` en la `(link, calidad)`
 * que el snapshot ahora precisa: la borra y hereda su `first_seen_at`
 * (`opciones.ts`, `deltas-reconciliacion.test.ts`). `updated` lo desactiva
 * (`reconciliarCalidadDesconocida: false`): persiste la identidad nueva y deja
 * la `(link, NULL)` como está —sin borrarla, sin tocar su racha— para que la
 * resuelvan `deltas` o `reconcile`. Los demás pipelines no cambian.
 */
import { describe, expect, it } from "vitest";

import type { OpcionExistente } from "../../jobs/pipelines/deltas/contratos.ts";
import { ejecutarDeltas } from "../../jobs/pipelines/deltas/index.ts";
import { transaccionPorPagina } from "../../jobs/pipelines/deltas/job.ts";
import { planificarOpciones } from "../../jobs/pipelines/deltas/opciones.ts";
import { estrategiaDeExpiring } from "../../jobs/pipelines/expiring/job.ts";
import { estrategiaDeUpdated } from "../../jobs/pipelines/updated/job.ts";
import type { OpcionCruda } from "./ayudas-deltas.ts";
import { crearTransporteFalso, respuestaCruda, showCrudo } from "./ayudas-deltas.ts";
import { foto, observarUpdated, sembrar } from "./ayudas-updated.ts";
import type { BaseEnMemoria } from "./base-en-memoria.ts";
import { crearBaseEnMemoria } from "./base-en-memoria.ts";

const T0 = new Date("2026-09-24T06:00:00.000Z");
const T1 = new Date("2026-09-25T06:00:00.000Z");
const T2 = new Date("2026-09-26T06:00:00.000Z");
const seg = (d: Date) => Math.floor(d.getTime() / 1000);

const LINK = "https://apple.test/9?playableId=1";
/** Sin `quality`: la opción `(link, NULL)`. */
const SIN_CALIDAD: OpcionCruda = {
  service: "apple",
  type: "buy",
  link: LINK,
  price: { amount: "9.99", currency: "EUR" },
};
const HD: OpcionCruda = {
  ...SIN_CALIDAD,
  quality: "hd",
  price: { amount: "7.99", currency: "EUR" },
};

const show = (opciones: readonly OpcionCruda[]) =>
  showCrudo({ id: "9", imdbId: "tt0000009", opciones });

const pagina = (tipo: string, opciones: readonly OpcionCruda[]) =>
  respuestaCruda({
    cambios: [
      {
        changeType: tipo,
        showId: "9",
        service: "apple",
        type: "buy",
        link: LINK,
        timestamp: seg(T0) + 3600,
      },
    ],
    shows: [show(opciones)],
  });

const opcionesDe = (base: BaseEnMemoria) =>
  foto(base).opciones.filter((o) => o.link === LINK);
const sinCalidad = (base: BaseEnMemoria) =>
  opcionesDe(base).find((o) => o.quality === null);
const conHd = (base: BaseEnMemoria) => opcionesDe(base).find((o) => o.quality === "hd");

/** La base con la `(link, NULL)` observada en T0. */
async function conSinCalidad(): Promise<BaseEnMemoria> {
  const base = crearBaseEnMemoria();
  await sembrar(base, T0, [show([SIN_CALIDAD])]);
  expect(opcionesDe(base)).toHaveLength(1);
  return base;
}

describe("la configuración de cada pipeline", () => {
  it("updated desactiva la reconciliación; expiring la conserva (por defecto)", () => {
    expect(estrategiaDeUpdated("prohibido").reconciliarCalidadDesconocida).toBe(false);
    expect(estrategiaDeExpiring().reconciliarCalidadDesconocida).toBeUndefined();
  });

  it("planificarOpciones: sin reconciliar, la (link, NULL) ni se borra ni hereda: sobrevive", () => {
    const existente: OpcionExistente = {
      id: "501",
      link: LINK,
      calidad: null,
      precio: { importe: "9.99", moneda: "EUR" },
      idiomasAudio: [],
      idiomasSubtitulos: [],
      disponibleDesde: null,
      expiraEl: null,
      vistaPrimeroEn: T0,
      ausenciasSeguidas: 0,
    };
    const snapshot = [
      {
        link: LINK,
        calidad: "hd" as const,
        precio: { importe: "7.99", moneda: "EUR" },
        idiomasAudio: [],
        idiomasSubtitulos: [],
        disponibleDesde: null,
        expiraEl: null,
      },
    ];
    const comun = {
      existentes: [existente],
      snapshot,
      ahora: T1,
      retiradaExplicita: false,
      aplicarAusencias: false,
      observacionNueva: true,
    };

    const noDestructivo = planificarOpciones({
      ...comun,
      reconciliarCalidadDesconocida: false,
    });
    expect(noDestructivo.aBorrar).toEqual([]);
    expect(noDestructivo.herencias.size).toBe(0);
    expect(noDestructivo.ausencias).toEqual([]);
    expect(noDestructivo.activasDespues.map((o) => o.calidad)).toEqual(["hd", null]);

    // Por defecto, lo de siempre: se colapsa y hereda.
    const porDefecto = planificarOpciones(comun);
    expect(porDefecto.aBorrar).toEqual(["501"]);
    expect(porDefecto.herencias.get(LINK)).toEqual(T0);
  });
});

describe("updated con (link, NULL) previa y (link, hd) nueva", () => {
  it("1 · no borra la fila NULL", async () => {
    const base = await conSinCalidad();
    const { informe } = await observarUpdated(base, T1, [pagina("updated", [HD])]);
    expect(sinCalidad(base)).toBeDefined();
    expect(informe.opcionesReconciliadas).toBe(0);
    expect(base.sentencias.some((s) => s.startsWith("DELETE"))).toBe(false);
  });

  it("2 · persiste la nueva observación, sin heredar la antigüedad de la NULL", async () => {
    const base = await conSinCalidad();
    const { clasificacion } = await observarUpdated(base, T1, [
      pagina("updated", [HD]),
    ]);
    expect(conHd(base)).toMatchObject({
      priceAmount: "7.99",
      missingStreak: 0,
      firstSeenAt: T1.toISOString(),
    });
    // La NULL sigue siendo la de T0, intacta.
    expect(sinCalidad(base)).toMatchObject({
      priceAmount: "9.99",
      firstSeenAt: T0.toISOString(),
    });
    // El agregado describe lo que queda escrito: dos opciones activas.
    expect(clasificacion.eventos.camposDeAvisos).toEqual({
      options: 1,
      price: 1,
      quality: 1,
    });
    expect(clasificacion.opcionesQueSobrevivenSinVerse).toBe(1);
  });

  it("3 · no toca missing_streak, ni con una segunda observación posterior", async () => {
    const base = await conSinCalidad();
    await observarUpdated(base, T1, [pagina("updated", [HD])]);
    expect(sinCalidad(base)?.missingStreak).toBe(0);
    const { informe } = await observarUpdated(base, T2, [pagina("updated", [HD])]);
    expect(sinCalidad(base)?.missingStreak).toBe(0);
    expect(informe.opcionesMarcadasAusentes).toBe(0);
    expect(opcionesDe(base)).toHaveLength(2);
  });

  it("5 · idempotente: la misma observación otra vez no escribe nada, y una posterior tampoco inventa cambios", async () => {
    const base = await conSinCalidad();
    await observarUpdated(base, T1, [pagina("updated", [HD])]);
    const tras1 = foto(base);
    const tras1SinInstantes = foto(base, false);
    const eventos = base.eventos().length;

    const otra = await observarUpdated(base, T1, [pagina("updated", [HD])]);
    expect(otra.clasificacion.porResultado.misma_observacion).toBe(1);
    expect(otra.informe.eventosEscritos).toBe(0);
    expect(foto(base)).toEqual(tras1);

    const despues = await observarUpdated(base, T2, [pagina("updated", [HD])]);
    expect(despues.clasificacion.porResultado.no_op).toBe(1);
    expect(despues.informe.eventos).toEqual({});
    expect(base.eventos()).toHaveLength(eventos);
    expect(foto(base, false).opciones).toEqual(tras1SinInstantes.opciones);
    expect(opcionesDe(base)).toHaveLength(2);
  });
});

describe("4 · deltas conserva su reconciliación", () => {
  async function deltasNew(base: BaseEnMemoria, ahora: Date) {
    const red = crearTransporteFalso([pagina("new", [HD])]);
    return ejecutarDeltas({
      ejecutor: base.ejecutor,
      peticion: { transporte: red.transporte, apiKey: "k" },
      tipos: ["new"],
      ventana: null,
      ahora,
      maximoDePaginas: 10,
      transaccion: transaccionPorPagina(base.ejecutor),
    });
  }

  it("sobre la (link, NULL) previa: la colapsa en la hd y hereda su first_seen_at", async () => {
    const base = await conSinCalidad();
    const informe = await deltasNew(base, T1);
    expect(informe.opcionesReconciliadas).toBe(1);
    expect(sinCalidad(base)).toBeUndefined();
    expect(conHd(base)).toMatchObject({
      priceAmount: "7.99",
      firstSeenAt: T0.toISOString(),
    });
  });

  it("y resuelve después lo que updated dejó: la NULL que updated conservó se colapsa", async () => {
    const base = await conSinCalidad();
    await observarUpdated(base, T1, [pagina("updated", [HD])]);
    expect(opcionesDe(base)).toHaveLength(2);
    const informe = await deltasNew(base, T2);
    expect(informe.opcionesReconciliadas).toBe(1);
    expect(opcionesDe(base).map((o) => o.quality)).toEqual(["hd"]);
    expect(conHd(base)?.firstSeenAt).toBe(T0.toISOString());
  });
});
