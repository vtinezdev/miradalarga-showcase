/**
 * Errores del adaptador de lectura de Neon: **claros, con contexto y sin
 * secretos**. Un fallo de la base nunca se degrada a datos de desarrollo
 * (`proveedor.ts`): llega a la página como error, con la operación que falló.
 *
 * Nada de lo que sale de aquí puede llevar una cadena de conexión, un usuario
 * o una contraseña: el mensaje del driver pasa por `sanear` antes de guardarse,
 * y la causa original **no se encadena** (`cause` la volvería a exponer al
 * serializar el error).
 */

export type MotivoDeFallo =
  /** La configuración de la fuente es inválida: se detiene antes de conectar. */
  | "configuracion"
  /** La consulta o la conexión fallaron. */
  | "consulta"
  /** La base respondió con una forma que el adaptador no sabe leer. */
  | "forma"
  /** La base está vacía donde el contrato exige un dato (regla 7: no se inventa). */
  | "sin_datos";

export class ErrorDeCatalogo extends Error {
  override readonly name = "ErrorDeCatalogo";

  constructor(
    readonly motivo: MotivoDeFallo,
    /** La operación del puerto que falló: `ficha`, `movimientos`… */
    readonly operacion: string,
    detalle: string,
  ) {
    super(`Catálogo (Neon) · ${operacion} · ${motivo}: ${sanear(detalle)}`);
  }
}

/**
 * Quita de un texto cualquier cosa que parezca una credencial: URLs de
 * PostgreSQL completas, `usuario:contraseña@`, parámetros `password=` y tiradas
 * largas con pinta de token. Es la misma política que `sanearTexto` de los jobs
 * (`jobs/ops/diagnostico.ts`), que la web no puede importar (Plan §19.3).
 */
export function sanear(texto: string): string {
  return texto
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "<conexión redactada>")
    .replace(/[^\s/@:]+:[^\s/@]+@/g, "<credencial redactada>@")
    .replace(/\b(password|passwd|pwd|token|apikey|api_key)=[^\s&]+/gi, "$1=<redactado>")
    .replace(
      /\b[A-Za-z0-9_-]{32,}\b/g,
      (t) => `<token de ${String(t.length)} caracteres>`,
    )
    .slice(0, 500);
}

/** Envuelve un error del driver en uno saneado, con la operación. */
export function comoErrorDeCatalogo(
  operacion: string,
  error: unknown,
): ErrorDeCatalogo {
  if (error instanceof ErrorDeCatalogo) return error;
  const mensaje = error instanceof Error ? error.message : String(error);
  return new ErrorDeCatalogo("consulta", operacion, mensaje);
}
