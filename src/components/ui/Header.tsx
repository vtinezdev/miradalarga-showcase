import type { Plataforma } from "@/features/catalogo/modelo.ts";
import { NOMBRE } from "@/lib/sitio.ts";
import { BotonMisPlataformas } from "./BotonMisPlataformas.tsx";
import { FolioCorrido } from "./FolioCorrido.tsx";
import { IconoBuscar } from "./iconos.tsx";
import { MobileNavigation } from "./MobileNavigation.tsx";
import { Navigation } from "./Navigation.tsx";
import s from "./Header.module.css";
import { Enlace } from "./Enlace.tsx";

/**
 * Cabecera fija (DS §8.1): marca, navegación primaria y las acciones Buscar y
 * Mis plataformas. Servidor, con islas mínimas de cliente. El logotipo es un
 * enlace, no el `h1`.
 *
 * **Contextual** (interacción de firma 6): al bajar se compacta ligeramente y
 * su filete inferior se convierte en el horizonte de la página, con el punto
 * latón marcando cuánto se ha leído. Las dos cosas son CSS vinculado al scroll,
 * sin JavaScript; donde el navegador no lo soporta, la cabecera se queda fija y
 * entera. Nunca se oculta.
 */
export function Header({ plataformas }: { plataformas: Plataforma[] }) {
  return (
    <header className={s.cabecera}>
      <a className={s.saltar} href="#contenido">
        Saltar al contenido
      </a>
      <div className={`contenedor ${s.fila}`}>
        <Enlace href="/" className={s.marca}>
          <span className={s.wordmark}>{NOMBRE}</span>
          <span className={s.horizonte} aria-hidden="true" />
        </Enlace>
        <FolioCorrido />
        <Navigation className={s.nav} />
        <div className={s.acciones}>
          <Enlace href="/buscar" className={s.accion}>
            <IconoBuscar tamano="m" />
            <span className={s.textoAccion}>Buscar</span>
          </Enlace>
          <BotonMisPlataformas plataformas={plataformas} />
          <MobileNavigation />
        </div>
      </div>
      <div className={s.progreso} aria-hidden="true">
        <span className={s.carroProgreso} />
      </div>
    </header>
  );
}
