/**
 * La frontera entre el transporte y el parser.
 *
 * ── El defecto que este fichero existe para impedir ─────────────────────────
 *
 * `crearTransporte` devuelve una `Response`. El harness hace
 * `await respuesta.json()` y se lo pasa a `respuestaCambiosProveedor.parse`,
 * así que **lo que llega al Zod es el cuerpo HTTP entero, tal y como lo emite
 * la API**.
 *
 * El schema, en cambio, se escribió mirando los ficheros de `spike-1/raw/`,
 * que NO son respuestas de la API: son lo que grabó `spike-1/probe.mjs`, que
 * escribe `{ meta: <sus propios metadatos>, body: <la respuesta> }`. El
 * `{meta, body}` es el envoltorio **del grabador**, no del proveedor.
 *
 * Resultado en la primera ejecución real: `ZodError` en `path: body`,
 * «expected object, received undefined», tras haber gastado una request.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { respuestaCambiosProveedor } from "../../jobs/adapters/streaming-availability/schema.ts";
import { normalizarPaginaDeCambios } from "../../jobs/adapters/streaming-availability/normalizar-cambios.ts";

const RAIZ_CRUDA = join(import.meta.dirname, "..", "..", "spike-1", "raw");
const hayCrudo = existsSync(RAIZ_CRUDA);

/**
 * Lo que de verdad devolvió la API aquel día.
 *
 * El fichero del Spike es **nuestro formato**, no el del proveedor: su `body`
 * es la respuesta HTTP completa. Desenvolverlo aquí es lo que hace que el
 * fixture represente lo que el transporte va a entregar.
 */
function respuestaRealDeLaApi(fichero: string): unknown {
  const guardado = JSON.parse(readFileSync(join(RAIZ_CRUDA, fichero), "utf8")) as {
    body: unknown;
  };
  return guardado.body;
}

describe.skipIf(!hayCrudo)("lo que el transporte entrega al parser", () => {
  it("el cuerpo HTTP trae changes y shows en la RAÍZ, sin `body`", async () => {
    // Se reconstruye la frontera exacta: una Response como la que devuelve
    // `crearTransporte`, y el `.json()` que hace el harness.
    const cuerpoHttp = respuestaRealDeLaApi("023-C-changes-expiring.json");
    const respuesta = new Response(JSON.stringify(cuerpoHttp), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const crudo = (await respuesta.json()) as Record<string, unknown>;

    // Esto es lo que la API emite de verdad.
    expect(Object.keys(crudo).sort()).toEqual([
      "changes",
      "hasMore",
      "nextCursor",
      "shows",
    ]);
    // Y esto es lo que el schema esperaba encontrar, y no está.
    expect(crudo.body).toBeUndefined();
  });

  it("el schema acepta la respuesta real de la API", async () => {
    // Con el schema equivocado esto lanzaba:
    //   ZodError · path: body · expected object, received undefined
    const cuerpoHttp = respuestaRealDeLaApi("023-C-changes-expiring.json");
    const respuesta = new Response(JSON.stringify(cuerpoHttp), { status: 200 });
    const crudo: unknown = await respuesta.json();

    const analizada = respuestaCambiosProveedor.parse(crudo);
    expect(analizada.changes).toHaveLength(25);
    expect(Object.keys(analizada.shows)).toHaveLength(25);
    expect(analizada.hasMore).toBe(true);
  });

  it("y la normalización funciona sobre esa misma forma", async () => {
    const cuerpoHttp = respuestaRealDeLaApi("018-C-changes-new-sinventana.json");
    const respuesta = new Response(JSON.stringify(cuerpoHttp), { status: 200 });
    const crudo: unknown = await respuesta.json();

    const pagina = normalizarPaginaDeCambios(
      respuestaCambiosProveedor.parse(crudo),
      "es",
    );
    expect(pagina.avisos).toHaveLength(25);
    expect(pagina.titulos.size).toBe(21);
    expect(pagina.cursorSiguiente).toBe("1787578334:2787037446");
  });

  it("el envoltorio del grabador NO se acepta: no es una respuesta de la API", () => {
    // Si algún día alguien vuelve a alimentar el parser con el fichero entero,
    // tiene que romper aquí y no en producción tras gastar una request.
    const ficheroEntero: unknown = JSON.parse(
      readFileSync(join(RAIZ_CRUDA, "023-C-changes-expiring.json"), "utf8"),
    );
    expect(respuestaCambiosProveedor.safeParse(ficheroEntero).success).toBe(false);
  });
});
