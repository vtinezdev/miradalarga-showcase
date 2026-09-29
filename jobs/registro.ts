/**
 * **Los pipelines que `pnpm job` sabe ejecutar.** Sin efectos al importarse:
 * `jobs/run.ts` lo ejecuta y los tests lo inspeccionan de verdad, no leyendo
 * el fuente como texto.
 *
 * `deltas` (Paso 5, 2026-09-23), `expiring` y `upcoming` (2026-09-24). Añadir
 * uno exige aprobación explícita, con su techo mensual y su tope decididos por
 * separado. Un pipeline técnico —`changes_validation`— no entra nunca.
 *
 * Los tres corren por el mismo runner (`pipelines/programado.ts`): mismas
 * guardas, mismas conexiones, misma política de salida. Aquí solo se traduce
 * su veredicto a consola y a GitHub Actions.
 */
import { appendFileSync } from "node:fs";

import { conectar } from "./ops/conexion.ts";
import type { NombreDePipeline } from "./ops/contratos.ts";
import { leerPresupuesto } from "./ops/presupuesto.ts";
import { congelacionDelDestino, explicarCongelacion } from "./pipelines/arranque.ts";
import { ejecutarDeltasProgramado } from "./pipelines/deltas/programado.ts";
import { ejecutarExpiringProgramado } from "./pipelines/expiring/programado.ts";
import { ejecutarUpcomingProgramado } from "./pipelines/upcoming/programado.ts";
import type {
  CodigoDeSalida,
  DependenciasDelJob,
  VeredictoComun,
} from "./pipelines/programado.ts";

export type Entorno = Readonly<Partial<Record<string, string>>>;

/**
 * Un job programado como `pnpm job` lo necesita: verifica el destino, corre,
 * imprime el resumen y anota la ejecución en Actions sin volcar nada sensible.
 */
function comoJob(
  nombre: NombreDePipeline,
  ejecutar: (dep: DependenciasDelJob) => Promise<{
    readonly veredicto: VeredictoComun;
    readonly resumen: readonly string[];
  }>,
): (entorno: Entorno) => Promise<CodigoDeSalida> {
  return async (entorno) => {
    // Import dinámico, como en los scripts: el módulo corre sus guardas al
    // cargarse, y un fallo tiene que llegar al `catch` como un mensaje legible.
    const { verificarDestino } = await import("../drizzle.migrate.config.ts");
    const destino = verificarDestino(entorno);

    // Ciclo de la captura del seed: la rama histórica no gasta (ADR 0010).
    // Antes de abrir ninguna conexión; aviso, no fallo.
    const congelada = congelacionDelDestino(
      destino.rama,
      new Date(),
      leerPresupuesto(entorno).diaDeCiclo,
    );
    if (congelada !== null) {
      const motivo = explicarCongelacion(destino.rama, congelada);
      console.log(`${nombre} · exit 0 · aviso · rama_congelada`);
      console.log(motivo);
      if (entorno.GITHUB_ACTIONS === "true") {
        console.log(`::warning title=${nombre}: rama_congelada::${motivo}`);
      }
      return 0;
    }

    const { veredicto, resumen } = await ejecutar({ entorno, destino, conectar });

    for (const linea of resumen) console.log(linea);

    if (entorno.GITHUB_ACTIONS === "true") {
      const titulo = `${nombre}: ${veredicto.motivo}`;
      if (veredicto.nivel === "aviso")
        console.log(`::warning title=${titulo}::${resumen[0] ?? ""}`);
      if (veredicto.nivel === "atencion" || veredicto.nivel === "error") {
        console.log(`::error title=${titulo}::${resumen[0] ?? ""}`);
      }
      const fichero = entorno.GITHUB_STEP_SUMMARY;
      if (fichero !== undefined && fichero !== "") {
        appendFileSync(
          fichero,
          [`### ${nombre}`, "", "```", ...resumen, "```", ""].join("\n"),
          "utf8",
        );
      }
    }
    return veredicto.codigo;
  };
}

/** Los únicos pipelines que `pnpm job` sabe ejecutar. */
export const PIPELINES_REGISTRADOS: Readonly<
  Record<string, (entorno: Entorno) => Promise<CodigoDeSalida>>
> = {
  deltas: comoJob("deltas", ejecutarDeltasProgramado),
  expiring: comoJob("expiring", ejecutarExpiringProgramado),
  upcoming: comoJob("upcoming", ejecutarUpcomingProgramado),
};
