/**
 * Reconciliación de opciones provisionales.
 *
 * El caso que este fichero existe para impedir: `upcoming` escribe
 * `(link, quality=NULL)`, llega el `new` con `(link, quality=hd)`, y como la
 * clave natural es `(availability_id, link, quality)` con `NULLS NOT
 * DISTINCT`, **son dos filas distintas**. `ON CONFLICT` no lo resuelve porque
 * no hay conflicto: la provisional sobreviviría como fantasma.
 */
import { describe, expect, it } from "vitest";

import type {
  OpcionExistente,
  OpcionObservada,
} from "../../jobs/pipelines/deltas/contratos.ts";
import { compararEstados } from "../../jobs/pipelines/deltas/comparar.ts";
import { activas, agregar } from "../../jobs/pipelines/deltas/estado.ts";
import { planificarOpciones } from "../../jobs/pipelines/deltas/opciones.ts";

const AHORA = new Date("2026-09-22T10:00:00.000Z");
const ANUNCIADO_EL = new Date("2026-09-20T09:00:00.000Z");
const ESTRENO = new Date("2026-09-21T22:00:00.000Z");
const LINK = "https://netflix.test/title/123";

/** La opción provisional que deja un `upcoming`: sin calidad y sin precio. */
function provisional(parcial: Partial<OpcionExistente> = {}): OpcionExistente {
  return {
    id: "501",
    link: LINK,
    calidad: null,
    precio: null,
    idiomasAudio: [],
    idiomasSubtitulos: [],
    disponibleDesde: ESTRENO,
    expiraEl: null,
    vistaPrimeroEn: ANUNCIADO_EL,
    ausenciasSeguidas: 0,
    ...parcial,
  };
}

/** La opción real que trae el snapshot del `new`. */
function real(calidad: "sd" | "hd" | "uhd", link = LINK): OpcionObservada {
  return {
    link,
    calidad,
    precio: { importe: "0.00", moneda: "EUR" },
    idiomasAudio: ["spa"],
    idiomasSubtitulos: ["spa"],
    disponibleDesde: ESTRENO,
    expiraEl: null,
  };
}

function planDe(
  existentes: readonly OpcionExistente[],
  snapshot: readonly OpcionObservada[],
) {
  return planificarOpciones({
    existentes,
    snapshot,
    ahora: AHORA,
    retiradaExplicita: false,
    aplicarAusencias: snapshot.length > 0,
    observacionNueva: true,
  });
}

describe("provisional quality=NULL → snapshot con quality=hd", () => {
  const plan = planDe([provisional()], [real("hd")]);

  it("la provisional se retira: no sobrevive como duplicado", () => {
    expect(plan.aBorrar).toEqual(["501"]);
  });

  it("el estado nuevo tiene UNA sola opción, la real", () => {
    expect(plan.activasDespues).toHaveLength(1);
    expect(plan.activasDespues[0]?.calidad).toBe("hd");
  });

  it("hereda first_seen_at: la antigüedad no se reinicia", () => {
    expect(plan.herencias.get(LINK)?.toISOString()).toBe(ANUNCIADO_EL.toISOString());
  });

  it("NO se marca como ausente: se reconcilia, no se deja morir", () => {
    expect(plan.ausencias).toHaveLength(0);
  });

  it("el evento es `changed`, nunca `removed` + `added`", () => {
    const antes = agregar(
      activas([provisional()]).map((o) => ({
        link: o.link,
        calidad: o.calidad,
        precio: o.precio,
        idiomasAudio: o.idiomasAudio,
        idiomasSubtitulos: o.idiomasSubtitulos,
        disponibleDesde: o.disponibleDesde,
        expiraEl: o.expiraEl,
      })),
      AHORA,
    );
    const despues = agregar(plan.activasDespues, AHORA);
    const evento = compararEstados(antes, despues);

    expect(evento?.tipo).toBe("changed");
    expect(evento?.tipo).not.toBe("removed");
    expect(evento?.tipo).not.toBe("added");
    // El recuento de opciones activas no cambia: 1 antes, 1 después. La
    // oferta padre no se ha movido, y por eso no hay baja ni alta.
    expect(antes.opcionesActivas).toBe(1);
    expect(despues.opcionesActivas).toBe(1);
    expect(evento?.camposCambiados).not.toContain("options");
    expect(evento?.camposCambiados).toContain("quality");
  });
});

describe("snapshot con varias calidades para el mismo link", () => {
  // 📏 Prime vende sd, hd y uhd por un único deeplink: `link` y `quality` son
  // dimensiones independientes.
  const plan = planDe([provisional()], [real("sd"), real("hd"), real("uhd")]);

  it("la provisional se retira una sola vez", () => {
    expect(plan.aBorrar).toEqual(["501"]);
  });

  it("quedan las tres variantes reales y ninguna provisional", () => {
    expect(plan.activasDespues).toHaveLength(3);
    expect(plan.activasDespues.every((o) => o.calidad !== null)).toBe(true);
  });

  it("el evento es `changed` con `options`, no un par baja + alta", () => {
    const antes = agregar([{ ...provisional(), link: LINK }], AHORA);
    const despues = agregar(plan.activasDespues, AHORA);
    const evento = compararEstados(antes, despues);
    expect(evento?.tipo).toBe("changed");
    expect(evento?.camposCambiados).toContain("options");
  });
});

describe("los tres cerrojos de la regla", () => {
  it("NO borra en el sentido inverso: hd en base, NULL en el snapshot", () => {
    // Perder la calidad conocida por un hueco temporal de cobertura del
    // proveedor sería destruir dato. Lo gestiona missing_streak.
    const conCalidad = provisional({ id: "777", calidad: "hd" });
    const plan = planDe([conCalidad], [{ ...real("hd"), calidad: null }]);
    expect(plan.aBorrar).toHaveLength(0);
  });

  it("NO borra por simple ausencia: si el link no vuelve, solo suma ausencia", () => {
    const plan = planDe([provisional()], [real("hd", "https://netflix.test/OTRO")]);
    expect(plan.aBorrar).toHaveLength(0);
    expect(plan.ausencias).toEqual([{ id: "501", ausenciasSeguidas: 1 }]);
  });

  it("una opción real sin calidad NO se toca si sigue igual en el snapshot", () => {
    const plan = planDe(
      [provisional({ id: "888" })],
      [{ ...real("hd"), calidad: null }],
    );
    expect(plan.aBorrar).toHaveLength(0);
    expect(plan.presentes).toEqual(["888"]);
  });
});

describe("ausencias y retiradas", () => {
  it("una opción futura no acumula ausencia antes de su estreno", () => {
    // Sin esta regla todo anuncio moriría antes de estrenarse.
    const futura = provisional({ disponibleDesde: new Date("2026-10-01T00:00:00Z") });
    const plan = planificarOpciones({
      existentes: [futura],
      snapshot: [real("hd", "https://netflix.test/OTRO")],
      ahora: AHORA,
      retiradaExplicita: false,
      aplicarAusencias: true,
      observacionNueva: true,
    });
    expect(plan.ausencias).toHaveLength(0);
    expect(plan.activasDespues).toHaveLength(2);
  });

  it("un aviso `removed` retira de inmediato, sin esperar dos pasadas", () => {
    const plan = planificarOpciones({
      existentes: [provisional()],
      snapshot: [],
      ahora: AHORA,
      retiradaExplicita: true,
      aplicarAusencias: true,
      observacionNueva: true,
    });
    expect(plan.ausencias).toEqual([{ id: "501", ausenciasSeguidas: 2 }]);
    expect(plan.activasDespues).toHaveLength(0);
  });

  it("sin snapshot ni aviso de retirada no se toca nada", () => {
    // La ausencia solo significa algo si el proveedor habló de esta oferta.
    const plan = planificarOpciones({
      existentes: [provisional()],
      snapshot: [],
      ahora: AHORA,
      retiradaExplicita: false,
      aplicarAusencias: false,
      observacionNueva: true,
    });
    expect(plan.ausencias).toHaveLength(0);
    expect(plan.aBorrar).toHaveLength(0);
    expect(plan.activasDespues).toHaveLength(1);
  });
});
