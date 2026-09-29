import { crearLectorHttp } from "@/db/queries/lector.ts";
import { ErrorDeCatalogo } from "@/db/queries/errores.ts";
import { crearRepositorioNeon } from "@/db/queries/repositorio-neon.ts";
import { INDEXABLE } from "@/lib/sitio.ts";
import { crearRepositorioDeDesarrollo } from "./desarrollo/repositorio-de-desarrollo.ts";
import type { RepositorioDeCatalogo } from "./repositorio.ts";

/**
 * El único sitio que decide de dónde leen las pantallas.
 *
 * `CATALOGO_FUENTE` elige, **explícitamente y sin respaldo**:
 *
 * - `desarrollo` (o ausente): datos ficticios en memoria
 *   (`desarrollo/`). Es lo que usan `pnpm dev`, los tests y el build del CI,
 *   y el pie lo dice. Ausente equivale a `desarrollo` **solo mientras el
 *   sitio no sea indexable**: con `INDEXABLE`, publicar datos ficticios es un
 *   error de configuración.
 * - `neon`: el catálogo real (`src/db/queries/`), con `DATABASE_URL` del
 *   usuario de **solo lectura** del runtime (CLAUDE.md, regla 8).
 *
 * **Fail closed.** Un valor desconocido, `neon` sin `DATABASE_URL`, o `neon`
 * en un entorno que lleva credenciales de los jobs, se niegan antes de
 * conectar. Y si Neon falla en una petición, **falla la petición**: nunca se
 * cae en silencio a los datos de desarrollo, que ocultaría el error.
 *
 * El repositorio es inmutable y sin estado por petición, así que compartir la
 * instancia entre peticiones es seguro. `docs/NEON-ADAPTER.md` §6.
 */
export type FuenteDelCatalogo = "desarrollo" | "neon";

/**
 * Variables que **nunca** deben llegar al runtime de la web (docs/SECURITY.md):
 * la credencial de la API y las cadenas directas de migración de los jobs.
 * Con cualquiera presente, Neon no arranca: la regla 1 descansa en que la web
 * no tiene credenciales externas.
 */
const CREDENCIALES_DE_JOBS = [
  "STREAMING_AVAILABILITY_API_KEY",
  "DATABASE_URL_DIRECT",
  "PRODUCTION_DATABASE_URL_DIRECT",
] as const;

type Entorno = Readonly<Record<string, string | undefined>>;

export function fuenteDelCatalogo(
  entorno: Entorno = process.env,
  indexable: boolean = INDEXABLE,
): FuenteDelCatalogo {
  const valor = entorno.CATALOGO_FUENTE?.trim();
  if (valor === undefined || valor === "" || valor === "desarrollo") {
    if (indexable) {
      throw new ErrorDeCatalogo(
        "configuracion",
        "proveedor",
        "el sitio es indexable y la fuente es de desarrollo: CATALOGO_FUENTE=neon.",
      );
    }
    return "desarrollo";
  }
  if (valor === "neon") return "neon";
  throw new ErrorDeCatalogo(
    "configuracion",
    "proveedor",
    "CATALOGO_FUENTE solo admite «desarrollo» o «neon».",
  );
}

export function crearRepositorio(
  entorno: Entorno = process.env,
): RepositorioDeCatalogo {
  if (fuenteDelCatalogo(entorno) === "desarrollo")
    return crearRepositorioDeDesarrollo();
  const presentes = CREDENCIALES_DE_JOBS.filter((n) => entorno[n]);
  if (presentes.length > 0) {
    throw new ErrorDeCatalogo(
      "configuracion",
      "proveedor",
      `el entorno de la web lleva credenciales de los jobs (${presentes.join(", ")}): no se conecta.`,
    );
  }
  return crearRepositorioNeon(crearLectorHttp(entorno.DATABASE_URL ?? ""));
}

let instancia: RepositorioDeCatalogo | undefined;

export function repositorio(): RepositorioDeCatalogo {
  instancia ??= crearRepositorio();
  return instancia;
}

/** Con el adaptador de desarrollo, el pie lo dice: nada de lo que se ve es real. */
export function datosDeDesarrollo(): boolean {
  return fuenteDelCatalogo() === "desarrollo";
}
