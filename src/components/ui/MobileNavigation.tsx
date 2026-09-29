"use client";

import { useId, useRef, useState, type CSSProperties } from "react";
import { abrirMisPlataformasDesde } from "@/features/mis-plataformas/eventos.ts";
import { CONFIANZA, DESTINOS } from "@/lib/navegacion.ts";
import { EnlaceDeNavegacion } from "./EnlaceDeNavegacion.tsx";
import { IconoMenu } from "./iconos.tsx";
import { Sheet } from "./Sheet.tsx";
import h from "./Header.module.css";
import s from "./MobileNavigation.module.css";
import { Enlace } from "./Enlace.tsx";

/**
 * Menú por debajo de `--bp-lg`: botón + hoja a pantalla completa con los cinco
 * destinos en tipografía grande, numerados como el sumario de una edición, Mis
 * plataformas y los enlaces de confianza (INFORMATION-ARCHITECTURE.md §4). Sin
 * barra inferior.
 */
export function MobileNavigation() {
  const [abierto, setAbierto] = useState(false);
  const idTitulo = useId();
  const botonMenu = useRef<HTMLButtonElement>(null);
  const cerrar = () => setAbierto(false);
  return (
    <div className={s.movil}>
      <button
        ref={botonMenu}
        type="button"
        className={h.accion}
        aria-haspopup="dialog"
        aria-expanded={abierto}
        onClick={() => setAbierto(true)}
      >
        <IconoMenu tamano="m" />
        <span className={h.textoAccion}>Menú</span>
      </button>
      <Sheet
        abierto={abierto}
        alCerrar={cerrar}
        titulo="Menú"
        idTitulo={idTitulo}
        variante="completa"
      >
        <nav aria-label="Principal">
          <ul role="list" className={s.destinos}>
            {DESTINOS.map((d, i) => (
              <li key={d.href} style={{ "--i": i } as CSSProperties}>
                <span className={s.numero} aria-hidden="true">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <EnlaceDeNavegacion
                  href={d.href}
                  etiqueta={d.etiqueta}
                  className={s.destino}
                  onNavegar={cerrar}
                />
              </li>
            ))}
          </ul>
        </nav>
        <button
          type="button"
          className={s.misPlataformas}
          onClick={() => {
            cerrar();
            abrirMisPlataformasDesde(botonMenu.current);
          }}
        >
          Mis plataformas
        </button>
        <ul role="list" className={s.confianza}>
          {CONFIANZA.map((c) => (
            <li key={c.href}>
              <Enlace href={c.href}>{c.etiqueta}</Enlace>
            </li>
          ))}
        </ul>
      </Sheet>
    </div>
  );
}
