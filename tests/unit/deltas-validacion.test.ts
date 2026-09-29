/**
 * El plan y los veredictos de la validación real, probados **sin gastar nada**.
 *
 * Lo que más importa aquí no es que el plan funcione, sino que **no pueda
 * pasarse de 5 requests** y que un silencio no se convierta en un aprobado.
 */
import { describe, expect, it } from "vitest";

import { TOPE_POR_EJECUCION_POR_DEFECTO } from "../../jobs/ops/presupuesto.ts";

import type { RespuestaCambiosProveedor } from "../../jobs/adapters/streaming-availability/schema.ts";
import {
  MAXIMO_DE_REQUESTS,
  analizarPagina,
  contrastarExpiracion,
  evaluarPremisas,
  siguientePaso,
} from "../../jobs/pipelines/deltas/validacion.ts";
import type {
  ObservacionDePagina,
  PasoDeValidacion,
} from "../../jobs/pipelines/deltas/validacion.ts";

function observacion(parcial: Partial<ObservacionDePagina> = {}): ObservacionDePagina {
  return {
    tipo: "expiring",
    pagina: 1,
    cursorEnviado: null,
    resultCount: 25,
    hasMore: true,
    cursorRecibido: "c1",
    numeroDeCambios: 25,
    numeroDeShows: 25,
    showIdsSinResolver: [],
    showIdsSobrantes: [],
    huella: "pagina-1",
    contrastes: [],
    contrastablesDescartados: 0,
    ...parcial,
  };
}

/** Recorre el plan entero simulando respuestas siempre con más páginas. */
function recorrerPlan(hasMore = true): readonly PasoDeValidacion[] {
  const pasos: PasoDeValidacion[] = [];
  const observadas: ObservacionDePagina[] = [];

  for (;;) {
    const paso = siguientePaso(observadas);
    if (paso === null) break;
    pasos.push(paso);
    observadas.push(
      observacion({
        tipo: paso.tipo,
        pagina: paso.pagina,
        cursorEnviado: paso.cursor,
        hasMore,
        cursorRecibido: hasMore ? `${paso.tipo}-${String(paso.pagina)}` : null,
        huella: `${paso.tipo}-${String(paso.pagina)}`,
      }),
    );
  }
  return pasos;
}

describe("el plan no puede pasarse del tope", () => {
  it("nunca pide más de 5 páginas, ni aunque siempre haya más", () => {
    const pasos = recorrerPlan(true);
    expect(pasos).toHaveLength(MAXIMO_DE_REQUESTS);
    expect(MAXIMO_DE_REQUESTS).toBe(5);
  });

  it("cierra el plan en cuanto se alcanzan 5 observaciones", () => {
    const cinco = Array.from({ length: 5 }, (_, i) =>
      observacion({ pagina: i + 1, huella: String(i) }),
    );
    expect(siguientePaso(cinco)).toBeNull();
  });

  it("primero dos páginas de cada lista, y solo después profundidad", () => {
    const pasos = recorrerPlan(true);
    expect(pasos.map((p) => `${p.tipo}:${String(p.pagina)}`)).toEqual([
      "expiring:1",
      "expiring:2",
      "upcoming:1",
      "upcoming:2",
      "expiring:3",
    ]);
  });

  it("la página 2 viaja con el cursor que devolvió la 1", () => {
    const pasos = recorrerPlan(true);
    expect(pasos[1]?.cursor).toBe("expiring-1");
    expect(pasos[0]?.cursor).toBeNull();
  });

  it("no gasta una request en confirmar el final de una lista", () => {
    // Sin `hasMore` no hay página 2: confirmar un final no prueba nada.
    const pasos = recorrerPlan(false);
    expect(pasos.map((p) => `${p.tipo}:${String(p.pagina)}`)).toEqual([
      "expiring:1",
      "upcoming:1",
    ]);
  });

  it("tampoco la gasta si dicen que hay más pero no dan cursor", () => {
    const observadas = [observacion({ hasMore: true, cursorRecibido: null })];
    expect(siguientePaso(observadas)?.tipo).toBe("upcoming");
  });
});

describe("un silencio no es un aprobado", () => {
  it("sin ninguna página 2, las premisas 1 y 2 quedan SIN DATOS", () => {
    const veredictos = evaluarPremisas([observacion({ hasMore: false })]);
    expect(veredictos[0]?.estado).toBe("sin_datos");
    expect(veredictos[1]?.estado).toBe("sin_datos");
  });

  it("sin ninguna observación, nada se da por bueno", () => {
    const veredictos = evaluarPremisas([]);
    expect(veredictos.every((v) => v.estado === "sin_datos")).toBe(true);
  });

  it("sin pares contrastables, la premisa 5 no aprueba", () => {
    const veredictos = evaluarPremisas([observacion({ contrastablesDescartados: 25 })]);
    expect(veredictos[4]?.estado).toBe("sin_datos");
    expect(veredictos[4]?.detalle).toContain("25");
  });
});

describe("el cursor ignorado se detecta", () => {
  it("una página 2 idéntica a la 1 es un FALLO, no un éxito", () => {
    // Si el proveedor ignorara `cursor`, devolvería la primera página otra
    // vez: sin esta comprobación lo leeríamos como paginación correcta.
    const veredictos = evaluarPremisas([
      observacion({ pagina: 1, huella: "misma" }),
      observacion({ pagina: 2, huella: "misma", cursorEnviado: "c1" }),
    ]);
    expect(veredictos[0]?.estado).toBe("fallo");
    expect(veredictos[0]?.detalle).toContain("ignorado");
  });

  it("una página 2 con avisos distintos aprueba", () => {
    const veredictos = evaluarPremisas([
      observacion({ pagina: 1, huella: "a" }),
      observacion({ pagina: 2, huella: "b", cursorEnviado: "c1" }),
    ]);
    expect(veredictos[0]?.estado).toBe("ok");
  });

  it("un showId sin su show en la página 2 falsa la premisa 2", () => {
    const veredictos = evaluarPremisas([
      observacion({ pagina: 1, huella: "a" }),
      observacion({ pagina: 2, huella: "b", showIdsSinResolver: ["999"] }),
    ]);
    expect(veredictos[1]?.estado).toBe("fallo");
  });
});

describe("la profundidad se comunica como MÍNIMO", () => {
  it("con hasMore, la cifra no se presenta como total", () => {
    const veredictos = evaluarPremisas([
      observacion({ tipo: "expiring", hasMore: true }),
    ]);
    expect(veredictos[3]?.detalle).toContain(">=");
    expect(veredictos[3]?.detalle).toContain("MÍNIMO");
  });

  it("sin hasMore sí se declara agotada", () => {
    const veredictos = evaluarPremisas([
      observacion({ tipo: "expiring", hasMore: false, cursorRecibido: null }),
    ]);
    expect(veredictos[3]?.detalle).toContain("agotada");
  });
});

// ── El contraste de expiración ──────────────────────────────────────────────

function respuestaConExpiring(entrada: {
  readonly timestamp: number;
  readonly expiresOn?: number;
}): RespuestaCambiosProveedor {
  const link = "https://netflix.test/1";
  return respuestaCambiosProveedorDe({
    changes: [
      {
        changeType: "expiring",
        itemType: "show",
        showId: "1",
        showType: "movie",
        service: { id: "netflix", name: "Netflix" },
        streamingOptionType: "subscription",
        link,
        timestamp: entrada.timestamp,
      },
    ],
    shows: {
      "1": {
        itemType: "show",
        showType: "movie",
        id: "1",
        imdbId: "tt1",
        title: "Prueba",
        streamingOptions: {
          es: [
            {
              service: { id: "netflix", name: "Netflix" },
              type: "subscription",
              link,
              audios: [],
              subtitles: [],
              ...(entrada.expiresOn === undefined
                ? {}
                : { expiresOn: entrada.expiresOn }),
            },
          ],
        },
      },
    },
  });
}

function respuestaCambiosProveedorDe(cuerpo: unknown): RespuestaCambiosProveedor {
  return cuerpo as RespuestaCambiosProveedor;
}

describe("timestamp de expiring contra expiresOn", () => {
  it("cuando coinciden al segundo, la premisa se sostiene", () => {
    const { contrastes, descartados } = contrastarExpiracion(
      respuestaConExpiring({ timestamp: 1790027999, expiresOn: 1790027999 }),
    );
    expect(contrastes).toHaveLength(1);
    expect(contrastes[0]?.coinciden).toBe(true);
    expect(descartados).toBe(0);
  });

  it("cuando no coinciden, lo dice con la diferencia exacta", () => {
    const { contrastes } = contrastarExpiracion(
      respuestaConExpiring({ timestamp: 1790027999, expiresOn: 1790020000 }),
    );
    expect(contrastes[0]?.coinciden).toBe(false);
    expect(contrastes[0]?.diferenciaSegundos).toBe(7999);

    const veredictos = evaluarPremisas([observacion({ contrastes })]);
    expect(veredictos[4]?.estado).toBe("fallo");
    expect(veredictos[4]?.detalle).toContain("7999");
  });

  it("sin expiresOn no cuenta como acierto NI como fallo", () => {
    // Que no conste no es un desacuerdo. Puntuarlo en cualquiera de los dos
    // sentidos sería inventar una medición.
    const { contrastes, descartados } = contrastarExpiracion(
      respuestaConExpiring({ timestamp: 1790027999 }),
    );
    expect(contrastes).toHaveLength(0);
    expect(descartados).toBe(1);
  });
});

describe("el análisis de una página", () => {
  it("cuenta shows sobrantes y sin resolver por separado", () => {
    const paso: PasoDeValidacion = { tipo: "expiring", pagina: 2, cursor: "c1" };
    const respuesta = respuestaCambiosProveedorDe({
      changes: [
        {
          changeType: "expiring",
          itemType: "show",
          showId: "SIN_SHOW",
          showType: "movie",
          service: { id: "netflix", name: "Netflix" },
          streamingOptionType: "subscription",
          timestamp: 1,
        },
      ],
      shows: {
        SOBRANTE: {
          itemType: "show",
          showType: "movie",
          id: "SOBRANTE",
          imdbId: "tt2",
        },
      },
      hasMore: false,
    });

    const observada = analizarPagina(paso, respuesta);
    expect(observada.showIdsSinResolver).toEqual(["SIN_SHOW"]);
    expect(observada.showIdsSobrantes).toEqual(["SOBRANTE"]);
    expect(observada.cursorEnviado).toBe("c1");
    expect(observada.hasMore).toBe(false);
  });
});

describe("los topes del repositorio siguen cerrados", () => {
  it("ningún pipeline está autorizado por defecto a gastar API, salvo deltas, expiring y upcoming", () => {
    // El harness inyecta su tope de 5 dentro de su propio proceso. Si alguien
    // «abriera un momento» los valores del repositorio, esto lo ve. Las únicas
    // excepciones aprobadas: `deltas` (4, Paso 5), `expiring` (12) y
    // `upcoming` (8), las dos del 2026-09-24.
    const aprobados: Readonly<Record<string, number>> = {
      deltas: 4,
      expiring: 12,
      upcoming: 8,
    };
    for (const [nombre, tope] of Object.entries(TOPE_POR_EJECUCION_POR_DEFECTO)) {
      const esperado = aprobados[nombre] ?? 0;
      expect(`${nombre}=${String(tope)}`).toBe(`${nombre}=${String(esperado)}`);
    }
  });

  it("el tope de esta validación es 5 y no se hereda de ningún sitio", () => {
    expect(MAXIMO_DE_REQUESTS).toBe(5);
    expect(TOPE_POR_EJECUCION_POR_DEFECTO.changes_validation).toBe(0);
  });
});

describe("un minimo medido NO es una medicion completa", () => {
  it("con hasMore en la ultima pagina, la premisa de volumen queda PARCIAL", () => {
    // 📏 Evidencia real: expiring y upcoming siguieron con hasMore=true en la
    // pagina 2. Son >50 avisos cada uno, pero el total no se ha agotado.
    const veredictos = evaluarPremisas([
      observacion({ tipo: "expiring", pagina: 1, huella: "e1" }),
      observacion({ tipo: "expiring", pagina: 2, huella: "e2", hasMore: true }),
    ]);
    expect(veredictos[3]?.estado).toBe("parcial");
    expect(veredictos[3]?.estado).not.toBe("ok");
  });

  it("solo se cierra como `ok` cuando la lista se agota de verdad", () => {
    const veredictos = evaluarPremisas([
      observacion({ tipo: "expiring", pagina: 1, huella: "e1" }),
      observacion({
        tipo: "expiring",
        pagina: 2,
        huella: "e2",
        hasMore: false,
        cursorRecibido: null,
      }),
    ]);
    expect(veredictos[3]?.estado).toBe("ok");
    expect(veredictos[3]?.detalle).toContain("agotada");
  });

  it("una lista agotada no tapa a otra que sigue teniendo cola", () => {
    const veredictos = evaluarPremisas([
      observacion({
        tipo: "expiring",
        pagina: 1,
        huella: "e1",
        hasMore: false,
        cursorRecibido: null,
      }),
      observacion({ tipo: "upcoming", pagina: 1, huella: "u1", hasMore: true }),
    ]);
    expect(veredictos[3]?.estado).toBe("parcial");
  });

  it("el detalle nunca presenta el minimo como si fuera el total", () => {
    const veredictos = evaluarPremisas([
      observacion({ tipo: "expiring", hasMore: true }),
    ]);
    expect(veredictos[3]?.detalle).toContain(">=");
    expect(veredictos[3]?.detalle).toContain("MÍNIMO");
  });
});
