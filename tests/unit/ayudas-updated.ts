/**
 * Dobles para probar `updated` sin red y sin base de datos: sembrar un estado
 * de partida, servir páginas y pasar el núcleo con **las mismas opciones que
 * su estrategia** (`estrategiaDeUpdated`), para que un test no pueda probar
 * otra cosa que la que corre de verdad.
 */
import { showProveedor } from "../../jobs/adapters/streaming-availability/schema.ts";
import { normalizarShow } from "../../jobs/adapters/streaming-availability/normalizar.ts";
import { ejecutarDeltas } from "../../jobs/pipelines/deltas/index.ts";
import { transaccionPorPagina } from "../../jobs/pipelines/deltas/job.ts";
import { construirFilas } from "../../jobs/pipelines/seed/filas.ts";
import { ejecutarSeed } from "../../jobs/pipelines/seed/index.ts";
import { clasificarUpdated } from "../../jobs/pipelines/updated/clasificacion.ts";
import { estrategiaDeUpdated } from "../../jobs/pipelines/updated/job.ts";
import { crearTransporteFalso } from "./ayudas-deltas.ts";
import type { BaseEnMemoria } from "./base-en-memoria.ts";

/** Escribe estos shows como el estado observado en `observadoEn`. */
export async function sembrar(
  base: BaseEnMemoria,
  observadoEn: Date,
  shows: readonly unknown[],
): Promise<void> {
  await ejecutarSeed(
    base.ejecutor,
    construirFilas(
      shows.map((s) => {
        const titulo = normalizarShow(showProveedor.parse(s), "es");
        if (titulo === null) throw new Error("Semilla sin identidad: no se siembra.");
        return { titulo, observadoEn, observadoPorOpcion: new Map() };
      }),
    ),
  );
}

/** Una ejecución de `updated` sobre estas páginas, con su clasificación. */
export async function observarUpdated(
  base: BaseEnMemoria,
  ahora: Date,
  paginas: readonly Record<string, unknown>[],
) {
  const estrategia = estrategiaDeUpdated("prohibido");
  const red = crearTransporteFalso(paginas);
  const informe = await ejecutarDeltas({
    ejecutor: base.ejecutor,
    peticion: { transporte: red.transporte, apiKey: "k" },
    tipos: ["updated"],
    ventana: null,
    ahora,
    maximoDePaginas: 10,
    transaccion: transaccionPorPagina(base.ejecutor),
    interpretarAusencias: estrategia.interpretarAusencias,
    ...(estrategia.soloTitulosConocidos === true ? { soloTitulosConocidos: true } : {}),
    ...(estrategia.detallarOfertas === true ? { detallarOfertas: true } : {}),
    ...(estrategia.reconciliarCalidadDesconocida === false
      ? { reconciliarCalidadDesconocida: false }
      : {}),
  });
  if (informe.detalle === null) throw new Error("updated tiene que detallar");
  const clasificacion = clasificarUpdated(
    informe.detalle,
    ahora,
    informe.titulosFueraDeCatalogo,
  );
  return { informe, clasificacion, red };
}

/** `BaseEnMemoria.foto()` con su forma, para no repetir el cast en cada test. */
export interface Foto {
  readonly titulos: readonly string[];
  readonly ofertas: readonly {
    readonly oferta: string;
    readonly lastCheckedAt: unknown;
  }[];
  readonly opciones: readonly {
    readonly oferta: string;
    readonly link: string;
    readonly videoLink: string | null;
    readonly quality: string | null;
    readonly priceAmount: string | null;
    readonly audioLanguages: readonly string[];
    readonly subtitleLanguages: readonly string[];
    readonly missingStreak: number;
    /** ISO, o `"—"` con `instantes: false`. */
    readonly firstSeenAt: string;
  }[];
  readonly eventos: readonly { readonly oferta: string; readonly tipo: string }[];
}

export function foto(base: BaseEnMemoria, instantes = true): Foto {
  return base.foto({ instantes }) as Foto;
}
