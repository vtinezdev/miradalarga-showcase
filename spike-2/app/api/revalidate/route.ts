import { revalidatePath, revalidateTag } from "next/cache";
import { NextResponse } from "next/server";

// Revalidacion bajo demanda: es como los jobs refrescaran el sitio (§5).
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const secreto = process.env.REVALIDATE_SECRET;
  const enviado = request.headers.get("x-spike-secret");
  if (!secreto || enviado !== secreto) {
    return NextResponse.json({ ok: false, motivo: "no-autorizado" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const tag = searchParams.get("tag");
  const path = searchParams.get("path");

  // Next.js 16 cambio la firma: revalidateTag(tag, profile). Anotado para el ADR.
  // ?perfil=max | ?perfil=0  (0 => { expire: 0 }, caducidad inmediata)
  const perfil = searchParams.get("perfil") ?? "0";
  if (tag) revalidateTag(tag, perfil === "0" ? { expire: 0 } : perfil);
  if (path) revalidatePath(path);

  return NextResponse.json({ ok: true, tag, path, ahora: new Date().toISOString() });
}
