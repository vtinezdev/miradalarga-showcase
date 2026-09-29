/**
 * **La fuente real de páginas del seed**: `GET /shows/search/filters` del
 * proveedor, para la sonda (M1) y la captura.
 *
 * **No llama a `fetch`.** Construye el transporte con la `FuenteDeCuota` que
 * le da el motor, y `transporte.ts` —el único punto de `jobs/**` que sale a la
 * red— reserva **antes** de llamar y corta a los 30 s. La credencial viaja en
 * `X-API-Key`, nunca en la URL: la query que se guarda en el manifiesto es la
 * misma que viaja, y no lleva secretos.
 *
 * El cuerpo se devuelve **exacto** (`arrayBuffer`), sin interpretarlo: el motor
 * lo escribe en el crudo antes de leerlo.
 */
import type { FuenteDeCuota, Transporte } from "../../ops/transporte.ts";
import { crearTransporte } from "../../ops/transporte.ts";
import { BASE_POR_DEFECTO } from "../deltas/origen.ts";
import type { FuenteDePaginas, PeticionDePagina } from "./captura.ts";

export const RUTA_DE_BUSQUEDA = "/shows/search/filters";

/** La URL exacta de una página: la base del código y la query del plan. */
export function urlDePagina(
  base: string,
  query: Readonly<Record<string, string>>,
): string {
  const url = new URL(`${base.replace(/\/+$/, "")}${RUTA_DE_BUSQUEDA}`);
  for (const [clave, valor] of Object.entries(query))
    url.searchParams.set(clave, valor);
  return url.toString();
}

export function crearFuenteReal(opciones: {
  readonly apiKey: string;
  readonly base?: string;
  /** Por defecto, `crearTransporte`. Los tests inyectan uno sin red. */
  readonly crearLlamada?: (fuente: FuenteDeCuota) => Transporte;
}): FuenteDePaginas {
  const base = opciones.base ?? BASE_POR_DEFECTO;
  const crearLlamada = opciones.crearLlamada ?? crearTransporte;
  if (opciones.apiKey.trim() === "") throw new Error("Falta la credencial de la API.");
  return async (peticion: PeticionDePagina, cuota: FuenteDeCuota) => {
    const llamar = crearLlamada(cuota);
    const respuesta = await llamar(urlDePagina(base, peticion.query), {
      headers: { "X-API-Key": opciones.apiKey, Accept: "application/json" },
    });
    const cuerpo = new Uint8Array(await respuesta.arrayBuffer());
    const cabeceras: Record<string, string> = {};
    respuesta.headers.forEach((valor, clave) => {
      cabeceras[clave.toLowerCase()] = valor;
    });
    return { status: respuesta.status, cuerpo, cabeceras };
  };
}
