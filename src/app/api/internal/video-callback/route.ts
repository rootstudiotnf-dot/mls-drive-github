import { NextResponse } from "next/server";
import { getTranscoderSecret } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildDerivativeKey, isUuid } from "@/lib/storage/keys";
import { headObject } from "@/lib/storage/multipart";
import { verify } from "@/lib/video/signing";

/**
 * Callback del servicio de procesado. SIN sesión de usuario (nunca se enlaza desde la interfaz): lo protege la firma
 * HMAC-SHA256 del cuerpo + marca de tiempo (±5 min) + nonce de un solo uso. Responde 401 a cualquier petición que
 * no pase las tres comprobaciones, sin decir cuál falló. Idempotente por jobId.
 */

export const dynamic = "force-dynamic";

const MAX_BODY = 64 * 1024;
const reject = () => NextResponse.json({ error: "no autorizado" }, { status: 401 });

const num = (value: unknown, max: number): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : null;

export async function POST(request: Request) {
  const secret = getTranscoderSecret();
  if (!secret) return reject();

  const body = await request.text();
  if (body.length > MAX_BODY) return NextResponse.json({ error: "cuerpo demasiado grande" }, { status: 413 });

  // 1) firma y marca de tiempo (antes de tocar la base de datos)
  const check = verify(secret, (name) => request.headers.get(name), body);
  if (!check.ok) return reject();

  // 2) el nonce no se había usado: la clave primaria rechaza una repetición
  const admin = createAdminClient();
  const { error: nonceError } = await admin.from("transcoder_nonces").insert({ nonce: check.nonce });
  if (nonceError) return reject();
  void admin.from("transcoder_nonces").delete().lt("created_at", new Date(Date.now() - 60 * 60 * 1000).toISOString()); // limpieza

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "JSON no válido" }, { status: 400 });
  }
  if (!isUuid(payload.jobId) || typeof payload.ok !== "boolean") return NextResponse.json({ error: "datos no válidos" }, { status: 400 });

  const { data: jobRow } = await admin.from("media_jobs").select("id, asset_id, status, kind").eq("id", payload.jobId).maybeSingle();
  const job = jobRow as { id: string; asset_id: string; status: string; kind: "video" | "audio" } | null;
  if (!job) return NextResponse.json({ error: "trabajo desconocido" }, { status: 404 });
  // Idempotente: un trabajo ya terminado no se vuelve a procesar
  if (job.status === "ready" || job.status === "failed") return NextResponse.json({ ok: true, duplicate: true });

  const now = new Date().toISOString();

  if (!payload.ok) {
    const message = typeof payload.error === "string" ? payload.error.replace(/[\u0000-\u001f]/g, " ").slice(0, 300) : "Error al procesar";
    await admin.from("media_jobs").update({ status: "failed", error: message, finished_at: now }).eq("id", job.id);
    await admin.from("activity_log").insert({ actor_id: null, action: job.kind === "audio" ? "beat.failed" : "video.failed", resource_type: "asset", resource_id: job.asset_id, metadata: { jobId: job.id } });
    return NextResponse.json({ ok: true });
  }

  // Audio (Fase 7): preview MP3 + duración + forma de onda del beat
  if (job.kind === "audio") {
    const { data: audioRow } = await admin.from("assets").select("id, artist_id").eq("id", job.asset_id).maybeSingle();
    const audio = audioRow as { id: string; artist_id: string | null } | null;
    if (!audio) return NextResponse.json({ error: "asset desconocido" }, { status: 404 });
    const previewKey = buildDerivativeKey(audio.artist_id, audio.id, "audio_preview");
    const preview = await headObject(previewKey);
    const peaks = Array.isArray(payload.peaks) ? payload.peaks : [];
    const peaksOk = peaks.length >= 100 && peaks.length <= 2000 && peaks.every((p) => Number.isInteger(p) && (p as number) >= 0 && (p as number) <= 255);
    if (!preview || preview.size <= 0 || !peaksOk) {
      await admin.from("media_jobs").update({ status: "failed", error: "El servicio no dejó un preview válido", finished_at: now }).eq("id", job.id);
      return NextResponse.json({ ok: true });
    }
    const audioMeta = (payload.meta ?? {}) as Record<string, unknown>;
    const seconds = num(audioMeta.duration, 60 * 60 * 24);
    await admin.from("asset_derivatives").delete().eq("asset_id", audio.id).eq("type", "audio_preview");
    await admin.from("asset_derivatives").insert({ asset_id: audio.id, type: "audio_preview", storage_key: previewKey, size_bytes: preview.size, status: "ready" });
    await admin.from("assets").update({ ...(seconds !== null ? { duration_seconds: seconds } : {}), meta: { sampleRate: num(audioMeta.sampleRate, 1_000_000), channels: num(audioMeta.channels, 64), codec: typeof audioMeta.codec === "string" ? audioMeta.codec.slice(0, 40) : null, tagged: payload.tagged === true } }).eq("id", audio.id);
    await admin.from("beats").update({ waveform: peaks }).eq("asset_id", audio.id);
    await admin.from("media_jobs").update({ status: "ready", error: null, finished_at: now }).eq("id", job.id);
    await admin.from("activity_log").insert({ actor_id: null, action: "beat.processed", resource_type: "asset", resource_id: audio.id, metadata: { jobId: job.id } });
    return NextResponse.json({ ok: true });
  }

  // Éxito (vídeo): las claves las calcula la web (el servicio no decide dónde se guarda nada) y se comprueba que existen
  const { data: assetRow } = await admin.from("assets").select("id, artist_id, meta").eq("id", job.asset_id).maybeSingle();
  const asset = assetRow as { id: string; artist_id: string | null; meta: Record<string, unknown> | null } | null;
  if (!asset) return NextResponse.json({ error: "asset desconocido" }, { status: 404 });

  const proxyKey = buildDerivativeKey(asset.artist_id, asset.id, "proxy");
  const posterKey = buildDerivativeKey(asset.artist_id, asset.id, "poster");
  const [proxy, poster] = await Promise.all([headObject(proxyKey), headObject(posterKey)]);
  if (!proxy || proxy.size <= 0 || !poster || poster.size <= 0) {
    await admin.from("media_jobs").update({ status: "failed", error: "El servicio no dejó los archivos procesados", finished_at: now }).eq("id", job.id);
    return NextResponse.json({ ok: true });
  }

  const meta = (payload.meta ?? {}) as Record<string, unknown>;
  const duration = num(meta.duration, 60 * 60 * 24);
  const width = num(meta.width, 100_000);
  const height = num(meta.height, 100_000);
  const safeMeta = {
    codec: typeof meta.codec === "string" ? meta.codec.slice(0, 40) : null,
    fps: num(meta.fps, 1000),
    rotation: num(meta.rotation, 359),
    hdr: meta.hdr === true,
    bitrate: num(meta.bitrate, 10_000_000_000),
  };

  for (const [type, key, size] of [["proxy", proxyKey, proxy.size], ["poster", posterKey, poster.size]] as const) {
    await admin.from("asset_derivatives").delete().eq("asset_id", asset.id).eq("type", type);
    await admin.from("asset_derivatives").insert({ asset_id: asset.id, type, storage_key: key, size_bytes: size, status: "ready" });
  }
  await admin
    .from("assets")
    .update({
      ...(duration !== null ? { duration_seconds: duration } : {}),
      ...(width ? { width: Math.round(width) } : {}),
      ...(height ? { height: Math.round(height) } : {}),
      meta: { ...(asset.meta ?? {}), ...safeMeta },
    })
    .eq("id", asset.id);
  await admin.from("media_jobs").update({ status: "ready", error: null, finished_at: now }).eq("id", job.id);
  await admin.from("activity_log").insert({ actor_id: null, action: "video.processed", resource_type: "asset", resource_id: asset.id, metadata: { jobId: job.id } });
  return NextResponse.json({ ok: true });
}
