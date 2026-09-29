import type { MetadataRoute } from "next";
import { INDEXABLE, URL_BASE } from "@/lib/sitio.ts";

export const dynamic = "force-static";

/**
 * `robots.txt` (docs/SEO.md). Hasta el lanzamiento, nada es indexable. Después:
 * todo salvo `/buscar`, los filtros y `/api/`.
 */
export default function robots(): MetadataRoute.Robots {
  if (!INDEXABLE) return { rules: { userAgent: "*", disallow: "/" } };
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/buscar", "/api/", "/*?*tipo=", "/*?*plataforma=", "/*?*obra="],
    },
    sitemap: `${URL_BASE}/sitemap.xml`,
  };
}
