/**
 * El lock compartido de **escritor de catálogo** (`jobs/ops/bloqueo.ts`, lock
 * C), probado con `ejecutarJob` de verdad y **sin base de datos**.
 *
 * Los advisory locks se simulan con un registro compartido entre «sesiones»:
 * cada ejecución tiene la suya, como en producción, y todas escriben en el
 * mismo `ops_sync_runs` en memoria. Que PostgreSQL excluya de verdad entre
 * sesiones con `pg_try_advisory_lock` ya está medido para el lock de pipeline
 * (`pnpm db:validate:ops`); C es la misma primitiva en otro espacio de nombres.
 * Aquí se prueba **quién lo toma, en qué orden, y qué pasa si está ocupado**.
 */
import { describe, expect, it } from "vitest";

import {
  CLAVE_CATALOGO,
  NS_CATALOGO,
  NS_CICLO,
  NS_PIPELINE,
} from "../../jobs/ops/bloqueo.ts";
import type { EjecutorSql, NombreDePipeline } from "../../jobs/ops/contratos.ts";
import { ESCRIBE_CATALOGO, NOMBRES_DE_PIPELINE } from "../../jobs/ops/contratos.ts";
import { ejecutarJob } from "../../jobs/ops/ejecucion.ts";
import type { ResultadoDeJob } from "../../jobs/ops/ejecucion.ts";
import { crearLibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import type { LibroEnMemoria } from "../../jobs/ops/libro-en-memoria.ts";
import { leerPresupuesto } from "../../jobs/ops/presupuesto.ts";

const AHORA = new Date("2026-09-24T10:00:00.000Z");
const PRESUPUESTO = leerPresupuesto({});

/** El servidor: qué sesión sostiene cada advisory lock de sesión. */
function crearServidor() {
  const libro: LibroEnMemoria = crearLibroEnMemoria();
  const locks = new Map<string, number>();
  let siguiente = 1;

  function sesion(): { ejecutor: EjecutorSql; sentencias: string[]; id: number } {
    const id = siguiente++;
    const sentencias: string[] = [];
    const ejecutor: EjecutorSql = {
      ejecutar<T>(texto: string, valores: readonly unknown[] = []) {
        const clave = `${String(valores[0])}:${String(valores[1])}`;
        sentencias.push(`${texto.trim().split("\n")[0] ?? ""} [${clave}]`);
        if (texto.includes("pg_try_advisory_lock")) {
          const duenio = locks.get(clave);
          const tomado = duenio === undefined || duenio === id;
          if (tomado) locks.set(clave, id);
          return Promise.resolve([{ tomado }] as unknown as readonly T[]);
        }
        if (texto.includes("pg_advisory_unlock")) {
          if (locks.get(clave) === id) locks.delete(clave);
          return Promise.resolve([] as readonly T[]);
        }
        return libro.ejecutor.ejecutar<T>(texto, valores);
      },
    };
    return { ejecutor, sentencias, id };
  }

  return { libro, locks, sesion };
}

/** Una compuerta: el cuerpo del job espera hasta que el test la abra. */
function compuerta() {
  let abrir = (): void => undefined;
  const abierta = new Promise<void>((r) => {
    abrir = r;
  });
  return { abierta, abrir: () => abrir() };
}

const correr = (
  ejecutor: EjecutorSql,
  pipeline: NombreDePipeline,
  cuerpo: () => Promise<void> = () => Promise.resolve(),
): Promise<ResultadoDeJob> =>
  ejecutarJob(ejecutor, { pipeline, presupuesto: PRESUPUESTO, ahora: AHORA }, cuerpo);

const CATALOGO = `${String(NS_CATALOGO)}:${String(CLAVE_CATALOGO)}`;

describe("quién escribe catálogo", () => {
  it("deltas y expiring sí; popularity, scoring y changes_validation no", () => {
    expect(ESCRIBE_CATALOGO.deltas).toBe(true);
    expect(ESCRIBE_CATALOGO.expiring).toBe(true);
    expect(ESCRIBE_CATALOGO.popularity).toBe(false);
    expect(ESCRIBE_CATALOGO.scoring).toBe(false);
    expect(ESCRIBE_CATALOGO.changes_validation).toBe(false);
  });

  it("todo el vocabulario está declarado: nadie escribe catálogo por omisión", () => {
    expect(Object.keys(ESCRIBE_CATALOGO).sort()).toEqual(
      [...NOMBRES_DE_PIPELINE].sort(),
    );
  });

  it("tres espacios de nombres distintos: C no puede colisionar con A ni con B", () => {
    expect(new Set([NS_PIPELINE, NS_CICLO, NS_CATALOGO]).size).toBe(3);
  });
});

describe("deltas y expiring no escriben catálogo a la vez", () => {
  it("con deltas dentro, expiring se va: catalogo_ocupado, sin fila ni huérfanas", async () => {
    const servidor = crearServidor();
    const puerta = compuerta();
    const deltas = servidor.sesion();
    const expiring = servidor.sesion();

    const enCurso = correr(deltas.ejecutor, "deltas", () => puerta.abierta);
    // Deja que deltas tome sus locks y abra su fila.
    await new Promise((r) => setTimeout(r, 0));
    expect(servidor.locks.get(CATALOGO)).toBe(deltas.id);

    const r = await correr(expiring.ejecutor, "expiring");
    expect(r).toEqual({ ejecutado: false, motivo: "catalogo_ocupado" });
    expect(servidor.libro.filas.map((f) => f.pipeline)).toEqual(["deltas"]);
    expect(expiring.sentencias.some((s) => s.includes("status = 'running'"))).toBe(
      false,
    );
    // Soltó su propio lock de pipeline: el siguiente expiring no queda vetado.
    expect(servidor.locks.has(`${String(NS_PIPELINE)}:3`)).toBe(false);

    puerta.abrir();
    await enCurso;
    // Con deltas fuera, expiring entra.
    const despues = await correr(expiring.ejecutor, "expiring");
    expect(despues.ejecutado).toBe(true);
    expect(servidor.locks.size).toBe(0);
  });

  it("y al revés: con expiring dentro, deltas se va igual", async () => {
    const servidor = crearServidor();
    const puerta = compuerta();
    const enCurso = correr(
      servidor.sesion().ejecutor,
      "expiring",
      () => puerta.abierta,
    );
    await new Promise((r) => setTimeout(r, 0));

    const r = await correr(servidor.sesion().ejecutor, "deltas");
    expect(r).toEqual({ ejecutado: false, motivo: "catalogo_ocupado" });

    puerta.abrir();
    await enCurso;
  });

  it("otra ejecución del MISMO pipeline se informa como ya_hay_una_viva, no como catálogo", async () => {
    const servidor = crearServidor();
    const puerta = compuerta();
    const enCurso = correr(servidor.sesion().ejecutor, "deltas", () => puerta.abierta);
    await new Promise((r) => setTimeout(r, 0));

    const segunda = servidor.sesion();
    const r = await correr(segunda.ejecutor, "deltas");
    expect(r).toEqual({ ejecutado: false, motivo: "ya_hay_una_viva" });
    // Ni siquiera llegó a pedir el de catálogo: A va primero.
    expect(segunda.sentencias.some((s) => s.includes(CATALOGO))).toBe(false);

    puerta.abrir();
    await enCurso;
  });
});

describe("los que no escriben catálogo no se bloquean", () => {
  it.each(["popularity", "scoring", "changes_validation"] as const)(
    "%s corre mientras deltas escribe, y no toca el lock de catálogo",
    async (pipeline) => {
      const servidor = crearServidor();
      const puerta = compuerta();
      const enCurso = correr(
        servidor.sesion().ejecutor,
        "deltas",
        () => puerta.abierta,
      );
      await new Promise((r) => setTimeout(r, 0));

      const otro = servidor.sesion();
      const r = await correr(otro.ejecutor, pipeline);
      expect(r.ejecutado).toBe(true);
      expect(otro.sentencias.some((s) => s.includes(CATALOGO))).toBe(false);
      // Y deltas sigue sosteniendo el suyo.
      expect(servidor.locks.has(CATALOGO)).toBe(true);

      puerta.abrir();
      await enCurso;
    },
  );
});

describe("orden fijo de adquisición y liberación", () => {
  const indice = (sentencias: readonly string[], fragmento: string): number =>
    sentencias.findIndex((s) => s.includes(fragmento));

  it("A → C → huérfanas → INSERT; se sueltan C y después A", async () => {
    const servidor = crearServidor();
    const s = servidor.sesion();
    await correr(s.ejecutor, "expiring");

    const tomarA = indice(
      s.sentencias,
      `pg_try_advisory_lock($1, $2) AS tomado [${String(NS_PIPELINE)}:`,
    );
    const tomarC = indice(
      s.sentencias,
      `pg_try_advisory_lock($1, $2) AS tomado [${CATALOGO}]`,
    );
    const huerfanas = indice(s.sentencias, "UPDATE ops_sync_runs");
    const alta = indice(s.sentencias, "INSERT INTO ops_sync_runs");
    const soltarC = indice(s.sentencias, `pg_advisory_unlock($1, $2) [${CATALOGO}]`);
    const soltarA = indice(
      s.sentencias,
      `pg_advisory_unlock($1, $2) [${String(NS_PIPELINE)}:`,
    );

    expect(tomarA).toBe(0);
    expect(tomarC).toBe(1);
    expect(huerfanas).toBeGreaterThan(tomarC);
    expect(alta).toBeGreaterThan(huerfanas);
    expect(soltarC).toBeGreaterThan(alta);
    expect(soltarA).toBe(soltarC + 1);
    expect(s.sentencias).toHaveLength(soltarA + 1);
  });

  it("suelta los dos aunque el cuerpo reviente", async () => {
    const servidor = crearServidor();
    const r = await correr(servidor.sesion().ejecutor, "deltas", () =>
      Promise.reject(new Error("boom")),
    );
    expect(r.ejecutado && r.estado).toBe("failed");
    expect(servidor.locks.size).toBe(0);
  });

  it("con el catálogo ocupado suelta A y no pide nada más", async () => {
    const servidor = crearServidor();
    // Otro escritor lo tiene, por fuera de ejecutarJob.
    servidor.locks.set(CATALOGO, 999);
    const s = servidor.sesion();
    const r = await correr(s.ejecutor, "deltas");
    expect(r).toEqual({ ejecutado: false, motivo: "catalogo_ocupado" });
    expect(s.sentencias.map((x) => x.split(" [")[0])).toEqual([
      "SELECT pg_try_advisory_lock($1, $2) AS tomado",
      "SELECT pg_try_advisory_lock($1, $2) AS tomado",
      "SELECT pg_advisory_unlock($1, $2)",
    ]);
    // No suelta lo que no es suyo.
    expect(servidor.locks.get(CATALOGO)).toBe(999);
    expect(servidor.libro.filas).toHaveLength(0);
  });

  it("el lock de ciclo solo se pide ya dentro, con A y C tomados", async () => {
    const servidor = crearServidor();
    const s = servidor.sesion();
    const presupuesto = leerPresupuesto({
      STREAMING_API_PER_RUN_CAPS: "expiring=1",
    });
    // Reloj real: `reservar()` calcula su ciclo con él, y tiene que coincidir.
    const r = await ejecutarJob(
      s.ejecutor,
      { pipeline: "expiring", presupuesto, ahora: new Date() },
      (contexto) => contexto.pedirCuota(),
    );
    expect(r.ejecutado && r.estado).toBe("succeeded");
    const ciclo = indice(s.sentencias, "pg_advisory_xact_lock");
    expect(ciclo).toBeGreaterThan(
      indice(s.sentencias, `pg_try_advisory_lock($1, $2) AS tomado [${CATALOGO}]`),
    );
    // Y se pide y se suelta antes de soltar C: nadie espera por B sosteniendo nada nuevo.
    expect(ciclo).toBeLessThan(
      indice(s.sentencias, `pg_advisory_unlock($1, $2) [${CATALOGO}]`),
    );
  });
});
