import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

// Fuentes autoalojadas (DS §2.1): Vite empaqueta los woff2 en nuestro origen.
// Nada se pide a Google en tiempo de ejecución. Solo el eje de peso: con el eje
// óptico, Newsreader pesa 132 KB en vez de 58 KB (medido el 2026-09-28).
import "@fontsource-variable/newsreader/wght.css";
import "@fontsource-variable/newsreader/wght-italic.css";
import "@fontsource-variable/schibsted-grotesk/wght.css";
import "@/styles/tokens.css";
import "@/styles/base.css";

import { Footer } from "@/components/ui/Footer.tsx";
import { Header } from "@/components/ui/Header.tsx";
import { obtenerMarco } from "@/features/catalogo/consultas.ts";
import { datosDeDesarrollo } from "@/features/catalogo/proveedor.ts";
import {
  cssDeMisPlataformas,
  scriptDeMisPlataformas,
} from "@/features/mis-plataformas/arranque.ts";
import { DESCRIPCION, INDEXABLE, LEMA, NOMBRE, URL_BASE } from "@/lib/sitio.ts";

export const metadata: Metadata = {
  metadataBase: new URL(URL_BASE),
  title: { default: `${NOMBRE}: ${LEMA.toLowerCase()}`, template: `%s · ${NOMBRE}` },
  description: DESCRIPCION,
  applicationName: NOMBRE,
  // Nada es indexable hasta el lanzamiento (docs/ROADMAP.md, salida de la Fase 3).
  robots: INDEXABLE ? { index: true, follow: true } : { index: false, follow: false },
  openGraph: { siteName: NOMBRE, locale: "es_ES", type: "website" },
  formatDetection: { telephone: false, address: false, email: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0e0d0b",
  colorScheme: "dark",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { plataformas, comprobadoEn } = await obtenerMarco();
  const ids = plataformas.map((p) => p.id);
  return (
    // El script de <head> añade `data-mis-plataformas` a <html> antes de
    // hidratar: es la única diferencia esperada con el HTML del servidor.
    <html lang="es-ES" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: scriptDeMisPlataformas(ids) }} />
        <style dangerouslySetInnerHTML={{ __html: cssDeMisPlataformas(ids) }} />
      </head>
      <body>
        <Header plataformas={plataformas} />
        <main id="contenido" tabIndex={-1}>
          {children}
        </main>
        <Footer
          plataformas={plataformas}
          comprobadoEn={comprobadoEn}
          datosDeDesarrollo={datosDeDesarrollo()}
        />
      </body>
    </html>
  );
}
