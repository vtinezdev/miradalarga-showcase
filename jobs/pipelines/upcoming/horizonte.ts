/**
 * Qué dice un recorrido del horizonte de `upcoming` **por lo que no lista**.
 * Solo mide: **no escribe nada**.
 *
 * ── Qué es un anuncio que desaparece ────────────────────────────────────────
 *
 * Una fila de `external_availability_announcements` (ADR 0007) cuya
 * `announced_for` cae dentro de la ventana del recorrido y que **esta
 * ejecución no observó**: ni su `last_seen_run_id` es el de esta ejecución ni
 * su `last_seen_at` es su `ahora`. Las dos condiciones, porque el ensayo y la
 * reproducción escriben `last_seen_run_id = NULL` —su ejecución vive en
 * memoria—: con solo el run id, una reproducción contaría como desaparecido
 * todo lo que la ejecución original ya había visto.
 *
 * ── La regla que este fichero protege ────────────────────────────────────────
 *
 * ⚖️ **Un anuncio que el proveedor deja de listar no se cancela.** Puede
 * haberse aplazado más allá del horizonte, haber cambiado de forma o haberse
 * cancelado de verdad, y no sabemos cuál. En esta versión **solo se cuenta**:
 * no se borra, no se marca y no toca la disponibilidad.
 *
 * Y solo se cuenta si la cifra significa algo:
 *
 *   · **Recorrido completo** (`hasMore=false` dentro del tope). Si no, `null`:
 *     el anuncio puede estar en una página que no se pidió.
 *   · **Todos los avisos atribuidos a un título.** Un aviso sin su show puede
 *     nombrar justo ese anuncio; con uno solo, `null`.
 *   · **Plataforma cubierta por el endpoint.** SkyShowtime **no lo está**: su
 *     ausencia aquí no dice nada, y se cuenta aparte, en `fueraDeCobertura`,
 *     nunca como desaparecida.
 */
import type { EjecutorSql } from "../../ops/contratos.ts";
import { PAIS } from "../deltas/contratos.ts";
import type { ResultadoDelHorizonte } from "../deltas/manifiesto.ts";
import { claveDeOferta } from "../seed/filas.ts";
import type { EntradaDeMedicion } from "../horizonte/medicion.ts";
import { MUESTRA_DE_DESAPARECIDAS, recorridoCompleto } from "../horizonte/medicion.ts";
import type { CheckpointDeUpcoming } from "./checkpoint.ts";

/**
 * Plataformas del MVP que el endpoint `upcoming` **no cubre**, por nuestro
 * `id`.
 *
 * ❌ Solo SkyShowtime: es el único caso en que 📄 la documentación del
 * proveedor y 📏 la medición (`raw/036`: HTTP 200, 0 avisos) coinciden en la
 * ausencia (`docs/DATA-SOURCES.md` §1.4, ADR 0003). Disney+ es ⚪ —documentado
 * como cubierto, 0 en la muestra— y **sí se evalúa**: una muestra vacía no
 * demuestra que la capacidad no exista.
 */
export const PLATAFORMAS_SIN_UPCOMING: ReadonlySet<string> = new Set(["skyshowtime"]);

/**
 * Anuncios con `announced_for` dentro de la ventana que esta ejecución no
 * observó. `$1` país · `$2`, `$3` la ventana · `$4` el `ahora` · `$5` el run
 * que escribió esta ejecución (`NULL` en ensayo y reproducción).
 *
 * ⚠️ El alias es `vigente`: `anuncio` es el de la lectura por títulos
 * (`deltas/anuncios.ts`), y los dobles de los tests los distinguen así.
 */
export const SQL_ANUNCIOS_NO_OBSERVADOS = `
  SELECT t.imdb_id, vigente.platform_id, vigente.offer_type, vigente.addon
    FROM external_availability_announcements vigente
    JOIN external_titles t ON t.id = vigente.title_id
   WHERE vigente.country = $1
     AND vigente.announced_for >= $2::timestamptz
     AND vigente.announced_for <= $3::timestamptz
     AND vigente.last_seen_at < $4::timestamptz
     AND vigente.last_seen_run_id IS DISTINCT FROM $5::bigint`;

/** El resultado del recorrido, con la forma que guarda el manifiesto. */
export interface MedicionDeUpcoming extends ResultadoDelHorizonte {
  readonly fueraDeCobertura: number | null;
}

export interface EntradaDeMedicionDeUpcoming extends EntradaDeMedicion<CheckpointDeUpcoming> {
  /** El `ahora` de la ejecución: el `last_seen_at` que escribió. */
  readonly ahora: Date;
  /** El `last_seen_run_id` que escribió: `null` en ensayo y reproducción. */
  readonly runId: number | null;
}

interface FilaNoObservada {
  readonly imdb_id: string;
  readonly platform_id: string;
  readonly offer_type: string;
  readonly addon: string | null;
}

export async function medirHorizonteDeUpcoming(
  ejecutor: EjecutorSql,
  entrada: EntradaDeMedicionDeUpcoming,
): Promise<MedicionDeUpcoming> {
  if (!recorridoCompleto(entrada)) {
    return {
      completo: false,
      desaparecidas: null,
      muestra: [],
      fueraDeCobertura: null,
    };
  }
  const { ventana } = entrada.checkpoint;
  const filas = await ejecutor.ejecutar<FilaNoObservada>(SQL_ANUNCIOS_NO_OBSERVADOS, [
    PAIS,
    new Date(ventana.from * 1000),
    new Date(ventana.to * 1000),
    entrada.ahora,
    entrada.runId,
  ]);
  const claves = new Map<string, string>();
  for (const f of filas) {
    claves.set(
      claveDeOferta(f.imdb_id, f.platform_id, f.offer_type, f.addon),
      f.platform_id,
    );
  }
  const ordenadas = [...claves.keys()].sort();
  const cubiertas = ordenadas.filter(
    (c) => !PLATAFORMAS_SIN_UPCOMING.has(claves.get(c) ?? ""),
  );
  const fueraDeCobertura = ordenadas.length - cubiertas.length;

  if (entrada.informe.avisosSinShow > 0) {
    return { completo: true, desaparecidas: null, muestra: [], fueraDeCobertura };
  }
  return {
    completo: true,
    desaparecidas: cubiertas.length,
    muestra: cubiertas.slice(0, MUESTRA_DE_DESAPARECIDAS),
    fueraDeCobertura,
  };
}
