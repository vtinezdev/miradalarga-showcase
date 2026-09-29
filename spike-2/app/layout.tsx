import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: { default: "Spike 2", template: "%s · Spike 2" },
  description: "Validacion de infraestructura. No es Mirada Larga.",
};

const RUTAS = [
  ["/", "estatica"],
  ["/isr", "isr"],
  ["/dinamica", "dinamica"],
  ["/titulo/uno", "titulo/[slug]"],
  ["/db", "db"],
  ["/cache", "cache"],
  ["/cliente", "cliente"],
  ["/api/ping", "api/ping"],
] as const;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: "2rem", lineHeight: 1.5 }}>
        <nav>
          {RUTAS.map(([href, texto]) => (
            <Link key={href} href={href} style={{ marginRight: "1rem" }}>
              {texto}
            </Link>
          ))}
        </nav>
        <hr />
        <main>{children}</main>
      </body>
    </html>
  );
}
