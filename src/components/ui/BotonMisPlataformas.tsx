"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { Plataforma } from "@/features/catalogo/modelo.ts";
import {
  ABRIR_MIS_PLATAFORMAS,
  retornoDeAbrir,
} from "@/features/mis-plataformas/eventos.ts";
import {
  alCambiarMisPlataformas,
  useMisPlataformas,
} from "@/features/mis-plataformas/estado.ts";
import { cx } from "@/lib/cx.ts";
import { clasesDeBoton } from "./Button.tsx";
import { IconoPlataformas } from "./iconos.tsx";
import { PlatformSelector } from "./PlatformSelector.tsx";
import { Sheet } from "./Sheet.tsx";
import s from "./Header.module.css";

/**
 * Acción «Mis plataformas» de la cabecera: muestra cuántas hay marcadas y abre
 * el selector en una hoja. Cualquier otra parte de la página puede abrirla con
 * `abrirMisPlataformas()`.
 *
 * Cuando alguien cambia la selección, la cifra nueva entra desde abajo (un
 * cambio de estado visible; no al cargar la página).
 */
export function BotonMisPlataformas({ plataformas }: { plataformas: Plataforma[] }) {
  const [abierto, setAbierto] = useState(false);
  const { seleccion } = useMisPlataformas(plataformas.map((p) => p.id));
  const idTitulo = useId();
  const [cambios, setCambios] = useState(0);
  // Quien abrió la hoja y se cerró al hacerlo (el menú móvil): a él vuelve el foco.
  const retorno = useRef<HTMLElement | null>(null);

  useEffect(() => alCambiarMisPlataformas(() => setCambios((n) => n + 1)), []);

  useEffect(() => {
    const abrir = (evento: Event) => {
      retorno.current = retornoDeAbrir(evento);
      setAbierto(true);
    };
    window.addEventListener(ABRIR_MIS_PLATAFORMAS, abrir);
    return () => window.removeEventListener(ABRIR_MIS_PLATAFORMAS, abrir);
  }, []);

  useEffect(() => {
    // El retorno nativo apunta al botón del menú, ya cerrado y sin foco posible:
    // el foco se queda en el selector recién cerrado, así que se lleva a mano.
    if (abierto || !retorno.current) return;
    retorno.current.focus();
    retorno.current = null;
  }, [abierto]);

  const cuantas = seleccion.length;
  return (
    <>
      <button
        type="button"
        className={s.accion}
        aria-haspopup="dialog"
        onClick={() => setAbierto(true)}
      >
        <IconoPlataformas tamano="m" />
        <span className={s.textoAccion}>Mis plataformas</span>
        {/* Hueco reservado: el número aparece al hidratar sin mover la cabecera. */}
        <span
          key={cambios}
          className={cx(s.recuento, cambios > 0 && s.recuentoCambia)}
          aria-hidden="true"
        >
          {cuantas > 0 ? cuantas : ""}
        </span>
        <span className="sr-only">
          {cuantas > 0 ? `, ${cuantas} ${cuantas === 1 ? "marcada" : "marcadas"}` : ""}
        </span>
      </button>
      <Sheet
        abierto={abierto}
        alCerrar={() => setAbierto(false)}
        titulo="Mis plataformas"
        idTitulo={idTitulo}
      >
        <PlatformSelector plataformas={plataformas} variante="hoja" />
        <button
          type="button"
          className={`${clasesDeBoton.base} ${clasesDeBoton.principal}`}
          onClick={() => setAbierto(false)}
        >
          Listo
        </button>
      </Sheet>
    </>
  );
}
