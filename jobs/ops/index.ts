/**
 * API pública del plano `ops_*`.
 *
 * Un pipeline solo necesita `ejecutarJob`, `leerPresupuesto` y
 * `crearTransporte`. El resto se exporta para los tests y el harness.
 */
export {
  ESCRIBE_CATALOGO,
  ESCRIBE_CATALOGO_POR_FASE_DEL_SEED,
  FASES_DEL_SEED,
  escribeCatalogo,
  MOTIVOS_QUE_NO_SON_DE_PRESUPUESTO,
  NOMBRES_DE_PIPELINE,
  PIPELINE_ID,
  PresupuestoAgotado,
  idDeEjecucion,
} from "./contratos.ts";
export type {
  CicloDePresupuesto,
  EjecutorSql,
  EstadoDeEjecucion,
  EstadoFinal,
  FaseDelSeed,
  FilasAfectadas,
  MetricasDeEjecucion,
  MotivoDeDenegacion,
  MuestraDeError,
  NombreDePipeline,
  Presupuesto,
  Reserva,
} from "./contratos.ts";

export {
  CLAVE_CATALOGO,
  NS_CATALOGO,
  NS_CICLO,
  NS_PIPELINE,
  bloquearCiclo,
  soltarLockDeCatalogo,
  soltarLockDePipeline,
  tomarLockDeCatalogo,
  tomarLockDePipeline,
} from "./bloqueo.ts";

export {
  DIA_DE_CICLO_MAXIMO,
  EXCEPCIONES_AL_INVARIANTE,
  GUARDRAIL_DE_MEDICION_MANUAL,
  TECHO_MENSUAL_POR_DEFECTO,
  TOPE_POR_EJECUCION_POR_DEFECTO,
  ZONA_DE_FACTURACION,
  calcularCiclo,
  calcularUmbralGlobal,
  decidirReserva,
  leerPresupuesto,
  reservar,
} from "./presupuesto.ts";

export { ZONA_EDITORIAL, horaEnMadrid, medianocheEnMadrid } from "./tiempo.ts";

export {
  MAXIMO_DE_MUESTRAS,
  abrirEjecucion,
  cerrarEjecucion,
  crearMedidor,
  ejecutarJob,
  reconciliarHuerfanas,
} from "./ejecucion.ts";
export type {
  ContextoDeEjecucion,
  Medidor,
  MotivoDeNoEjecucion,
  ResultadoDeJob,
} from "./ejecucion.ts";

/**
 * Coste medido por recorrido. **Observabilidad, no autorización.**
 * Se exporta para documentar y planificar; `reservar()` no lo ve.
 */
export { COSTE_ESPERADO_POR_EJECUCION } from "./costes-medidos.ts";

export { TIEMPO_MAXIMO_POR_REQUEST_MS, crearTransporte } from "./transporte.ts";
export {
  FRACCION_DE_CORTE_DEL_PROVEEDOR,
  MUESTRA_DE_CORTE_POR_UMBRAL,
  buscarCorteVigente,
  crearGuardiaDeCuotaExterna,
  leerCuotaDelProveedor,
} from "./cuota-proveedor.ts";
export type {
  CorteVigente,
  CuotaDelProveedor,
  GuardiaDeCuotaExterna,
} from "./cuota-proveedor.ts";
export { describirFallo, sanearTexto } from "./diagnostico.ts";
export type { FalloDeEjecucion } from "./diagnostico.ts";
export type { FuenteDeCuota, Transporte } from "./transporte.ts";
