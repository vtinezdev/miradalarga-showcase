/**
 * `pnpm seed:sondear --ensayo | --real` — **M1** (ADR 0009 §3, `jobs/pipelines/seed/sonda.ts`).
 *
 *   · `--ensayo` — **0 API, sin base.** El motor de la sonda de verdad, con un
 *     libro de cuota en memoria, reenviando como «respuestas» las páginas 1 **por
 *     defecto** del Spike 1. Todas deben rechazarse (`igual_al_orden_por_defecto`)
 *     y sus plataformas caer a `rating`: demuestra el respaldo sin gastar nada.
 *   · `--real` — **gasta cuota: ≤ 10 requests.** Contra la rama de validación
 *     vigente (`drizzle-schema-v1-test`, ADR 0009 §3), con la autorización del
 *     seed para la fase `sonda` en el ciclo de cuota **actual**
 *     (`AUTORIZACIONES_DEL_SEED`). Sin ella, no abre ni una conexión.
 *
 * Deja `.seed-runs/<sondaId>/` (sonda.json · paginas/ · m1.json · SHA256SUMS) y
 * lo verifica con `verificarM1`. El resultado **solo vale para una captura que
 * empiece en el ciclo siguiente**.
 *
 * Salida: `0` succeeded · `1` failed o precondición incumplida · `2`
 * budget_stopped o lock ocupado.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { AutorizacionDelSeed } from "../jobs/ops/autorizacion-del-seed.ts";
import {
  autorizacionVigente,
  presupuestoDelSeed,
} from "../jobs/ops/autorizacion-del-seed.ts";
import type { Conexion } from "../jobs/ops/conexion.ts";
import { crearLibroEnMemoria } from "../jobs/ops/libro-en-memoria.ts";
import { calcularCiclo, leerPresupuesto } from "../jobs/ops/presupuesto.ts";
import type { FuenteDePaginas } from "../jobs/pipelines/seed/captura.ts";
import { crearAlmacenEnDisco } from "../jobs/pipelines/seed/crudo/almacen.ts";
import { leerDirectorioDelCrudo } from "../jobs/pipelines/seed/crudo/disco.ts";
import { ESTRATOS_DEL_MVP } from "../jobs/pipelines/seed/crudo/formato.ts";
import { crearFuenteReal } from "../jobs/pipelines/seed/fuente-real.ts";
import type { SondaDelSeed } from "../jobs/pipelines/seed/m1.ts";
import {
  ESTRATOS_DE_M1,
  FORMATO_DE_LA_SONDA,
  VERSION_DE_M1,
  evaluarEstratoDeM1,
  queryDeM1,
  verificarM1,
} from "../jobs/pipelines/seed/m1.ts";
import { ejecutarSonda } from "../jobs/pipelines/seed/sonda.ts";
import {
  DIRECTORIO_DE_CRUDOS,
  commitActual,
  credencialSinOverrides,
  evidenciaDeNetflix,
  exigirSinCredencial,
  externosDeM1,
  referenciasDelSpike,
  relojDesplazado,
} from "./seed-api-comun.ts";

async function principal(argumentos: readonly string[]): Promise<number> {
  const modo = argumentos[0];
  if ((modo !== "--ensayo" && modo !== "--real") || argumentos.length !== 1) {
    console.error("Uso: pnpm seed:sondear --ensayo | --real");
    return 1;
  }
  const real = modo === "--real";
  console.log(
    `SEED:SONDEAR ${modo} — M1 · ${real ? "GASTA CUOTA (≤ 10 requests)" : "0 API"}\n`,
  );

  const referencias = referenciasDelSpike();
  const evidencia = evidenciaDeNetflix();
  const estratoPorNombre = new Map(ESTRATOS_DEL_MVP.map((e) => [e.estrato, e]));
  const evaluacionesNetflix = evidencia.map((f) => {
    const e = estratoPorNombre.get(f.estrato);
    const ref = referencias.find((r) => r.estrato === f.estrato);
    if (e === undefined || ref === undefined)
      throw new Error(`Sin estrato ${f.estrato}.`);
    return evaluarEstratoDeM1({
      estrato: e,
      fuente: "evidencia_historica",
      pagina: f.ruta,
      http: f.status,
      cuerpo:
        f.cuerpo === null ? null : new TextEncoder().encode(JSON.stringify(f.cuerpo)),
      referencia: { nombre: ref.ruta, shows: ref.shows },
    });
  });
  for (const ev of evaluacionesNetflix) {
    console.log(
      `  evidencia ${ev.estrato}: ${ev.resultado}${ev.motivos.length > 0 ? ` (${ev.motivos.join(", ")})` : ""}`,
    );
  }

  const sello = new Date().toISOString().replace(/[:.]/g, "-");
  const sondaId = `${real ? "m1" : "ensayo-m1"}-${sello}`;
  const directorio = join(DIRECTORIO_DE_CRUDOS, sondaId);
  if (existsSync(directorio)) throw new Error(`Ya existe ${directorio}.`);
  const commit = commitActual();
  const sonda: SondaDelSeed = {
    formato: FORMATO_DE_LA_SONDA,
    v: VERSION_DE_M1,
    sondaId,
    commit,
    estratos: ESTRATOS_DE_M1.map((e) => ({
      estrato: e.estrato,
      query: { ...queryDeM1(e) },
    })),
    referencias: referencias.map((r) => ({
      estrato: r.estrato,
      ruta: r.ruta,
      sha256: r.sha256,
    })),
    evidencia: evidencia.map((f) => ({
      estrato: f.estrato,
      ruta: f.ruta,
      sha256: f.sha256,
    })),
  };
  const referenciasPorEstrato = new Map(referencias.map((r) => [r.estrato, r.shows]));

  let conexion: Conexion | null = null;
  let salida;
  let clave: string | null = null;
  try {
    if (!real) {
      const inicio = new Date();
      // Solo para este libro en memoria: el repositorio sigue sin autorizaciones.
      const autorizacion: AutorizacionDelSeed = {
        ciclo: calcularCiclo(inicio, 1).clave,
        fase: "sonda",
        tope: 10,
        techo: 10,
        aprobadaEl: inicio.toISOString(),
        referencia: "ensayo en memoria: 0 API",
      };
      const cuerpos = new Map(referencias.map((r) => [r.estrato, r.cuerpo]));
      const reenvio: FuenteDePaginas = async (p, cuota) => {
        await cuota.pedirCuota();
        return {
          status: 200,
          cuerpo: new TextEncoder().encode(
            JSON.stringify(cuerpos.get(p.estrato.estrato)),
          ),
          cabeceras: {},
        };
      };
      salida = await ejecutarSonda({
        ejecutorOps: crearLibroEnMemoria().ejecutor,
        presupuesto: presupuestoDelSeed(leerPresupuesto({}), "sonda", inicio, [
          autorizacion,
        ]),
        sonda,
        fuente: reenvio,
        almacen: crearAlmacenEnDisco(directorio),
        reloj: () => new Date(),
        referencias: referenciasPorEstrato,
        evidencia: evaluacionesNetflix,
        destino: "memoria:ensayo",
        commitSha: commit,
        comprobarCuotaDelProveedor: false,
      });
    } else {
      clave = credencialSinOverrides();
      const { RAMA_HISTORICA, verificarDestino } =
        await import("../drizzle.migrate.config.ts");
      const destino = verificarDestino(process.env, [RAMA_HISTORICA]);
      const base = leerPresupuesto({});
      const precheck = autorizacionVigente("sonda", new Date(), base.diaDeCiclo);
      if (precheck === null) {
        console.error(
          "\n❌ Sin autorización del seed para la fase sonda en el ciclo actual " +
            `(${String(calcularCiclo(new Date(), base.diaDeCiclo).clave)}). ` +
            "AUTORIZACIONES_DEL_SEED está vacía hasta el commit de aprobación. 0 requests.",
        );
        return 1;
      }
      console.log(`  destino           ${destino.rama} (${destino.hostname})`);
      const { conectar } = await import("../jobs/ops/conexion.ts");
      conexion = await conectar(destino.url);
      const reloj = await relojDesplazado(conexion.ejecutor);
      const presupuesto = presupuestoDelSeed(base, "sonda", reloj());
      console.log(
        `  autorización      ciclo ${String(precheck.ciclo)} · tope ${String(presupuesto.topePorEjecucion.seed)} · ` +
          `techo ${String(presupuesto.techoMensualPorPipeline.seed)}`,
      );
      salida = await ejecutarSonda({
        ejecutorOps: conexion.ejecutor,
        presupuesto,
        sonda,
        fuente: crearFuenteReal({ apiKey: clave }),
        almacen: crearAlmacenEnDisco(directorio),
        reloj,
        referencias: referenciasPorEstrato,
        evidencia: evaluacionesNetflix,
        destino: destino.rama,
        commitSha: commit,
        comprobarCuotaDelProveedor: true,
      });
    }
  } finally {
    await conexion?.cerrar();
  }

  const r = salida.resultado;
  if (!r.ejecutado) {
    console.log(`\n⚠️  No se ejecutó: ${r.motivo}.`);
    return 2;
  }
  console.log(`\n  ops_sync_runs ${String(r.runId)} · ${r.estado}`);
  if (!existsSync(directorio)) {
    console.log(`  sin crudo: ${JSON.stringify(r.metricas.errorSamples[0] ?? {})}`);
    return r.estado === "budget_stopped" ? 2 : 1;
  }
  const contenido = leerDirectorioDelCrudo(directorio);
  if (clave !== null) exigirSinCredencial(contenido, clave);
  const v = verificarM1(contenido, externosDeM1());
  for (const e of salida.m1?.evaluaciones ?? []) {
    console.log(
      `  ${e.estrato.padEnd(20)} ${e.fuente === "medido" ? "medido   " : "evidencia"} ${e.resultado}` +
        `${e.motivos.length > 0 ? ` (${e.motivos.join(", ")})` : ""} · cursor ${e.formaDelCursor ?? "—"}`,
    );
  }
  for (const d of salida.m1?.decisiones ?? []) {
    console.log(`  → ${d.plataforma.padEnd(12)} ${d.orderBy.padEnd(19)} ${d.motivo}`);
  }
  const cuota = salida.m1?.paginas.at(-1)?.cuota;
  if (cuota != null) {
    console.log(
      `  proveedor ${String(cuota.usada)} / ${String(cuota.concedida)} · reinicia ${cuota.reinicio}`,
    );
  }
  console.log(
    `\n  verificarM1: ${v.ok ? "OK" : `FALLA (${v.problemas.join("; ")})`} · utilizable: ${v.utilizable ? "sí" : "NO"}`,
  );
  console.log(`  huella de m1.json ${v.huella ?? "—"}`);
  console.log(`  directorio        ${directorio}`);
  if (salida.m1 !== null) {
    console.log(
      `  ⚠️  Solo vale para una captura que EMPIECE en el ciclo siguiente al ${String(salida.m1.cicloClave)}.`,
    );
  }
  if (!v.ok) return 1;
  return r.estado === "succeeded" ? 0 : r.estado === "budget_stopped" ? 2 : 1;
}

principal(process.argv.slice(2)).then(
  (codigo) => {
    process.exitCode = codigo;
  },
  (error: unknown) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
