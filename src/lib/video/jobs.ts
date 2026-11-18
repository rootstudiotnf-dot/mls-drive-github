import "server-only";

import { getMaxUploadBytes, getSiteUrl, getTranscoderConfig } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildDerivativeKey, isUuid } from "@/lib/storage/keys";
import { signGetUrl, signPutUrl } from "@/lib/storage/urls";
import { signedHeaders } from "./signing";

/**
 * Trabajos de procesado de vídeo (proxy 1080p H.264 + póster) que hace el servicio `services/transcoder`.
 *
 *  - Al terminar de subir un vídeo se crea el trabajo en 'queued' y se avisa al servicio SIN esperar el procesado
 *    (el servicio responde 202 al instante y avisa por callback al terminar).
 *  - Si el servicio no está configurado o no responde, el trabajo SE QUEDA en 'queued': nada se pierde y
 *    `scripts/requeue-media-jobs.ts` lo recupera.
 *  - Al servicio solo se le entregan URLs prefirmadas de 1 hora para ESTAS claves (leer el original, escribir el
 *    proxy y el póster): no tiene credenciales de R2.
 */

export const URL_TTL_FOR_TRANSCODER = 60 * 60;
export const MAX_ATTEMPTS = 3;
const STALE_MINUTES = 30;

import type { VideoJobStatus, VideoState } from "./jobs-types";
export type { VideoJobStatus, VideoState };

/** Crea un trabajo 'queued' para el asset (si no hay ya uno activo). Devuelve su id o null si ya había uno activo. */
export async function enqueueVideoJob(assetId: string, kind: "video" | "audio" = "video"): Promise<string | null> {
  const { data, error } = await createAdminClient().from("media_jobs").insert({ asset_id: assetId, status: "queued", kind }).select("id").single();
  if (error) {
    if (error.code === "23505") return null; // ya hay un trabajo activo para este vídeo
    console.error("enqueueVideoJob failed:", error.code ?? "");
    return null;
  }
  return (data as { id: string }).id;
}

export type DispatchResult = "processing" | "queued" | "skipped";

/** Envía el trabajo al servicio. Si no acepta, el trabajo sigue en 'queued'. Nunca lanza. */
export async function dispatchVideoJob(jobId: string): Promise<DispatchResult> {
  try {
    const config = getTranscoderConfig();
    if (!config || !isUuid(jobId)) return "skipped";
    const admin = createAdminClient();

    const { data: jobRow } = await admin.from("media_jobs").select("id, asset_id, status, attempts, kind").eq("id", jobId).maybeSingle();
    const job = jobRow as { id: string; asset_id: string; status: VideoJobStatus; attempts: number; kind: "video" | "audio" } | null;
    if (!job || job.status !== "queued") return "skipped";

    const { data: assetRow } = await admin
      .from("assets")
      .select("id, kind, status, artist_id, storage_key")
      .eq("id", job.asset_id)
      .eq("space", "workspace")
      .is("deleted_at", null)
      .maybeSingle();
    const asset = assetRow as { id: string; kind: string; status: string; artist_id: string | null; storage_key: string } | null;
    if (!asset || asset.kind !== (job.kind === "audio" ? "audio" : "video") || asset.status !== "ready") return "skipped";

    const source = await signGetUrl({ key: asset.storage_key, mode: "view", ttlSeconds: URL_TTL_FOR_TRANSCODER });
    const common = {
      jobId: job.id,
      sourceUrl: source.url,
      callbackUrl: `${getSiteUrl()}/api/internal/video-callback`,
      limits: { maxDurationSec: config.maxDurationMin * 60, maxBytes: getMaxUploadBytes() },
    };
    let body: string;
    if (job.kind === "audio") {
      const preview = await signPutUrl({ key: buildDerivativeKey(asset.artist_id, asset.id, "audio_preview"), contentType: "audio/mpeg", ttlSeconds: URL_TTL_FOR_TRANSCODER });
      const voice = await voiceTagFor(asset.id);
      body = JSON.stringify({ ...common, type: "audio", previewPutUrl: preview.url, ...(voice ? { voiceTagUrl: voice.url, voiceTagIntervalS: voice.intervalS } : {}) });
    } else {
      const [proxy, poster] = await Promise.all([
        signPutUrl({ key: buildDerivativeKey(asset.artist_id, asset.id, "proxy"), contentType: "video/mp4", ttlSeconds: URL_TTL_FOR_TRANSCODER }),
        signPutUrl({ key: buildDerivativeKey(asset.artist_id, asset.id, "poster"), contentType: "image/jpeg", ttlSeconds: URL_TTL_FOR_TRANSCODER }),
      ]);
      body = JSON.stringify({ ...common, proxyPutUrl: proxy.url, posterPutUrl: poster.url });
    }
    const response = await fetch(`${config.url}/transcode`, {
      method: "POST",
      headers: { "content-type": "application/json", ...signedHeaders(config.secret, body) },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 202 && response.status !== 200) {
      // 503 «ocupado» u otro rechazo: se queda en cola
      await admin.from("media_jobs").update({ error: `El servicio no aceptó el trabajo (${response.status})` }).eq("id", job.id).eq("status", "queued");
      return "queued";
    }
    const { data: claimed } = await admin
      .from("media_jobs")
      .update({ status: "processing", started_at: new Date().toISOString(), attempts: job.attempts + 1, error: null })
      .eq("id", job.id)
      .eq("status", "queued")
      .select("id");
    return (claimed?.length ?? 0) > 0 ? "processing" : "skipped";
  } catch {
    // Servicio apagado, red caída, tiempo agotado…: el trabajo queda 'queued' (se reintentará)
    return "queued";
  }
}

/** Crea el trabajo y lo envía (para llamar tras completar la subida de un vídeo). */
export async function enqueueAndDispatch(assetId: string, kind: "video" | "audio" = "video"): Promise<DispatchResult> {
  const jobId = await enqueueVideoJob(assetId, kind);
  return jobId ? dispatchVideoJob(jobId) : "skipped";
}

/**
 * Recupera trabajos atascados: 'queued' o 'processing' desde hace más de 30 min. Hasta 3 intentos; después
 * se marcan 'failed' (constancia del fallo definitivo). Devuelve cuántos se reenviaron y cuántos fallaron.
 */
export async function requeueStaleJobs(now = Date.now()): Promise<{ retried: number; exhausted: number; examined: number }> {
  const admin = createAdminClient();
  const limit = new Date(now - STALE_MINUTES * 60 * 1000).toISOString();
  const { data } = await admin
    .from("media_jobs")
    .select("id, asset_id, status, attempts, requested_at, started_at")
    .in("status", ["queued", "processing"])
    .limit(200);
  const jobs = ((data ?? []) as { id: string; asset_id: string; status: VideoJobStatus; attempts: number; requested_at: string; started_at: string | null }[]).filter(
    (j) => (j.started_at ?? j.requested_at) < limit,
  );
  let retried = 0;
  let exhausted = 0;
  for (const job of jobs) {
    if (job.attempts >= MAX_ATTEMPTS) {
      await admin
        .from("media_jobs")
        .update({ status: "failed", error: "Se agotaron los intentos de procesado", finished_at: new Date(now).toISOString() })
        .eq("id", job.id);
      await admin.from("activity_log").insert({ actor_id: null, action: "video.failed", resource_type: "asset", resource_id: job.asset_id, metadata: { reason: "attempts_exhausted" } });
      exhausted++;
      continue;
    }
    if (job.status === "processing") await admin.from("media_jobs").update({ status: "queued" }).eq("id", job.id).eq("status", "processing");
    if ((await dispatchVideoJob(job.id)) === "processing") retried++;
  }
  return { retried, exhausted, examined: jobs.length };
}

/** Estado de procesado de varios vídeos (lectura de servidor, tras haber comprobado que el usuario los ve). */
export async function loadVideoStates(assetIds: string[]): Promise<Map<string, VideoState>> {
  const out = new Map<string, VideoState>();
  const ids = [...new Set(assetIds.filter((id) => isUuid(id)))].slice(0, 500);
  if (ids.length === 0) return out;
  const { data } = await createAdminClient()
    .from("media_jobs")
    .select("asset_id, status, error, requested_at")
    .in("asset_id", ids)
    .order("requested_at", { ascending: false })
    .limit(2000);
  for (const row of (data ?? []) as { asset_id: string; status: VideoJobStatus; error: string | null }[]) {
    if (!out.has(row.asset_id)) out.set(row.asset_id, { status: row.status, error: row.error }); // el más reciente
  }
  for (const id of ids) if (!out.has(id)) out.set(id, { status: "none", error: null });
  return out;
}

/**
 * Tag de voz que lleva el preview de este beat (si el beat lo tiene activado y el owner subió uno).
 * Se firma una URL de 1 h; el servicio la lee y la mezcla cada N segundos.
 */
async function voiceTagFor(audioAssetId: string): Promise<{ url: string; intervalS: number } | null> {
  const admin = createAdminClient();
  const { data: beat } = await admin.from("beats").select("preview_tagged").eq("asset_id", audioAssetId).is("deleted_at", null).maybeSingle();
  if (!(beat as { preview_tagged: boolean } | null)?.preview_tagged) return null;
  const { data: settings } = await admin.from("app_settings").select("key, value").in("key", ["beat_voice_tag_asset_id", "beat_voice_tag_interval_s"]);
  const map = new Map(((settings ?? []) as { key: string; value: unknown }[]).map((r) => [r.key, r.value]));
  const tagId = map.get("beat_voice_tag_asset_id");
  if (typeof tagId !== "string" || !isUuid(tagId)) return null;
  const { data: tag } = await admin.from("assets").select("storage_key").eq("id", tagId).is("deleted_at", null).eq("status", "ready").maybeSingle();
  if (!tag) return null;
  const signed = await signGetUrl({ key: (tag as { storage_key: string }).storage_key, mode: "view", ttlSeconds: URL_TTL_FOR_TRANSCODER });
  const interval = Number(map.get("beat_voice_tag_interval_s"));
  return { url: signed.url, intervalS: Number.isFinite(interval) && interval >= 5 && interval <= 600 ? interval : 25 };
}
