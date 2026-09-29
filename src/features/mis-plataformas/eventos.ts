/**
 * Cualquier punto de la página puede pedir que se abra el selector de Mis
 * plataformas (la invitación de «Dónde verla», el menú móvil) sin compartir
 * estado con la cabecera, que es quien lo tiene: un evento del `window`.
 */
export const ABRIR_MIS_PLATAFORMAS = "ml:abrir-mis-plataformas";

export function abrirMisPlataformas(): void {
  window.dispatchEvent(new Event(ABRIR_MIS_PLATAFORMAS));
}

/**
 * Como `abrirMisPlataformas`, para quien se cierra al pedirlo (el menú móvil):
 * su botón ya no puede recibir el foco al cerrar la hoja, así que indica a qué
 * control ha de volver (WCAG 2.4.3).
 */
export function abrirMisPlataformasDesde(retorno: HTMLElement | null): void {
  window.dispatchEvent(new CustomEvent(ABRIR_MIS_PLATAFORMAS, { detail: { retorno } }));
}

/** El control al que devolver el foco, si quien abrió la hoja lo indicó. */
export function retornoDeAbrir(evento: Event): HTMLElement | null {
  const detalle: unknown = evento instanceof CustomEvent ? evento.detail : null;
  const retorno =
    detalle !== null && typeof detalle === "object" && "retorno" in detalle
      ? detalle.retorno
      : null;
  return retorno instanceof HTMLElement ? retorno : null;
}
