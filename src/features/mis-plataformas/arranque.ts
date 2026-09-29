import { ATRIBUTO, scriptInicial } from "./almacen.ts";

/**
 * Lo que el layout inyecta en `<head>` para que Mis plataformas resalte **antes
 * del primer pintado** y sin JavaScript de React:
 *
 * - el script que copia la selección de `localStorage` al atributo de `<html>`;
 * - una regla CSS por plataforma que, si su `id` está en el atributo, activa
 *   las propiedades `--mia-*` en todo `[data-plataforma="id"]`. Cada componente
 *   decide qué hacer con ellas en su CSS Module.
 *
 * Se genera desde las plataformas del dato, no de una lista escrita a mano.
 */

const ID_SEGURO = /^[a-z0-9-]+$/;

export function idsSeguros(ids: readonly string[]): string[] {
  // Los ids acaban dentro de un selector CSS y de un script: solo se aceptan
  // los que no pueden romper ninguno de los dos.
  return ids.filter((id) => ID_SEGURO.test(id));
}

export function cssDeMisPlataformas(ids: readonly string[]): string {
  const reglas = idsSeguros(ids).map(
    (id) =>
      `html[${ATRIBUTO}~="${id}"] [data-plataforma="${id}"]{--mia-display:inline-block;--mia-texto:inline;--mia-borde:var(--color-accent);--mia-fondo:var(--color-accent-tint);--mia-check:1;--mia-oculto:none}`,
  );
  // Elementos que solo tienen sentido con o sin selección (invitaciones,
  // «Quitar todas»): se muestran u ocultan por CSS, así que no saltan al hidratar.
  reglas.push(`html[${ATRIBUTO}] .ml-sin-seleccion{display:none}`);
  reglas.push(`html:not([${ATRIBUTO}]) .ml-con-seleccion{display:none}`);
  return reglas.join("\n");
}

export function scriptDeMisPlataformas(ids: readonly string[]): string {
  return scriptInicial(idsSeguros(ids));
}
