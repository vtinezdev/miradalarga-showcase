/**
 * El digest y el *bucket*.
 *
 * La idempotencia del histórico depende por completo de que este hash sea
 * determinista: el único de `external_availability_events` lo lleva dentro.
 */
import { describe, expect, it } from "vitest";

import {
  bucketDelDia,
  calcularEventDigest,
  canonicalizar,
} from "../../jobs/pipelines/deltas/digest.ts";

describe("canonicalizar", () => {
  it("ordena las claves recursivamente", () => {
    const a = canonicalizar({ b: 1, a: { d: 2, c: 3 } });
    const b = canonicalizar({ a: { c: 3, d: 2 }, b: 1 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("conserva null y elimina undefined: no son lo mismo", () => {
    // `null` es «no lo sabemos» y es información (invariante 4). `undefined`
    // es una clave que no debería existir.
    expect(JSON.stringify(canonicalizar({ a: null, b: undefined }))).toBe('{"a":null}');
  });

  it("convierte las fechas a ISO", () => {
    const fecha = new Date("2026-09-22T10:00:00.000Z");
    expect(canonicalizar({ f: fecha })).toEqual({ f: "2026-09-22T10:00:00.000Z" });
  });

  it("respeta el orden de los arrays, que sí es significativo", () => {
    expect(canonicalizar([2, 1])).toEqual([2, 1]);
  });
});

describe("event_digest", () => {
  const antes = { opcionesActivas: 1, precio: { importe: "9.99", moneda: "EUR" } };

  it("el mismo contenido en distinto orden de claves da el mismo digest", () => {
    const uno = calcularEventDigest(["price", "quality"], antes, {
      precio: { importe: "5.99", moneda: "EUR" },
      opcionesActivas: 1,
    });
    const dos = calcularEventDigest(["price", "quality"], antes, {
      opcionesActivas: 1,
      precio: { moneda: "EUR", importe: "5.99" },
    });
    expect(uno).toBe(dos);
  });

  it("changed_fields en distinto orden da el mismo digest", () => {
    const uno = calcularEventDigest(["quality", "price"], antes, antes);
    const dos = calcularEventDigest(["price", "quality"], antes, antes);
    expect(uno).toBe(dos);
  });

  it("un contenido distinto da un digest distinto", () => {
    const uno = calcularEventDigest(["price"], antes, { opcionesActivas: 1 });
    const dos = calcularEventDigest(["price"], antes, { opcionesActivas: 2 });
    expect(uno).not.toBe(dos);
  });

  it("`null` en changed_fields no es lo mismo que la lista vacía", () => {
    expect(calcularEventDigest(null, antes, antes)).not.toBe(
      calcularEventDigest([], antes, antes),
    );
  });
});

describe("bucket de deduplicación", () => {
  it("dos instantes del mismo día de Madrid caen en el mismo bucket", () => {
    const manana = bucketDelDia(new Date("2026-09-22T06:00:00.000Z"));
    const noche = bucketDelDia(new Date("2026-09-22T21:00:00.000Z"));
    expect(manana.toISOString()).toBe(noche.toISOString());
  });

  it("la frontera es la medianoche de Madrid, no la de UTC", () => {
    // En septiembre Madrid va +2: las 23:30 UTC ya son el día siguiente allí.
    const antesDeMedianocheUtc = bucketDelDia(new Date("2026-09-22T23:30:00.000Z"));
    const yaDia23 = bucketDelDia(new Date("2026-09-23T05:00:00.000Z"));
    expect(antesDeMedianocheUtc.toISOString()).toBe(yaDia23.toISOString());
  });
});
