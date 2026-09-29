import type { Metadata } from "next";
import { EmptyState } from "@/components/ui/EmptyState.tsx";
import { SearchInput } from "@/components/ui/SearchInput.tsx";
import s from "./not-found.module.css";

export const metadata: Metadata = {
  title: "Página no encontrada",
  robots: { index: false, follow: true },
};

/**
 * 404 (SCREENS.md §10): misma identidad, un porqué y salidas claras —el
 * buscador y las secciones—. Lo ven también los slugs desconocidos de fichas,
 * listas y plataformas (`notFound()`), con estado HTTP 404 real.
 */
export default function NoEncontrada() {
  return (
    <div className="contenedor">
      <EmptyState
        nivel={1}
        motivo="no-encontrado"
        titulo="Esta página no existe o se ha movido"
        explicacion="Puede que el enlace esté mal escrito o que el título ya no esté en el catálogo que seguimos. Prueba a buscarlo o empieza por aquí:"
        acciones={[
          { etiqueta: "Volver a la portada", href: "/" },
          { etiqueta: "Listas firmadas", href: "/listas" },
          { etiqueta: "Radar del catálogo", href: "/radar" },
          { etiqueta: "Plataformas", href: "/plataformas" },
        ]}
      />
      <SearchInput id="buscar-404" className={s.buscador} />
    </div>
  );
}
