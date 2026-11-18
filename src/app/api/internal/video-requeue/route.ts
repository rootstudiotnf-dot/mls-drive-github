import { NextResponse } from "next/server";
import { getTranscoderSecret } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { requeueStaleJobs } from "@/lib/video/jobs";
import { verify } from "@/lib/video/signing";

/**
 * Reintento de trabajos de vídeo atascados. Lo llama `scripts/requeue-media-jobs.ts` (o un cron) con la misma
 * firma HMAC que el callback; sin sesión de usuario. Las URLs prefirmadas las genera ESTE servidor (que tiene las
 * claves de R2); el script no necesita ninguna credencial de almacenamiento.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const secret = getTranscoderSecret();
  if (!secret) return NextResponse.json({ error: "no autorizado" }, { status: 401 });
  const body = await request.text();
  const check = verify(secret, (name) => request.headers.get(name), body);
  if (!check.ok) return NextResponse.json({ error: "no autorizado" }, { status: 401 });
  const { error } = await createAdminClient().from("transcoder_nonces").insert({ nonce: check.nonce });
  if (error) return NextResponse.json({ error: "no autorizado" }, { status: 401 });

  const result = await requeueStaleJobs();
  return NextResponse.json({ ok: true, ...result });
}
