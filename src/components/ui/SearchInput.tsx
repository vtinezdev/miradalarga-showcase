import { cx } from "@/lib/cx.ts";
import { IconoBuscar } from "./iconos.tsx";
import s from "./SearchInput.module.css";

/**
 * Campo de búsqueda (DS §8.6). Un formulario GET corriente: funciona sin
 * JavaScript y **sin autocompletado en vivo** en el MVP (cada pulsación sería
 * una invocación del Worker). Etiqueta visible, nunca solo `placeholder`.
 */
export function SearchInput({
  id,
  valorInicial = "",
  autoFocus = false,
  grande = false,
  className,
}: {
  id: string;
  valorInicial?: string;
  /** Solo en `/buscar` sin consulta: quien llega ahí viene a escribir. */
  autoFocus?: boolean;
  grande?: boolean;
  className?: string | undefined;
}) {
  return (
    <form
      role="search"
      action="/buscar"
      method="get"
      className={cx(s.formulario, grande && s.grande, className)}
    >
      <label htmlFor={id} className={s.etiqueta}>
        Busca una película o serie
      </label>
      <div className={s.campo}>
        <IconoBuscar tamano="m" className={s.icono} />
        <input
          id={id}
          className={s.entrada}
          type="search"
          name="q"
          defaultValue={valorInicial}
          placeholder="Título, en español o en su idioma original"
          autoComplete="off"
          // Solo en /buscar sin consulta: quien llega ahí viene a escribir (DS §8.6).
          autoFocus={autoFocus}
          maxLength={100}
          enterKeyHint="search"
        />
        <button type="submit" className={s.enviar}>
          Buscar
        </button>
      </div>
    </form>
  );
}
