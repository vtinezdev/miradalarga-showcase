import type { ReactNode, SVGProps } from "react";

/**
 * Iconos de trazo (DS §7): 1,5 px sobre retícula de 24, copiados en línea sin
 * instalar el paquete. Trazados basados en Lucide (https://lucide.dev),
 * licencia ISC © Lucide Contributors.
 *
 * Por defecto son decorativos (`aria-hidden`): el texto visible de al lado
 * dice lo mismo. Un botón solo con icono pone su nombre en el botón, no aquí.
 */

type Props = Omit<SVGProps<SVGSVGElement>, "children"> & { tamano?: "s" | "m" };

function Icono({ tamano = "s", children, ...resto }: Props & { children: ReactNode }) {
  const lado = tamano === "s" ? "var(--icon-s)" : "var(--icon-m)";
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      style={{ width: lado, height: lado, flex: "none" }}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...resto}
    >
      {children}
    </svg>
  );
}

export const IconoBuscar = (p: Props) => (
  <Icono {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Icono>
);

export const IconoMenu = (p: Props) => (
  <Icono {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icono>
);

export const IconoCerrar = (p: Props) => (
  <Icono {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Icono>
);

export const IconoCheck = (p: Props) => (
  <Icono {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Icono>
);

export const IconoExterno = (p: Props) => (
  <Icono {...p}>
    <path d="M7 7h10v10M7 17 17 7" />
  </Icono>
);

export const IconoFlecha = (p: Props) => (
  <Icono {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Icono>
);

export const IconoLlega = (p: Props) => (
  <Icono {...p}>
    <path d="m10 17 5-5-5-5M15 12H3M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
  </Icono>
);

export const IconoSale = (p: Props) => (
  <Icono {...p}>
    <path d="m16 17 5-5-5-5M21 12H9M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
  </Icono>
);

export const IconoReloj = (p: Props) => (
  <Icono {...p}>
    <path d="M5 22h14M5 2h14M17 22v-4.2a2 2 0 0 0-.6-1.4L12 12l-4.4 4.4a2 2 0 0 0-.6 1.4V22M7 2v4.2a2 2 0 0 0 .6 1.4L12 12l4.4-4.4a2 2 0 0 0 .6-1.4V2" />
  </Icono>
);

export const IconoCalendario = (p: Props) => (
  <Icono {...p}>
    <path d="M8 2v4M16 2v4M3 10h18" />
    <rect width="18" height="18" x="3" y="4" rx="2" />
  </Icono>
);

export const IconoCambio = (p: Props) => (
  <Icono {...p}>
    <path d="M8 3 4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4" />
  </Icono>
);

export const IconoPlataformas = (p: Props) => (
  <Icono {...p}>
    <rect width="18" height="12" x="3" y="4" rx="1.5" />
    <path d="M8 20h8M12 16v4" />
  </Icono>
);

export const IconoChevron = (p: Props) => (
  <Icono {...p}>
    <path d="m6 9 6 6 6-6" />
  </Icono>
);
