/**
 * **`seed:verificar`**: la comprobación de integridad del crudo (ADR 0009 §4).
 * **0 API, sin base de datos**: función pura sobre los bytes de un directorio.
 *
 * Qué comprueba, en este orden:
 *
 *   1. **Integridad:** cada fichero de `SHA256SUMS` existe y su hash coincide;
 *      no falta ninguno y no sobra ninguno.
 *   2. **Formatos:** `plan.json` y `manifiesto.json` son v1 y cumplen su schema
 *      estricto; el manifiesto apunta a este plan (huella) y está cerrado.
 *   3. **Página a página:** numeración, nombre del fichero, query exacta y
 *      **sin credencial**, bytes y sha256, instantes, cuerpo legible y
 *      coherente con el manifiesto.
 *   4. **Rondas y cursores**, reproduciendo el recorrido con el mismo motor que
 *      la captura (`rondas.ts`): orden de estratos, número de ronda, cadena de
 *      cursores continua y ninguna página tras agotar un estrato.
 *   5. **El criterio de parada** del manifiesto se reproduce desde las páginas.
 *   6. **El ancla:** `S = T0 truncado − 1 h`, `S ≤ min(reserva) − 1 h`, y la M1
 *      del plan es del ciclo inmediatamente anterior al de `T0`.
 *   7. Calcula la **selección** y la **huella canónica del catálogo**, que las
 *      cargas tienen que reproducir.
 *
 * ⚠️ **No importa ningún módulo capaz de llamar a la API ni de conectarse a una
 * base de datos.** Un test recorre su grafo de importaciones y lo exige.
 */
import type { z } from "zod";

import { calcularCiclo } from "../../../ops/presupuesto.ts";
import { vencimientoDelAncla } from "../ancla.ts";
import { CAPACIDADES_MVP } from "../capacidades.ts";
import type { FilasDeSeed } from "../filas.ts";
import { construirFilas } from "../filas.ts";
import {
  filasCanonicasDesdeSeed,
  huellaCanonicaDelCatalogo,
} from "../huella-catalogo.ts";
import { PLATAFORMAS_MVP } from "../plataformas.ts";
import type { EstadoDeRondas } from "../rondas.ts";
import {
  cerrarRonda,
  enFronteraDeRonda,
  iniciarRondas,
  registrarPagina,
  rondasCompletas,
  siguientePeticion,
} from "../rondas.ts";
import type { ContadoresDeEstrato, SeleccionDelSeed } from "../seleccion.ts";
import { crearAcumulador, validarShows } from "../seleccion.ts";
import type { ContenidoDelCrudo } from "./disco.ts";
import type {
  CierreDeCaptura,
  MotivoNoCargable,
  EstratoDelPlan,
  ManifiestoDelSeed,
  PlanDelSeed,
} from "./formato.ts";
import {
  CLAVES_DE_QUERY,
  FICHERO_DE_SUMAS,
  FICHERO_DEL_MANIFIESTO,
  FICHERO_DEL_PLAN,
  FORMATO_DEL_MANIFIESTO,
  FORMATO_DEL_PLAN,
  MARGEN_DEL_ANCLA_SEGUNDOS,
  MOTIVOS_DE_EXITO,
  VERSION_DEL_CRUDO,
  anclaDesdeT0,
  cicloSiguiente,
  ficheroDePagina,
  manifiestoV1,
  motivoNoCargable,
  paginaCrudaV1,
  planV1,
  queryDePagina,
} from "./formato.ts";
import { leerSumas, sha256 } from "./huella.ts";

export type CodigoDeProblema =
  | "fichero_ausente"
  | "fichero_extra"
  | "sha256_incorrecto"
  | "sha256sums_invalido"
  | "json_ilegible"
  | "formato_desconocido"
  | "version_desconocida"
  | "plan_invalido"
  | "manifiesto_invalido"
  | "huella_del_plan_distinta"
  | "captura_distinta"
  | "manifiesto_abierto"
  | "numeracion"
  | "nombre_de_pagina"
  | "estrato_desconocido"
  | "orden_de_ronda"
  | "ronda_incoherente"
  | "cursor_incoherente"
  | "credencial_en_query"
  | "query_incoherente"
  | "instantes_incoherentes"
  | "pagina_invalida"
  | "pagina_incoherente"
  | "pagina_tras_parada"
  | "pagina_tras_fallo"
  | "parada_incoherente"
  | "contadores_incoherentes"
  | "fila_de_ops_desconocida"
  | "ancla_incoherente"
  | "m1_caducada";

export interface ProblemaDeVerificacion {
  readonly codigo: CodigoDeProblema;
  readonly detalle: string;
  readonly fichero?: string;
}

/**
 * Un crudo que ha pasado **todas** las comprobaciones. Solo lo construye
 * `verificarCrudo`, y es lo único que acepta la carga.
 */
export interface CrudoVerificado {
  readonly marca: "crudo-verificado-v1";
  readonly huella: string;
  readonly huellaDelPlan: string;
  readonly plan: PlanDelSeed;
  readonly manifiesto: ManifiestoDelSeed;
  readonly cierre: CierreDeCaptura;
  readonly T0: Date;
  /** `S`. */
  readonly ancla: Date;
  readonly T1: Date;
  readonly seleccion: SeleccionDelSeed;
  readonly filas: FilasDeSeed;
  readonly huellaCanonica: string;
  /**
   * Si la carga puede aceptarlo (ADR 0009 §1, enmienda del 2026-09-27):
   *
   *   · `succeeded` → sí.
   *   · `budget_stopped` **en una frontera de ronda** (`rondaCompleta`) → sí,
   *     aunque no llegue al objetivo: todos los estratos vivos tienen la misma
   *     profundidad.
   *   · `budget_stopped` **a mitad de ronda** → **no**: íntegro y reanudable,
   *     pero incompleto. Nunca se carga media ronda.
   *   · `failed` → no: hay que revisar la causa y reanudar.
   */
  readonly cargable: boolean;
  /** Por qué no es cargable. `null` si lo es. */
  readonly motivoNoCargable: MotivoNoCargable | null;
}

export interface ResumenDelCrudo {
  readonly capturaId: string;
  readonly estado: string;
  readonly motivo: string;
  readonly cortadoPorTope: boolean;
  readonly rondasCompletas: number;
  readonly rondaCompleta: boolean;
  readonly motivoNoCargable: string | null;
  readonly T0: string;
  readonly ancla: string;
  readonly T1: string;
  readonly vencimientoDelAncla: string;
  readonly paginas: {
    readonly total: number;
    readonly confirmadas: number;
    readonly adoptadas: number;
    readonly invalidas: number;
  };
  readonly rondas: number;
  readonly estratosAgotados: readonly string[];
  readonly unicosElegibles: number;
  readonly porEstrato: Readonly<Record<string, ContadoresDeEstrato>>;
  readonly pares: Readonly<Record<string, number>>;
  readonly sustituciones: number;
  readonly tiposDistintos: number;
  readonly filas: Readonly<Record<string, number>>;
  readonly descartes: number;
}

export interface ResultadoDeVerificacion {
  readonly ok: boolean;
  readonly problemas: readonly ProblemaDeVerificacion[];
  /** sha256 de `SHA256SUMS`, si existe: la identidad del crudo. */
  readonly huellaDelCrudo: string | null;
  readonly huellaDelPlan: string | null;
  readonly huellaCanonica: string | null;
  readonly resumen: ResumenDelCrudo | null;
  /** Solo si `ok`. */
  readonly crudo: CrudoVerificado | null;
}

const MOTIVOS_DE_CORTE = new Set([
  "tope_por_ejecucion",
  "mensual_del_pipeline",
  "global",
  "cuota_del_proveedor",
]);

const decodificador = new TextDecoder("utf-8", { fatal: true });

function comoTexto(bytes: Uint8Array): string | null {
  try {
    return decodificador.decode(bytes);
  } catch {
    return null;
  }
}

function comoJson(bytes: Uint8Array): { ok: true; valor: unknown } | { ok: false } {
  const texto = comoTexto(bytes);
  if (texto === null) return { ok: false };
  try {
    return { ok: true, valor: JSON.parse(texto) as unknown };
  } catch {
    return { ok: false };
  }
}

function igualesComoQuery(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

export function verificarCrudo(contenido: ContenidoDelCrudo): ResultadoDeVerificacion {
  const problemas: ProblemaDeVerificacion[] = [];
  const anotar = (
    codigo: CodigoDeProblema,
    detalle: string,
    fichero?: string,
  ): void => {
    problemas.push(
      fichero === undefined ? { codigo, detalle } : { codigo, detalle, fichero },
    );
  };
  let huellaDelCrudo: string | null = null;
  let huellaDelPlan: string | null = null;

  const fin = (
    extra: Partial<
      Pick<ResultadoDeVerificacion, "resumen" | "crudo" | "huellaCanonica">
    > = {},
  ): ResultadoDeVerificacion => ({
    ok: problemas.length === 0,
    problemas,
    huellaDelCrudo,
    huellaDelPlan,
    huellaCanonica: extra.huellaCanonica ?? null,
    resumen: extra.resumen ?? null,
    crudo: problemas.length === 0 ? (extra.crudo ?? null) : null,
  });

  // ── 1 · Integridad ────────────────────────────────────────────────────────
  const bytesDeSumas = contenido.get(FICHERO_DE_SUMAS);
  if (bytesDeSumas === undefined) {
    anotar(
      "fichero_ausente",
      "no existe SHA256SUMS: sin él no hay huella",
      FICHERO_DE_SUMAS,
    );
    return fin();
  }
  huellaDelCrudo = sha256(bytesDeSumas);
  const textoDeSumas = comoTexto(bytesDeSumas);
  const sumas = textoDeSumas === null ? null : leerSumas(textoDeSumas);
  if (sumas?.ok !== true) {
    anotar(
      "sha256sums_invalido",
      sumas === null ? "no es UTF-8" : sumas.problema,
      FICHERO_DE_SUMAS,
    );
    return fin();
  }
  const listados = new Map(sumas.sumas.map((s) => [s.ruta, s.sha256]));
  for (const [ruta, esperado] of listados) {
    const bytes = contenido.get(ruta);
    if (bytes === undefined) anotar("fichero_ausente", "listado en SHA256SUMS", ruta);
    else if (sha256(bytes) !== esperado) {
      anotar("sha256_incorrecto", "el contenido no coincide con SHA256SUMS", ruta);
    }
  }
  for (const ruta of contenido.keys()) {
    if (ruta !== FICHERO_DE_SUMAS && !listados.has(ruta)) {
      anotar("fichero_extra", "no está en SHA256SUMS", ruta);
    }
  }
  for (const obligatorio of [FICHERO_DEL_PLAN, FICHERO_DEL_MANIFIESTO]) {
    if (!listados.has(obligatorio) && contenido.has(obligatorio)) {
      // Ya contado como extra; se dice también que su suma falta.
      anotar("fichero_ausente", "sin suma en SHA256SUMS", obligatorio);
    } else if (!listados.has(obligatorio)) {
      anotar("fichero_ausente", "obligatorio", obligatorio);
    }
  }

  // ── 2 · Formatos ──────────────────────────────────────────────────────────
  const leerVersionado = <T>(
    fichero: string,
    formato: string,
    esquema: z.ZodType<T>,
    codigoInvalido: CodigoDeProblema,
  ): { valor: T; bytes: Uint8Array } | null => {
    const bytes = contenido.get(fichero);
    if (bytes === undefined) return null;
    const json = comoJson(bytes);
    if (!json.ok) {
      anotar("json_ilegible", "no es JSON UTF-8", fichero);
      return null;
    }
    const objeto =
      typeof json.valor === "object" && json.valor !== null
        ? (json.valor as Record<string, unknown>)
        : {};
    if (objeto.formato !== formato) {
      anotar("formato_desconocido", `se esperaba "${formato}"`, fichero);
      return null;
    }
    if (objeto.v !== VERSION_DEL_CRUDO) {
      anotar(
        "version_desconocida",
        `v=${JSON.stringify(objeto.v) ?? "ausente"}; este lector solo entiende v${String(VERSION_DEL_CRUDO)}`,
        fichero,
      );
      return null;
    }
    const r = esquema.safeParse(json.valor);
    if (!r.success) {
      for (const i of r.error.issues.slice(0, 10)) {
        anotar(
          codigoInvalido,
          `${i.path.map(String).join(".") || "(raíz)"}: ${i.message}`,
          fichero,
        );
      }
      return null;
    }
    return { valor: r.data, bytes };
  };

  const planLeido = leerVersionado(
    FICHERO_DEL_PLAN,
    FORMATO_DEL_PLAN,
    planV1,
    "plan_invalido",
  );
  const manifiestoLeido = leerVersionado(
    FICHERO_DEL_MANIFIESTO,
    FORMATO_DEL_MANIFIESTO,
    manifiestoV1,
    "manifiesto_invalido",
  );
  if (planLeido === null || manifiestoLeido === null) return fin();
  const plan = planLeido.valor;
  const manifiesto = manifiestoLeido.valor;
  huellaDelPlan = sha256(planLeido.bytes);

  if (manifiesto.huellaDelPlan !== huellaDelPlan) {
    anotar(
      "huella_del_plan_distinta",
      "el manifiesto no es de este plan",
      FICHERO_DEL_MANIFIESTO,
    );
  }
  if (manifiesto.capturaId !== plan.capturaId) {
    anotar(
      "captura_distinta",
      "capturaId distinto en plan y manifiesto",
      FICHERO_DEL_MANIFIESTO,
    );
  }
  const cierre = manifiesto.cierre;
  if (cierre === null) {
    anotar(
      "manifiesto_abierto",
      "la captura no se cerró: un crudo abierto no se verifica",
    );
    return fin();
  }

  // ── 3 · Ficheros de página frente al manifiesto ───────────────────────────
  const ficherosDePagina = new Set(manifiesto.paginas.map((p) => p.fichero));
  for (const ruta of listados.keys()) {
    if (
      ruta !== FICHERO_DEL_PLAN &&
      ruta !== FICHERO_DEL_MANIFIESTO &&
      !ficherosDePagina.has(ruta)
    ) {
      anotar("fichero_extra", "en SHA256SUMS pero no en el manifiesto", ruta);
    }
  }
  for (const p of manifiesto.paginas) {
    if (!listados.has(p.fichero))
      anotar("fichero_ausente", "página sin suma", p.fichero);
  }

  // ── 4 · Página a página, reproduciendo las rondas ─────────────────────────
  const estratoPorNombre = new Map<string, EstratoDelPlan>(
    plan.estratos.map((e) => [e.estrato, e]),
  );
  let rondas: EstadoDeRondas = iniciarRondas(plan.estratos.map((e) => e.estrato));
  const acumulador = crearAcumulador();
  let fallo: { readonly motivo: string; readonly n: number } | null = null;
  let parada: { readonly motivo: string; readonly ronda: number } | null = null;
  let recorridoRoto = false;
  let respondidaAnterior: number | null = null;
  const cuenta = { confirmadas: 0, adoptadas: 0, invalidas: 0 };

  for (const [i, p] of manifiesto.paginas.entries()) {
    const f = p.fichero;
    if (p.n !== i + 1)
      anotar("numeracion", `n=${String(p.n)} en la posición ${String(i + 1)}`, f);
    const estrato = estratoPorNombre.get(p.estrato);
    if (estrato === undefined) {
      anotar("estrato_desconocido", `"${p.estrato}" no está en el plan`, f);
      recorridoRoto = true;
      break;
    }
    if (f !== ficheroDePagina(p.n, p.estrato, p.ronda)) {
      anotar(
        "nombre_de_pagina",
        `se esperaba ${ficheroDePagina(p.n, p.estrato, p.ronda)}`,
        f,
      );
    }
    const ajenas = Object.keys(p.query).filter(
      (k) => !(CLAVES_DE_QUERY as readonly string[]).includes(k),
    );
    if (ajenas.length > 0) {
      // Solo se nombran las claves: el valor podría ser la credencial.
      anotar(
        "credencial_en_query",
        `claves no admitidas en la query: ${ajenas.join(", ")}`,
        f,
      );
    } else if (!igualesComoQuery(p.query, queryDePagina(estrato, p.cursorDeEntrada))) {
      anotar(
        "query_incoherente",
        "la query no es la del plan para ese estrato y cursor",
        f,
      );
    }

    const reservada = Date.parse(p.reservadaEn);
    const respondida = Date.parse(p.respondidaEn);
    if (reservada > respondida) {
      anotar("instantes_incoherentes", "respondida antes de reservada", f);
    }
    if (respondidaAnterior !== null && reservada < respondidaAnterior) {
      anotar(
        "instantes_incoherentes",
        "reservada antes de responder la página anterior",
        f,
      );
    }
    respondidaAnterior = respondida;
    if (p.runId !== null && !cierre.filasDeOps.includes(p.runId)) {
      anotar(
        "fila_de_ops_desconocida",
        `runId ${String(p.runId)} no está en el cierre`,
        f,
      );
    }

    const bytes = contenido.get(f);
    if (bytes !== undefined) {
      if (bytes.length !== p.bytes) {
        anotar(
          "pagina_incoherente",
          `${String(bytes.length)} bytes, el manifiesto dice ${String(p.bytes)}`,
          f,
        );
      }
      if (sha256(bytes) !== p.sha256) {
        anotar(
          "sha256_incorrecto",
          "el contenido no coincide con el sha256 del manifiesto",
          f,
        );
      }
    }

    if (fallo !== null) {
      anotar(
        "pagina_tras_fallo",
        `la captura ya había fallado en la página ${String(fallo.n)}`,
        f,
      );
      recorridoRoto = true;
      break;
    }

    // ¿Qué página tocaba? Si la ronda está completa, se evalúa el criterio.
    let tocaba = siguientePeticion(rondas);
    if (tocaba === null) {
      const decision = cerrarRonda(
        rondas,
        acumulador.unicosElegibles(),
        plan.objetivoUnicos,
      );
      if (decision.tipo === "parar") {
        parada = { motivo: decision.motivo, ronda: decision.ronda };
        anotar(
          "pagina_tras_parada",
          `la ronda ${String(decision.ronda)} ya cumplía ${decision.motivo}: sobran páginas`,
          f,
        );
        recorridoRoto = true;
        break;
      }
      rondas = decision.estado;
      tocaba = siguientePeticion(rondas);
    }
    if (tocaba === null)
      throw new Error("Una ronda nueva nace con estratos pendientes.");
    if (tocaba.estrato !== p.estrato) {
      anotar(
        "orden_de_ronda",
        `tocaba ${tocaba.estrato} en la ronda ${String(tocaba.ronda)}`,
        f,
      );
      recorridoRoto = true;
      break;
    }
    if (tocaba.ronda !== p.ronda) {
      anotar(
        "ronda_incoherente",
        `es la ronda ${String(tocaba.ronda)}, no la ${String(p.ronda)}`,
        f,
      );
      recorridoRoto = true;
      break;
    }
    if (tocaba.cursorDeEntrada !== p.cursorDeEntrada) {
      anotar(
        "cursor_incoherente",
        tocaba.cursorDeEntrada === null
          ? "la primera página de un estrato va sin cursor"
          : "el cursor de entrada no es el nextCursor de la página anterior del estrato",
        f,
      );
      recorridoRoto = true;
      break;
    }

    if (p.estado === "invalida") {
      cuenta.invalidas++;
      fallo = { motivo: "respuesta_invalida", n: p.n };
      continue;
    }
    if (p.estado === "adoptada") cuenta.adoptadas++;
    else cuenta.confirmadas++;

    if (p.http < 200 || p.http > 299) {
      anotar("pagina_invalida", `marcada ${p.estado} con HTTP ${String(p.http)}`, f);
      recorridoRoto = true;
      break;
    }
    if (bytes === undefined) {
      recorridoRoto = true;
      break;
    }
    const json = comoJson(bytes);
    const cuerpo = json.ok ? paginaCrudaV1.safeParse(json.valor) : null;
    if (cuerpo?.success !== true) {
      anotar("pagina_invalida", "el cuerpo no es una respuesta de search/filters", f);
      recorridoRoto = true;
      break;
    }
    const showInvalido = validarShows(cuerpo.data.shows);
    if (showInvalido !== null) {
      // Una deriva del contrato no es un título omitido: la página es inválida.
      anotar(
        "pagina_invalida",
        `marcada ${p.estado} con un show fuera del schema en la posición ` +
          `${String(showInvalido.posicion)}: ${showInvalido.problemas.join("; ")}`,
        f,
      );
      recorridoRoto = true;
      break;
    }
    const hasMore = cuerpo.data.hasMore ?? false;
    const nextCursor = cuerpo.data.nextCursor ?? null;
    if (
      p.shows !== cuerpo.data.shows.length ||
      p.hasMore !== hasMore ||
      p.nextCursor !== nextCursor
    ) {
      anotar(
        "pagina_incoherente",
        "shows, hasMore o nextCursor no coinciden con el cuerpo",
        f,
      );
    }

    acumulador.anadir({
      n: p.n,
      estrato: p.estrato,
      respondidaEn: new Date(respondida),
      shows: cuerpo.data.shows,
    });
    const r = registrarPagina(rondas, { estrato: p.estrato, hasMore, nextCursor });
    rondas = r.estado;
    if (r.tipo === "cursor_sin_progreso")
      fallo = { motivo: "cursor_sin_progreso", n: p.n };
  }

  // ── 5 · El criterio de parada, reproducido ────────────────────────────────
  const estadoDeclarado = cierre.estado;
  if (!recorridoRoto) {
    let esperado:
      | { estado: "succeeded"; motivo: string }
      | { estado: "corte" }
      | { estado: "failed"; motivo: string };
    if (fallo !== null) {
      esperado = { estado: "failed", motivo: fallo.motivo };
    } else if (siguientePeticion(rondas) === null) {
      const decision = cerrarRonda(
        rondas,
        acumulador.unicosElegibles(),
        plan.objetivoUnicos,
      );
      if (decision.tipo === "parar") {
        parada = { motivo: decision.motivo, ronda: decision.ronda };
        esperado = { estado: "succeeded", motivo: decision.motivo };
      } else {
        rondas = decision.estado;
        esperado = { estado: "corte" };
      }
    } else {
      esperado = { estado: "corte" };
    }

    if (esperado.estado === "succeeded") {
      if (estadoDeclarado !== "succeeded" || cierre.motivo !== esperado.motivo) {
        anotar(
          "parada_incoherente",
          `las páginas cumplen ${esperado.motivo} al cerrar la ronda ${String(parada?.ronda ?? 0)}, ` +
            `y el manifiesto dice ${estadoDeclarado}/${cierre.motivo}`,
        );
      }
    } else if (esperado.estado === "failed") {
      if (estadoDeclarado !== "failed" || cierre.motivo !== esperado.motivo) {
        anotar(
          "parada_incoherente",
          `las páginas terminan en ${esperado.motivo} y el manifiesto dice ${estadoDeclarado}/${cierre.motivo}`,
        );
      }
    } else if (estadoDeclarado === "succeeded") {
      anotar(
        "parada_incoherente",
        "el manifiesto dice succeeded y el recorrido no alcanzó ni el objetivo ni el agotamiento " +
          "al cerrar una ronda",
      );
    } else if (
      estadoDeclarado === "budget_stopped" &&
      !MOTIVOS_DE_CORTE.has(cierre.motivo)
    ) {
      anotar(
        "parada_incoherente",
        `budget_stopped con un motivo que no es de cuota: ${cierre.motivo}`,
      );
    }

    // La frontera de ronda, reproducida con la misma regla que la captura.
    const completas = rondasCompletas(rondas);
    const frontera =
      cuenta.invalidas === 0 && enFronteraDeRonda(rondas) && completas >= 1;
    if (cierre.rondasCompletas !== completas || cierre.rondaCompleta !== frontera) {
      anotar(
        "contadores_incoherentes",
        `las páginas dan ${String(completas)} rondas completas y rondaCompleta=${String(frontera)}; ` +
          `el manifiesto dice ${String(cierre.rondasCompletas)} y ${String(cierre.rondaCompleta)}`,
      );
    }
  }
  if (estadoDeclarado === "succeeded" && !cierre.rondaCompleta) {
    anotar("parada_incoherente", "succeeded sin terminar en una frontera de ronda");
  }
  if (
    estadoDeclarado !== "succeeded" &&
    (MOTIVOS_DE_EXITO as readonly string[]).includes(cierre.motivo)
  ) {
    anotar(
      "parada_incoherente",
      `${estadoDeclarado} con el motivo de éxito ${cierre.motivo}`,
    );
  }
  const debeEstarCortado =
    estadoDeclarado === "budget_stopped" && cierre.motivo === "tope_por_ejecucion";
  if (cierre.cortadoPorTope !== debeEstarCortado) {
    anotar(
      "contadores_incoherentes",
      "cortadoPorTope no corresponde al estado y motivo del cierre",
    );
  }
  const totalPaginas = manifiesto.paginas.length;
  if (
    totalPaginas > cierre.respuestas ||
    cierre.respuestas > cierre.requestsReservadas
  ) {
    anotar(
      "contadores_incoherentes",
      `páginas ${String(totalPaginas)} ≤ respuestas ${String(cierre.respuestas)} ≤ ` +
        `reservadas ${String(cierre.requestsReservadas)} no se cumple`,
    );
  }

  // ── 6 · El ancla y la M1 ──────────────────────────────────────────────────
  const T0 = new Date(cierre.T0);
  const ancla = new Date(cierre.ancla);
  const T1 = new Date(cierre.T1);
  if (ancla.getTime() !== anclaDesdeT0(T0).getTime()) {
    anotar(
      "ancla_incoherente",
      `S tiene que ser ${anclaDesdeT0(T0).toISOString()} (T0 truncado − 1 h)`,
    );
  }
  const primera = manifiesto.paginas[0];
  const ultima = manifiesto.paginas.at(-1);
  if (primera !== undefined) {
    const primeraReserva = Date.parse(primera.reservadaEn);
    if (T0.getTime() > primeraReserva) {
      anotar("instantes_incoherentes", "T0 es posterior a la primera reserva");
    }
    if (ancla.getTime() > primeraReserva - MARGEN_DEL_ANCLA_SEGUNDOS * 1000) {
      anotar(
        "ancla_incoherente",
        "S no deja 1 h de margen antes de la primera reserva",
      );
    }
  }
  if (ultima !== undefined && T1.getTime() < Date.parse(ultima.respondidaEn)) {
    anotar("instantes_incoherentes", "T1 es anterior a la última respuesta");
  }
  if (T0.getTime() > T1.getTime())
    anotar("instantes_incoherentes", "T0 es posterior a T1");

  const cicloDeT0 = calcularCiclo(T0, plan.m1.diaDeCiclo).clave;
  if (cicloDeT0 !== cicloSiguiente(plan.m1.cicloClave)) {
    anotar(
      "m1_caducada",
      `la captura empezó en el ciclo ${String(cicloDeT0)} y la M1 (fila ${String(plan.m1.runId)}) ` +
        `es del ${String(plan.m1.cicloClave)}: solo autoriza el ${String(cicloSiguiente(plan.m1.cicloClave))}`,
    );
  }

  if (problemas.length > 0) return fin();

  // ── 7 · Selección y huella canónica ───────────────────────────────────────
  const noCargable = motivoNoCargable(cierre);
  const seleccion = acumulador.resultado();
  const filas = construirFilas(seleccion.titulos);
  const huellaCanonica = huellaCanonicaDelCatalogo(
    filasCanonicasDesdeSeed(filas, {
      plataformas: PLATAFORMAS_MVP,
      capacidades: CAPACIDADES_MVP,
    }),
  );

  const resumen: ResumenDelCrudo = {
    capturaId: plan.capturaId,
    estado: cierre.estado,
    motivo: cierre.motivo,
    cortadoPorTope: cierre.cortadoPorTope,
    rondasCompletas: cierre.rondasCompletas,
    rondaCompleta: cierre.rondaCompleta,
    motivoNoCargable: noCargable,
    T0: T0.toISOString(),
    ancla: ancla.toISOString(),
    T1: T1.toISOString(),
    vencimientoDelAncla: vencimientoDelAncla(ancla).toISOString(),
    paginas: { total: totalPaginas, ...cuenta },
    rondas: manifiesto.paginas.reduce((m, p) => Math.max(m, p.ronda), 0),
    estratosAgotados: rondas.estratos.filter((e) => e.agotado).map((e) => e.estrato),
    unicosElegibles: seleccion.titulos.length,
    porEstrato: seleccion.porEstrato,
    pares: seleccion.pares,
    sustituciones: seleccion.sustituciones,
    tiposDistintos: seleccion.tiposDistintos,
    filas: {
      external_titles: filas.titulos.length,
      external_genres: filas.generos.length,
      external_title_genres: filas.titulosGeneros.length,
      external_title_images: filas.imagenes.length,
      external_availability: filas.ofertas.length,
      external_availability_options: filas.opciones.length,
      external_platform_capabilities: CAPACIDADES_MVP.length,
    },
    descartes: filas.descartes.length,
  };

  return fin({
    huellaCanonica,
    resumen,
    crudo: {
      marca: "crudo-verificado-v1",
      huella: huellaDelCrudo,
      huellaDelPlan,
      plan,
      manifiesto,
      cierre,
      T0,
      ancla,
      T1,
      seleccion,
      filas,
      huellaCanonica,
      cargable: noCargable === null,
      motivoNoCargable: noCargable,
    },
  });
}

/** Líneas legibles para la consola. Sin secretos: el crudo no los contiene. */
export function describirVerificacion(r: ResultadoDeVerificacion): readonly string[] {
  const lineas: string[] = [
    r.ok
      ? "seed:verificar · OK"
      : `seed:verificar · FALLA · ${String(r.problemas.length)} problemas`,
    `huella del crudo:    ${r.huellaDelCrudo ?? "—"}`,
    `huella del plan:     ${r.huellaDelPlan ?? "—"}`,
    `huella del catálogo: ${r.huellaCanonica ?? "—"}`,
  ];
  for (const p of r.problemas.slice(0, 50)) {
    lineas.push(
      `  ✗ ${p.codigo}${p.fichero === undefined ? "" : ` [${p.fichero}]`}: ${p.detalle}`,
    );
  }
  if (r.problemas.length > 50)
    lineas.push(`  … y ${String(r.problemas.length - 50)} más`);
  const s = r.resumen;
  if (s !== null) {
    lineas.push(
      `captura ${s.capturaId} · ${s.estado} · ${s.motivo}${s.cortadoPorTope ? " · cortado por tope" : ""}`,
      `T0 ${s.T0} · S ${s.ancla} · T1 ${s.T1}`,
      `el ancla vence ${s.vencimientoDelAncla} (carga y primer deltas antes)`,
      `páginas ${String(s.paginas.total)} (confirmadas ${String(s.paginas.confirmadas)}, adoptadas ` +
        `${String(s.paginas.adoptadas)}, inválidas ${String(s.paginas.invalidas)}) · rondas ${String(s.rondas)}` +
        ` · completas ${String(s.rondasCompletas)}`,
      s.motivoNoCargable === null
        ? "cargable: sí"
        : `cargable: NO (${s.motivoNoCargable}${s.motivoNoCargable === "ronda_incompleta" ? ": íntegro y reanudable, nunca media ronda" : ""})`,
      `estratos agotados: ${s.estratosAgotados.length === 0 ? "ninguno" : s.estratosAgotados.join(", ")}`,
      `elegibles únicos ${String(s.unicosElegibles)} · sustituciones ${String(s.sustituciones)} · ` +
        `tipos distintos ${String(s.tiposDistintos)} · descartes ${String(s.descartes)}`,
    );
    for (const [estrato, c] of Object.entries(s.porEstrato)) {
      lineas.push(
        `  ${estrato}: shows ${String(c.shows)} · elegibles ${String(c.elegibles)} · sin identidad ` +
          `${String(c.sinIdentidad)} · sin oferta MVP ${String(c.sinOfertaMvp)} · repetidos ` +
          `${String(c.duplicadosEnEstrato)}`,
      );
    }
    const pares = Object.entries(s.pares);
    if (pares.length > 0) {
      lineas.push(
        `solapamiento: ${pares.map(([k, n]) => `${k}=${String(n)}`).join(" · ")}`,
      );
    }
    lineas.push(
      `filas: ${Object.entries(s.filas)
        .map(([t, n]) => `${t}=${String(n)}`)
        .join(" · ")}`,
    );
  }
  return lineas;
}
