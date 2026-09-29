/**
 * Cómo se cuenta un fallo de ejecución **sin filtrar secretos**.
 *
 * ── Por qué existe este fichero ─────────────────────────────────────────────
 *
 * `ejecutarJob` captura la excepción, la guarda en `error_samples` y cierra la
 * fila como `failed`. Eso es correcto —una ejecución que revienta no puede
 * llevarse el proceso por delante— pero tiene un efecto secundario feo: **quien
 * llama recibe un resultado y no una excepción**, así que si no imprime las
 * métricas, el motivo del fallo se queda dentro de la fila y nadie lo ve.
 *
 * Pasó de verdad: la primera ejecución real del harness de `/changes` terminó
 * `failed` con `requests_made = 0`, y el informe no dijo por qué.
 *
 * ⚠️ Estas muestras vienen de excepciones reales, y un mensaje de error es uno
 * de los sitios por los que se escapa una credencial: la cadena de conexión
 * completa en un fallo de red, la cabecera `X-API-Key` en un error del
 * transporte, un token en una query. Por eso **todo pasa por `sanearTexto`
 * antes de imprimirse**.
 */
import type { EstadoFinal, MetricasDeEjecucion } from "./contratos.ts";

/** Parámetros de query cuyo valor no se imprime jamás. */
const PARAMETROS_SENSIBLES =
  /\b(api[-_]?key|key|token|secret|password|passwd|pwd)=[^&\s"']+/gi;

/**
 * Deja un texto publicable.
 *
 * Es deliberadamente **agresivo**: prefiere tapar de más a dejar escapar una
 * credencial. Lo que tapa se marca, para que se note que había algo y no
 * parezca que el mensaje venía así.
 */
export function sanearTexto(texto: string): string {
  return (
    texto
      // Cadenas de conexión completas, con usuario y contraseña dentro.
      .replace(/postgres(?:ql)?:\/\/\S+/gi, "<conexión redactada>")
      // La cabecera del proveedor. El nombre y el valor pueden venir
      // entrecomillados —`{ "X-API-Key": "…" }` es justo como los imprime un
      // error de JavaScript—, así que las comillas son opcionales a los dos
      // lados del separador.
      .replace(
        /["']?\bx-api-key\b["']?\s*[:=]\s*["']?[^\s,;"'}\])]+["']?/gi,
        "X-API-Key <redactada>",
      )
      // Parámetros sensibles en una URL.
      .replace(PARAMETROS_SENSIBLES, (coincidencia) => {
        const nombre = coincidencia.split("=")[0] ?? "valor";
        return `${nombre}=<redactado>`;
      })
      // Cualquier tirada larga que huela a credencial. Se conserva la longitud
      // porque distingue «faltaba la clave» de «la clave era otra».
      .replace(
        /\b[A-Za-z0-9_-]{32,}\b/g,
        (t) => `<token de ${String(t.length)} caracteres>`,
      )
  );
}

/** Sanea un valor cualquiera de una muestra, sin perder su forma. */
function sanearValor(valor: unknown): unknown {
  if (typeof valor === "string") return sanearTexto(valor);
  if (Array.isArray(valor)) return valor.map(sanearValor);
  if (valor !== null && typeof valor === "object") {
    const salida: Record<string, unknown> = {};
    for (const [clave, v] of Object.entries(valor as Record<string, unknown>)) {
      salida[clave] = sanearValor(v);
    }
    return salida;
  }
  return valor;
}

export interface FalloDeEjecucion {
  readonly estado: EstadoFinal;
  readonly runId: number;
  /**
   * Cuántas **reservas de cuota se concedieron**, que es lo que de verdad se
   * gastó.
   *
   * ⚠️ **No es lo mismo que cuántas respuestas se procesaron**, y confundirlos
   * mintió en la primera ejecución real: la request salió, reservó su cuota y
   * el parser reventó después, así que el informe contó 0 páginas y cantó
   * «0 / 5» mientras `ops_sync_runs.requests_made` decía 1. La cuota se gasta
   * al reservar, no al entender la respuesta.
   */
  readonly requestsReservadas: number;
  readonly metricas: MetricasDeEjecucion;
}

/**
 * El diagnóstico, línea a línea. **Función pura:** no imprime, devuelve.
 *
 * Que sea pura es lo que permite probarla, y probarla es lo que impide que un
 * cambio futuro vuelva a dejar el motivo dentro de la fila.
 */
export function describirFallo(fallo: FalloDeEjecucion): readonly string[] {
  const lineas: string[] = [];
  const { metricas } = fallo;

  lineas.push("DIAGNÓSTICO DEL FALLO");
  lineas.push(`  ejecución         ops_sync_runs id ${String(fallo.runId)}`);
  lineas.push(`  estado            ${fallo.estado}`);
  lineas.push(`  errores contados  ${String(metricas.errorCount)}`);

  // La frase que distingue «se rompió antes de llamar» de «llamó, pagó, y se
  // rompió al leer la respuesta». Son dos averías distintas y una de ellas
  // cuesta cuota.
  lineas.push("");
  if (fallo.requestsReservadas === 0) {
    lineas.push("  ⚠️  Fallo previo a la primera request; cuota consumida: 0");
  } else {
    lineas.push(
      "  ⚠️  La request llegó a reservarse antes del fallo; cuota consumida: " +
        String(fallo.requestsReservadas),
    );
  }

  if (metricas.errorSamples.length === 0) {
    lineas.push("");
    lineas.push("  Sin muestras de error: la ejecución cerró sin registrar ninguna.");
    return lineas;
  }

  lineas.push("");
  lineas.push(
    `  Muestras (${String(metricas.errorSamples.length)} de ${String(metricas.errorCount)}, ya saneadas):`,
  );

  metricas.errorSamples.forEach((muestra, i) => {
    lineas.push(`    ── muestra ${String(i + 1)} ──`);
    for (const [clave, valor] of Object.entries(muestra)) {
      const limpio = sanearValor(valor);
      const texto = typeof limpio === "string" ? limpio : JSON.stringify(limpio);
      lineas.push(`      ${clave}: ${texto ?? "null"}`);
    }
  });

  return lineas;
}
