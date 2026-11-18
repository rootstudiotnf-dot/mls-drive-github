import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getCronSecret } from "@/lib/env";
import { runOpsAlerts } from "@/lib/ops/alerts";

/**
 * Tarea programada de operación: revisa el estado de los servicios y avisa por correo al owner si hay algo que
 * mirar (copia fallida o atrasada, almacenamiento > 80 %, servicio caído). Mismo secreto que el cron de avisos
 * (`Authorization: Bearer $CRON_SECRET`); sin él o con uno erróneo, 404. Recomendado: una vez al día en Vercel y,
 * si quieres detectar antes una caída del transcodificador, cada 15 minutos desde un cron externo.
 */
export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const secret = getCronSecret();
  if (!secret) return false;
  const given = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function run(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "no encontrado" }, { status: 404 });
  return NextResponse.json(await runOpsAlerts());
}

export const GET = run;
export const POST = run;
