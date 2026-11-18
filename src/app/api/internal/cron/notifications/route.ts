import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getCronSecret } from "@/lib/env";
import { flushOutbox, sendDigests, sendExpiryReminders } from "@/lib/notifications/notify";

/**
 * Tarea programada de avisos (Vercel Cron, o un cron externo). Protegida por secreto (`CRON_SECRET`) en
 * `Authorization: Bearer …` (Vercel Cron lo envía solo). Sin secreto configurado o con uno erróneo: 404.
 *
 *   ?digest=1  → además envía el RESUMEN DIARIO (una vez al día)
 *   sin parámetros → recordatorios de caducidad (24 h antes) y correos instantáneos pendientes (reintentos)
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
  const digest = new URL(request.url).searchParams.get("digest") === "1";
  const reminders = await sendExpiryReminders();
  const instant = await flushOutbox();
  const digests = digest ? await sendDigests() : null;
  return NextResponse.json({ reminders, instant, digests });
}

export const GET = run;
export const POST = run;
