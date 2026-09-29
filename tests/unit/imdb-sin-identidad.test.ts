/**
 * Un show sin identidad no llega a la base (deuda de la medición de `updated`,
 * 2026-09-25: «Monstruos: La historia de Lyle y Erik Menendez» con
 * `imdbId: ""`).
 *
 * `imdb_id NOT NULL UNIQUE` no lo impedía: `""` no es `NULL`, y el primero
 * entraba. El segundo show sin identidad habría colisionado con él y se habría
 * escrito **encima**. Dos niveles:
 *
 *   · la capa anticorrupción (`normalizarImdbId`): ausente, `null`, `""` o
 *     solo espacios no es identidad, y el show no llega a `TituloCanonico`;
 *   · PostgreSQL (`external_titles_imdb_id_no_vacio`, migración 0004), que lo
 *     prueba `pnpm db:validate:behavior` contra Neon.
 *
 * La semántica no es nueva: sus avisos quedan **sin show**, como si el
 * proveedor no lo hubiera mandado, y cada pipeline hace con ellos lo que ya
 * hacía (`avisosSinShow`).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  adaptadorStreamingAvailability,
  normalizarImdbId,
  normalizarShow,
} from "../../jobs/adapters/streaming-availability/normalizar.ts";
import { normalizarPaginaDeCambios } from "../../jobs/adapters/streaming-availability/normalizar-cambios.ts";
import {
  respuestaCambiosProveedor,
  showProveedor,
} from "../../jobs/adapters/streaming-availability/schema.ts";
import type { TipoDeCambio } from "../../jobs/adapters/contracts.ts";
import { ejecutarDeltas } from "../../jobs/pipelines/deltas/index.ts";
import { estrategiaDeDeltas } from "../../jobs/pipelines/deltas/job.ts";
import type { EstrategiaDeVentana } from "../../jobs/pipelines/deltas/job.ts";
import { estrategiaDeExpiring } from "../../jobs/pipelines/expiring/job.ts";
import { leerCorpusSpike1 } from "../../jobs/pipelines/seed/origen.ts";
import { estrategiaDeUpcoming } from "../../jobs/pipelines/upcoming/job.ts";
import { estrategiaDeUpdated } from "../../jobs/pipelines/updated/job.ts";
import {
  crearEjecutorFalso,
  crearTransporteFalso,
  filasInsertadas,
  respuestaCruda,
  showCrudo,
} from "./ayudas-deltas.ts";
import { foto, observarUpdated, sembrar } from "./ayudas-updated.ts";
import { crearBaseEnMemoria } from "./base-en-memoria.ts";

const T = new Date("2026-09-25T15:00:00.000Z");
const seg = (d: Date) => Math.floor(d.getTime() / 1000);
const HORA = 3_600_000;

const VALIDO = "tt0000101";

/** Un show con todo lo que se podría escribir: ofertas, imágenes y géneros. */
function showCompleto(id: string, imdbId: unknown): Record<string, unknown> {
  return {
    ...showCrudo({
      id,
      imdbId: "",
      opciones: [
        {
          service: "netflix",
          type: "subscription",
          link: `https://netflix.test/${id}`,
          quality: "hd",
          availableSince: seg(T) - 3600,
          expiresOn: seg(T) + 10 * 86_400,
        },
      ],
    }),
    imdbId,
    imageSet: {
      verticalPoster: { w240: `https://img.test/${id}/v240.jpg` },
      horizontalBackdrop: { w1080: `https://img.test/${id}/h1080.jpg` },
    },
  };
}

/** Sin la clave `imdbId`: el proveedor podría no mandarla. */
function sinClave(id: string): Record<string, unknown> {
  const { imdbId: _descartado, ...resto } = showCompleto(id, "x");
  return resto;
}

// ── 1 · La capa anticorrupción ──────────────────────────────────────────────

describe("normalizarImdbId: undefined / null / '' / '   ' no son identidad", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["vacío", ""],
    ["un espacio", " "],
    ["solo espacios", "   "],
    ["tabuladores y saltos", "\t\n "],
  ])("%s → null", (_nombre, valor) => {
    expect(normalizarImdbId(valor)).toBeNull();
  });

  it("un IMDb normal pasa tal cual", () => {
    expect(normalizarImdbId(VALIDO)).toBe(VALIDO);
  });

  it("recorta antes de validar, y lo que sobrevive sale recortado", () => {
    expect(normalizarImdbId(`  ${VALIDO} `)).toBe(VALIDO);
  });

  it("no exige el formato tt…: el contrato solo pide que la identidad exista", () => {
    expect(normalizarImdbId("nm123")).toBe("nm123");
  });
});

describe("normalizarShow sin identidad", () => {
  it.each([
    ["imdbId: ''", showCompleto("1", "")],
    ["imdbId: ' '", showCompleto("2", " ")],
    ["imdbId: tabuladores", showCompleto("5", "\t\t")],
    ["imdbId: saltos de línea", showCompleto("6", "\r\n \n")],
    ["imdbId: null", showCompleto("3", null)],
    ["sin la clave imdbId", sinClave("4")],
  ])("%s: el schema lo acepta y la normalización devuelve null", (_nombre, crudo) => {
    // Aceptarlo en el schema es lo que evita tumbar la página entera.
    const validado = showProveedor.parse(crudo);
    expect(normalizarShow(validado, "es")).toBeNull();
  });

  it("un IMDb válido sigue produciendo el título, con su disponibilidad", () => {
    const titulo = normalizarShow(showProveedor.parse(showCompleto("5", VALIDO)), "es");
    expect(titulo?.ids.imdbId).toBe(VALIDO);
    expect(titulo?.disponibilidad).toHaveLength(1);
    expect(titulo?.imagenes).toHaveLength(2);
    expect(titulo?.generos).toEqual([{ id: "drama", nombre: "Drama" }]);
  });

  it("un IMDb con espacios alrededor se guarda recortado", () => {
    const titulo = normalizarShow(
      showProveedor.parse(showCompleto("6", ` ${VALIDO}  `)),
      "es",
    );
    expect(titulo?.ids.imdbId).toBe(VALIDO);
  });
});

describe("normalizarPaginaDeCambios y el adaptador de búsqueda", () => {
  const cruda = respuestaCruda({
    cambios: ["1", "2", "3"].map((showId) => ({
      changeType: "new",
      showId,
      service: "netflix",
      type: "subscription",
      link: `https://netflix.test/${showId}`,
      timestamp: seg(T) - 3600,
    })),
    shows: [showCompleto("1", VALIDO), showCompleto("2", ""), showCompleto("3", "   ")],
  });

  it("los shows sin identidad no entran en `titulos` y quedan nombrados aparte", () => {
    const pagina = normalizarPaginaDeCambios(
      respuestaCambiosProveedor.parse(cruda),
      "es",
    );
    expect([...pagina.titulos.keys()]).toEqual(["1"]);
    expect([...pagina.showsSinIdentidad].sort()).toEqual(["2", "3"]);
    // Los avisos se conservan todos: quien decide qué hacer con ellos es el
    // pipeline, no la traducción.
    expect(pagina.avisos).toHaveLength(3);
  });

  it("el adaptador de búsqueda los omite", () => {
    const titulos = adaptadorStreamingAvailability.normalizar(
      { shows: [showCompleto("1", VALIDO), showCompleto("2", ""), sinClave("3")] },
      "es",
    );
    expect(titulos.map((t) => t.ids.imdbId)).toEqual([VALIDO]);
  });
});

// ── 2 · El seed: agrupaba por imdbId, y dos vacíos se habrían fundido ───────

describe("el seed no agrupa shows sin identidad", () => {
  it("dos shows sin IMDb no se funden en un título: no entra ninguno, y se cuentan", () => {
    const raiz = mkdtempSync(join(tmpdir(), "seed-sin-identidad-"));
    try {
      mkdirSync(join(raiz, "raw"));
      writeFileSync(
        join(raiz, "manifest.json"),
        JSON.stringify({ llamadas: [{ slug: "A-netflix", ts_utc: T.toISOString() }] }),
      );
      writeFileSync(
        join(raiz, "raw", "001-A-netflix.json"),
        JSON.stringify({
          meta: {},
          body: {
            shows: [
              showCompleto("1", VALIDO),
              showCompleto("2", ""),
              showCompleto("3", " "),
            ],
          },
        }),
      );

      const corpus = leerCorpusSpike1(raiz);
      expect(corpus.titulos.map((t) => t.titulo.ids.imdbId)).toEqual([VALIDO]);
      expect(corpus.diagnostico.showsBrutos).toBe(3);
      expect(corpus.diagnostico.showsRechazadosPorSchema).toBe(0);
      expect(corpus.diagnostico.showsSinIdentidad).toBe(2);
      expect(corpus.diagnostico.titulosUnicos).toBe(1);
      expect(corpus.diagnostico.opcionesEs).toBe(1);
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });
});

// ── 3 · El núcleo común, con las opciones de cada pipeline ──────────────────

type Estrategia = EstrategiaDeVentana<never>;

const PIPELINES: readonly {
  readonly nombre: string;
  readonly tipo: TipoDeCambio;
  readonly estrategia: Pick<
    Estrategia,
    | "interpretarAusencias"
    | "soloTitulosConocidos"
    | "detallarOfertas"
    | "reconciliarCalidadDesconocida"
  >;
  /** El `timestamp` del aviso: pasado en `new`/`updated`, futuro en el horizonte. */
  readonly instante: Date;
}[] = [
  {
    nombre: "deltas",
    tipo: "new",
    estrategia: estrategiaDeDeltas("prohibido"),
    instante: new Date(T.getTime() - HORA),
  },
  {
    nombre: "expiring",
    tipo: "expiring",
    estrategia: estrategiaDeExpiring(),
    instante: new Date(T.getTime() + 10 * 24 * HORA),
  },
  {
    nombre: "upcoming",
    tipo: "upcoming",
    estrategia: estrategiaDeUpcoming(),
    instante: new Date(T.getTime() + 5 * 24 * HORA),
  },
  {
    nombre: "updated",
    tipo: "updated",
    estrategia: estrategiaDeUpdated("prohibido"),
    instante: new Date(T.getTime() - HORA),
  },
];

/** Una página con un aviso por show, del tipo del pipeline. */
function pagina(
  tipo: TipoDeCambio,
  instante: Date,
  shows: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return respuestaCruda({
    cambios: shows.map((s) => ({
      changeType: tipo,
      showId: String(s.id),
      service: "netflix",
      type: "subscription",
      link: `https://netflix.test/${String(s.id)}`,
      timestamp: seg(instante),
    })),
    shows,
  });
}

async function correr(
  p: (typeof PIPELINES)[number],
  shows: readonly Record<string, unknown>[],
) {
  const falso = crearEjecutorFalso();
  const red = crearTransporteFalso([pagina(p.tipo, p.instante, shows)]);
  const e = p.estrategia;
  const informe = await ejecutarDeltas({
    ejecutor: falso.ejecutor,
    peticion: { transporte: red.transporte, apiKey: "k" },
    tipos: [p.tipo],
    ventana: null,
    ahora: T,
    maximoDePaginas: 10,
    interpretarAusencias: e.interpretarAusencias,
    ...(e.soloTitulosConocidos === true ? { soloTitulosConocidos: true } : {}),
    ...(e.detallarOfertas === true ? { detallarOfertas: true } : {}),
    ...(e.reconciliarCalidadDesconocida === false
      ? { reconciliarCalidadDesconocida: false }
      : {}),
  });
  return { informe, falso };
}

describe.each(PIPELINES)("regresión de $nombre con shows sin IMDb", (p) => {
  // El seed sella `updated_at` con el reloj: se congela para que dos pasadas
  // sean comparables valor a valor. Solo `Date`; las promesas siguen reales.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const limpio = [showCompleto("1", VALIDO)];
  const blancos = ["", " ", "\t\t", "\r\n \n"];
  const contaminado = [
    showCompleto("1", VALIDO),
    showCompleto("2", ""),
    showCompleto("3", " "),
    showCompleto("4", "\t\t"),
    showCompleto("5", "\r\n \n"),
  ];

  it("no escribe NADA de ellos: la misma secuencia SQL, sentencia a sentencia y valor a valor", async () => {
    const base = await correr(p, limpio);
    const conSinIdentidad = await correr(p, contaminado);
    // Ni título, ni ofertas, ni opciones, ni imágenes, ni géneros, ni anuncios,
    // ni eventos; y tampoco una lectura del estado anterior con `""` dentro.
    expect(conSinIdentidad.falso.sentencias).toEqual(base.falso.sentencias);
    for (const s of conSinIdentidad.falso.sentencias) {
      for (const b of blancos) expect(s.valores.flat()).not.toContain(b);
    }
  });

  it("los cuenta como avisos sin show, y dice por qué", async () => {
    const { informe } = await correr(p, contaminado);
    expect(informe.avisos).toBe(5);
    expect(informe.avisosSinShow).toBe(4);
    expect(informe.avisosSinIdentidad).toBe(4);
    expect(informe.titulosTocados).toBe(1);
  });

  it("un IMDb válido sigue funcionando igual que antes", async () => {
    const { informe, falso } = await correr(p, limpio);
    expect(informe.avisosSinShow).toBe(0);
    expect(informe.avisosSinIdentidad).toBe(0);
    const titulos = filasInsertadas(falso.sentencias, "external_titles");
    // `updated` solo toca títulos que ya están en la base, y aquí no hay
    // ninguno: no escribe. Los demás construyen catálogo con lo observado.
    expect(titulos.map((t) => t.imdb_id)).toEqual(
      p.nombre === "updated" ? [] : [VALIDO],
    );
  });

  it("dos shows sin IMDb no pueden colisionar en external_titles: no entra ninguno", async () => {
    const { falso, informe } = await correr(p, [
      showCompleto("2", ""),
      showCompleto("3", ""),
    ]);
    expect(filasInsertadas(falso.sentencias, "external_titles")).toEqual([]);
    for (const tabla of [
      "external_title_images",
      "external_title_genres",
      "external_availability",
      "external_availability_options",
      "external_availability_announcements",
      "external_availability_events",
    ]) {
      expect(filasInsertadas(falso.sentencias, tabla)).toEqual([]);
    }
    expect(informe.avisosSinIdentidad).toBe(2);
  });
});

// ── 4 · `updated`, con estado: el aviso queda clasificado `sin_show` ────────

describe("updated: un show sin IMDb sobre un catálogo conocido", () => {
  it("clasifica su aviso como sin_show y no toca la base", async () => {
    const base = crearBaseEnMemoria();
    await sembrar(base, new Date(T.getTime() - 24 * HORA), [showCompleto("1", VALIDO)]);
    const antes = foto(base, false);

    const { informe, clasificacion } = await observarUpdated(base, T, [
      pagina("updated", new Date(T.getTime() - HORA), [
        showCompleto("2", ""),
        showCompleto("3", "   "),
      ]),
    ]);

    expect(informe.avisosSinShow).toBe(2);
    expect(informe.avisosSinIdentidad).toBe(2);
    expect(clasificacion.porResultado.sin_show).toBe(2);
    expect(foto(base, false)).toEqual(antes);
  });
});
