/**
 * **Qué trajo un recorrido de `upcoming`**, sacado del crudo de sus páginas
 * confirmadas. Función pura: no toca la base ni la red, así que una
 * reproducción desde el crudo tiene que dar exactamente lo mismo.
 *
 * Es la vista **del proveedor**; lo que los anuncios hicieron con la base lo
 * cuenta `InformeDeAnuncios` (`deltas/anuncios.ts`). Lo que se mide aquí:
 *
 *   · 📏 **Anuncios sin `link`.** En `raw/032` los **4 de 4** anuncios de Prime
 *     Video llegan sin él, y 3 de 3 en la fila 50. Desde el ADR 0007 se
 *     guardan en `external_availability_announcements` con `link = NULL`;
 *     aquí queda su detalle tal y como llegó.
 *   · **Cobertura por plataforma**, con `hbo` ya traducido a `max`. Un cero
 *     es un dato de esta ventana, no una capacidad: no se extrapola.
 *   · **Rarezas que el pipeline procesa sin quejarse**: avisos fuera de la
 *     ventana pedida, repetidos, sin show o de ofertas ya en el catálogo.
 */
import { normalizarPaginaDeCambios } from "../../adapters/streaming-availability/normalizar-cambios.ts";
import { respuestaCambiosProveedor } from "../../adapters/streaming-availability/schema.ts";
import { PAIS } from "../deltas/contratos.ts";
import type { AnuncioSinEnlace, ResumenDeAnuncios } from "../deltas/manifiesto.ts";
import { PLATAFORMAS_MVP, plataformaDesdeFuente } from "../seed/plataformas.ts";

/** Cuántos anuncios sin enlace se detallan. El total es siempre completo. */
export const MUESTRA_DE_SIN_ENLACE = 50;

const ceros = (): Record<string, number> =>
  Object.fromEntries(PLATAFORMAS_MVP.map((p) => [p.id, 0]));

const sumar = (r: Record<string, number>, clave: string) => {
  r[clave] = (r[clave] ?? 0) + 1;
};

/**
 * @param cuerpos los cuerpos JSON de las páginas **confirmadas**, en orden.
 * @param entrada la ventana pedida (segundos UNIX) y si el recorrido terminó.
 */
export function resumirAnuncios(
  cuerpos: readonly unknown[],
  entrada: {
    readonly ventana: { readonly from: number; readonly to: number };
    readonly completo: boolean;
  },
): ResumenDeAnuncios {
  const porPlataforma = ceros();
  const fueraDelMvp: Record<string, number> = {};
  const sinEnlacePorPlataforma = ceros();
  const sinEnlace: AnuncioSinEnlace[] = [];
  const vistas = new Set<string>();
  let avisos = 0;
  let totalSinEnlace = 0;
  let sinDisponibilidadEnEs = 0;
  let yaEnElCatalogo = 0;
  let sinShow = 0;
  let antes = 0;
  let despues = 0;
  let repetidos = 0;

  for (const cuerpo of cuerpos) {
    const pagina = normalizarPaginaDeCambios(
      respuestaCambiosProveedor.parse(cuerpo),
      PAIS,
    );
    for (const aviso of pagina.avisos) {
      avisos++;
      const nuestra = plataformaDesdeFuente(aviso.plataformaId);
      if (nuestra === null) sumar(fueraDelMvp, aviso.plataformaId);
      else sumar(porPlataforma, nuestra);

      const segundos = Math.floor(aviso.instante.getTime() / 1000);
      if (segundos < entrada.ventana.from) antes++;
      if (segundos > entrada.ventana.to) despues++;

      const firma = [
        aviso.idProveedor,
        aviso.plataformaId,
        aviso.tipoOferta,
        aviso.addon ?? "",
      ].join("|");
      if (vistas.has(firma)) repetidos++;
      vistas.add(firma);

      const titulo = pagina.titulos.get(aviso.idProveedor);
      if (titulo === undefined) sinShow++;
      else {
        if (titulo.disponibilidad.length === 0) sinDisponibilidadEnEs++;
        const listada = titulo.disponibilidad.some(
          (d) =>
            d.plataformaId === aviso.plataformaId &&
            d.tipoOferta === aviso.tipoOferta &&
            d.addon === aviso.addon,
        );
        if (listada) yaEnElCatalogo++;
      }

      if (aviso.enlace === null) {
        totalSinEnlace++;
        sumar(sinEnlacePorPlataforma, nuestra ?? aviso.plataformaId);
        if (sinEnlace.length < MUESTRA_DE_SIN_ENLACE) {
          sinEnlace.push({
            idProveedor: aviso.idProveedor,
            imdbId: titulo?.ids.imdbId ?? null,
            plataforma: nuestra ?? aviso.plataformaId,
            tipoOferta: aviso.tipoOferta,
            addon: aviso.addon,
            instante: aviso.instante.toISOString(),
          });
        }
      }
    }
  }

  return {
    paginas: cuerpos.length,
    completo: entrada.completo,
    avisos,
    porPlataforma,
    fueraDelMvp,
    sinEnlace: {
      total: totalSinEnlace,
      porPlataforma: sinEnlacePorPlataforma,
      muestra: sinEnlace,
    },
    sinDisponibilidadEnEs,
    yaEnElCatalogo,
    sinShow,
    fueraDelHorizonte: { antes, despues },
    repetidos,
  };
}
