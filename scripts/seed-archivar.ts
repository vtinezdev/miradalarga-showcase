/**
 * `pnpm seed:archivar <crudo> <destino vacío> [--fuera-del-equipo]` — copia el
 * crudo, **verifica la copia por huella** y la anota en `<capturaId>.copias.json`.
 * `pnpm seed:archivar --comprobar <crudo>` — lo que exige la carga de un crudo
 * real: original + al menos una copia verificada, una de ellas fuera del equipo
 * (ADR 0009 §4). **0 API, sin base.** Solo se copia el crudo, nunca su diario.
 *
 * **También el directorio de M1** (`.seed-runs/m1-<sello>/`, con `sonda.json`
 * y `m1.json`): sin él la captura no arranca (`seed:capturar` lo verifica), así
 * que se archiva igual. Su huella es la de `m1.json` —la que fija el plan— y
 * la copia vale solo si `verificarM1` la acepta entera (`SHA256SUMS`, páginas y
 * las referencias del Spike, que solo existen en local). El recibo, al lado:
 * `m1-<sello>.copias.json`.
 *
 * Salida: `0` bien · `1` la copia o la comprobación fallan · `2` uso.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import type { VerificarDirectorio } from "../jobs/pipelines/seed/crudo/copias.ts";
import {
  archivarCrudo,
  comprobarCopias,
  huellaVerificada,
} from "../jobs/pipelines/seed/crudo/copias.ts";
import { leerDirectorioDelCrudo } from "../jobs/pipelines/seed/crudo/disco.ts";
import {
  FICHERO_DE_LA_SONDA,
  FICHERO_DEL_RESULTADO_M1,
  verificarM1,
} from "../jobs/pipelines/seed/m1.ts";
import { externosDeM1 } from "./seed-referencias.ts";

/** M1 se reconoce por sus dos ficheros; todo lo demás es un crudo de captura. */
function esDirectorioDeM1(directorio: string): boolean {
  return (
    existsSync(join(directorio, FICHERO_DE_LA_SONDA)) &&
    existsSync(join(directorio, FICHERO_DEL_RESULTADO_M1))
  );
}

const verificarDirectorioDeM1: VerificarDirectorio = (directorio) => {
  const v = verificarM1(leerDirectorioDelCrudo(directorio), externosDeM1());
  if (!v.ok || v.huella === null || v.resultado === null) {
    throw new Error(
      `M1 de ${directorio} no verifica: ${v.problemas.slice(0, 3).join("; ")}`,
    );
  }
  return { huella: v.huella, capturaId: v.resultado.sondaId };
};

function verificadorPara(directorio: string): VerificarDirectorio {
  return esDirectorioDeM1(directorio) ? verificarDirectorioDeM1 : huellaVerificada;
}

function principal(a: readonly string[]): number {
  if (a.some((x) => x.trim() === "")) {
    console.error("Una ruta vacía resolvería al directorio actual: se niega.");
    return 2;
  }
  try {
    if (a[0] === "--comprobar" && a.length === 2 && a[1] !== undefined) {
      const origen = resolve(a[1]);
      const e = comprobarCopias(origen, verificadorPara(origen));
      console.log(`${esDirectorioDeM1(origen) ? "M1 · " : ""}huella ${e.huella}`);
      console.log(
        `copias verificadas ${String(e.copiasValidas)} · fuera del equipo ${String(e.fueraDelEquipo)}`,
      );
      for (const p of e.problemas) console.log(`  ✗ ${p}`);
      return e.ok ? 0 : 1;
    }
    const [origen, destino, bandera] = a;
    if (
      origen === undefined ||
      destino === undefined ||
      (bandera !== undefined && bandera !== "--fuera-del-equipo") ||
      a.length > 3
    ) {
      console.error(
        "Uso: pnpm seed:archivar <crudo o M1> <destino vacío> [--fuera-del-equipo]\n" +
          "     pnpm seed:archivar --comprobar <crudo o M1>",
      );
      return 2;
    }
    const o = resolve(origen);
    const c = archivarCrudo(o, resolve(destino), {
      fueraDelEquipo: bandera === "--fuera-del-equipo",
      verificar: verificadorPara(o),
    });
    console.log(`copia verificada: ${c.destino}`);
    console.log(
      `${esDirectorioDeM1(o) ? "M1 · " : ""}huella ${c.huella} · fuera del equipo: ${c.fueraDelEquipo ? "sí (declarado)" : "no"}`,
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

process.exitCode = principal(process.argv.slice(2));
