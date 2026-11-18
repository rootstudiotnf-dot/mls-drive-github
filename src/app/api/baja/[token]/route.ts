import { NextResponse } from "next/server";
import { applyUnsubscribe } from "@/lib/notifications/unsubscribe";

/** Baja «de un clic» (cabecera List-Unsubscribe-Post del correo). Firmada: no necesita sesión. */
export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const done = await applyUnsubscribe(token);
  return new NextResponse(done ? "Listo" : "No encontrado", { status: done ? 200 : 404, headers: { "Cache-Control": "no-store" } });
}

/** Un GET (previsualización del cliente de correo) NO cambia nada: lleva a la página de confirmación. */
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return NextResponse.redirect(new URL(`/baja/${encodeURIComponent(token)}`, request.url));
}
