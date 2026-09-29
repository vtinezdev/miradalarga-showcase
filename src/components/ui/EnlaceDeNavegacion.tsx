"use client";

import { usePathname } from "next/navigation";
import { esDestinoActual } from "@/lib/navegacion.ts";
import { Enlace } from "./Enlace.tsx";

/**
 * Hoja mínima de cliente: el layout no conoce la ruta, así que solo el enlace
 * sabe si es el destino actual (`aria-current="page"`).
 */
export function EnlaceDeNavegacion({
  href,
  etiqueta,
  className,
  onNavegar,
}: {
  href: string;
  etiqueta: string;
  className?: string | undefined;
  onNavegar?: () => void;
}) {
  const ruta = usePathname() ?? "";
  const actual = esDestinoActual(ruta, href);
  return (
    <Enlace
      href={href}
      className={className}
      aria-current={actual ? "page" : undefined}
      {...(onNavegar ? { onClick: onNavegar } : {})}
    >
      {etiqueta}
    </Enlace>
  );
}
