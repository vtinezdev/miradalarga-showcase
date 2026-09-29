import s from "./MarcaMia.module.css";

/**
 * «Tus plataformas» dentro de un enlace o una fila con `data-plataforma`: el
 * punto latón **y** el texto accesible «, en tus plataformas» (nunca solo
 * color). Los enciende el CSS del layout antes del primer pintado (`--mia-*`),
 * sin JavaScript de React y sin mover nada.
 */
export function MarcaMia({ posicion }: { posicion: "punto" | "texto" }) {
  return posicion === "punto" ? (
    <span className={s.punto} aria-hidden="true" />
  ) : (
    <span className={s.texto}>, en tus plataformas</span>
  );
}
