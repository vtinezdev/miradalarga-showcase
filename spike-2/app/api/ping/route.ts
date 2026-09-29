import { NextResponse } from "next/server";

// Route Handler: comprueba variables de entorno y cabeceras de Cloudflare.
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return NextResponse.json({
    ok: true,
    ahora: new Date().toISOString(),
    // Presencia, nunca el valor: los secretos no se exponen.
    tieneDatabaseUrl: Boolean(process.env.DATABASE_URL),
    tieneRevalidateSecret: Boolean(process.env.REVALIDATE_SECRET),
    marcaDeNextConfig: process.env.SPIKE_MARCA_CONFIG ?? null,
    publicaSiteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? null,
    cfRay: request.headers.get("cf-ray"),
    cfPais: request.headers.get("cf-ipcountry"),
  });
}
