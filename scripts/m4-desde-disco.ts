/**
 * **M4 desde disco**: el crudo del seed y los crudos del primer `deltas`
 * (`.deltas-runs/…/manifiesto.json` y sus respuestas). Lo usan `seed:m4`, que
 * lo calcula y lo guarda, y la compuerta de `production`, que **lo vuelve a
 * calcular** en lugar de fiarse del informe guardado. **0 API, sin base.**
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { ContenidoDelCrudo } from "../jobs/pipelines/seed/crudo/disco.ts";
import { leerDirectorioDelCrudo } from "../jobs/pipelines/seed/crudo/disco.ts";
import type { CrudoVerificado } from "../jobs/pipelines/seed/crudo/verificar.ts";
import { verificarCrudo } from "../jobs/pipelines/seed/crudo/verificar.ts";
import type { AvisoParaM4, InformeM4 } from "../jobs/pipelines/seed/m4.ts";
import {
  analizarM4,
  avisosDesdeRespuestas,
  paginasDelCrudo,
} from "../jobs/pipelines/seed/m4.ts";

interface ManifiestoDeDeltas {
  readonly pipeline?: string;
  readonly ventana?: unknown;
  readonly respuestas?: readonly {
    readonly fichero: string;
    readonly status: number;
  }[];
}

export interface M4DeDisco {
  readonly crudo: CrudoVerificado;
  readonly informe: InformeM4;
  readonly ventanas: readonly unknown[];
}

/** Lanza si el crudo no verifica o algún directorio de `deltas` no se puede leer. */
export function m4DesdeDisco(
  dirCrudo: string,
  dirsDeltas: readonly string[],
  contenidoYaLeido?: ContenidoDelCrudo,
): M4DeDisco {
  if (dirsDeltas.length === 0)
    throw new Error("M4 necesita al menos un primer deltas.");
  const contenido = contenidoYaLeido ?? leerDirectorioDelCrudo(resolve(dirCrudo));
  const v = verificarCrudo(contenido);
  if (!v.ok || v.crudo === null) throw new Error("El crudo no pasa seed:verificar.");
  const avisos: AvisoParaM4[] = [];
  const ventanas: unknown[] = [];
  for (const d of dirsDeltas) {
    const ruta = join(resolve(d), "manifiesto.json");
    if (!existsSync(ruta)) throw new Error(`Sin manifiesto: ${ruta}`);
    const m = JSON.parse(readFileSync(ruta, "utf8")) as ManifiestoDeDeltas;
    if (m.pipeline !== "deltas") {
      throw new Error(`${ruta} no es de deltas (${String(m.pipeline)}).`);
    }
    ventanas.push(m.ventana);
    avisos.push(
      ...avisosDesdeRespuestas(
        (m.respuestas ?? []).map((r) => ({
          status: r.status,
          cuerpo: new Uint8Array(readFileSync(join(resolve(d), r.fichero))),
        })),
      ),
    );
  }
  const informe = analizarM4({
    ancla: v.crudo.ancla,
    T1: v.crudo.T1,
    paginas: paginasDelCrudo(v.crudo, contenido),
    avisos,
  });
  return { crudo: v.crudo, informe, ventanas };
}
