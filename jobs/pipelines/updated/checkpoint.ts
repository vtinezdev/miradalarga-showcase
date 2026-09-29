/**
 * El **checkpoint** de `updated`: el checkpoint v1 de una ventana **contigua
 * hacia atrás** (`deltas/checkpoint.ts`, `checkpointsContiguos`) con un solo
 * tipo, `updated`. Es la estrategia de `deltas`, no la del horizonte:
 *
 *   · `updated` mira **hacia atrás**: qué cambió desde la última ventana. 📏
 *     La query medida es la de `new` y `removed` —`from = ahora − 24 h`,
 *     `to = ahora`, sin `include_unknown_dates`— (`raw/055`, `raw/056`).
 *   · Las ventanas son **contiguas** y una cortada se **reanuda** con su cursor
 *     (ADR 0006): un cambio que se deja atrás no vuelve a listarse.
 *
 * Un checkpoint de `updated` nunca pasa por uno de `deltas`, ni al revés: cada
 * uno admite solo sus tipos, y cada pipeline lee solo el suyo.
 */
import { z } from "zod";

import type { NombreDePipeline } from "../../ops/contratos.ts";
import type { CheckpointContiguo } from "../deltas/checkpoint.ts";
import { checkpointsContiguos } from "../deltas/checkpoint.ts";

export const PIPELINE_UPDATED: NombreDePipeline = "updated";

export const tipoDeUpdated = z.enum(["updated"]);
export type TipoDeUpdated = z.infer<typeof tipoDeUpdated>;

export const TIPOS_DE_UPDATED: readonly TipoDeUpdated[] = ["updated"];

export type CheckpointDeUpdated = CheckpointContiguo<TipoDeUpdated>;

export const CHECKPOINTS_DE_UPDATED = checkpointsContiguos<TipoDeUpdated>(
  PIPELINE_UPDATED,
  tipoDeUpdated,
);
