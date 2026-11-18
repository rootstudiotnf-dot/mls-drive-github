import "server-only";

import type { BeatRow, BeatStatus } from "./types";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/storage/keys";

/** Datos completos de un beat para su ficha. Lectura bajo RLS: sin acceso → null (la página responde 404). */
export type BeatDetail = BeatRow & {
  waveform: number[] | null;
  previewTagged: boolean;
  jobStatus: "queued" | "processing" | "ready" | "failed" | "none";
  jobError: string | null;
};

type Row = {
  id: string;
  asset_id: string;
  cover_asset_id: string | null;
  title: string;
  bpm: number | null;
  musical_key: string | null;
  genre_id: string | null;
  status: BeatStatus;
  created_on: string;
  downloadable: boolean;
  preview_tagged: boolean;
  waveform: number[] | null;
};

export async function loadBeat(beatId: string): Promise<BeatDetail | null> {
  if (!isUuid(beatId)) return null;
  const supabase = await createClient();
  const { data } = await supabase
    .from("beats")
    .select("id, asset_id, cover_asset_id, title, bpm, musical_key, genre_id, status, created_on, downloadable, preview_tagged, waveform")
    .eq("id", beatId)
    .is("deleted_at", null)
    .maybeSingle();
  const row = data as unknown as Row | null;
  if (!row) return null;

  const admin = createAdminClient();
  const [genre, tagRows, shareRows, asset, derivative, job] = await Promise.all([
    row.genre_id ? supabase.from("genres").select("name").eq("id", row.genre_id).maybeSingle() : Promise.resolve({ data: null }),
    supabase.from("taggings").select("tag_id").eq("resource_type", "beat").eq("resource_id", row.id),
    supabase.from("beat_artists").select("artist_id, can_download").eq("beat_id", row.id),
    admin.from("assets").select("duration_seconds").eq("id", row.asset_id).maybeSingle(),
    admin.from("asset_derivatives").select("id").eq("asset_id", row.asset_id).eq("type", "audio_preview").eq("status", "ready").limit(1),
    admin.from("media_jobs").select("status, error").eq("asset_id", row.asset_id).eq("kind", "audio").order("requested_at", { ascending: false }).limit(1),
  ]);

  const tagIds = ((tagRows.data ?? []) as { tag_id: string }[]).map((t) => t.tag_id);
  const tags = tagIds.length > 0 ? (((await supabase.from("tags").select("name").in("id", tagIds)).data ?? []) as { name: string }[]).map((t) => t.name).sort() : [];
  const links = (shareRows.data ?? []) as { artist_id: string; can_download: boolean }[];
  const names = new Map<string, string>();
  if (links.length > 0) {
    const { data: artists } = await admin.from("artists").select("id, name").in("id", links.map((l) => l.artist_id));
    for (const a of (artists ?? []) as { id: string; name: string }[]) names.set(a.id, a.name);
  }
  const lastJob = (job.data as { status: BeatDetail["jobStatus"]; error: string | null }[] | null)?.[0];
  const duration = (asset.data as { duration_seconds: number | null } | null)?.duration_seconds;

  return {
    id: row.id,
    assetId: row.asset_id,
    title: row.title,
    bpm: row.bpm,
    key: row.musical_key,
    genreId: row.genre_id,
    genre: (genre.data as { name: string } | null)?.name ?? null,
    status: row.status,
    createdOn: row.created_on,
    downloadable: row.downloadable,
    coverAssetId: row.cover_asset_id,
    durationSeconds: duration === null || duration === undefined ? null : Number(duration),
    previewReady: (derivative.data?.length ?? 0) > 0,
    tags,
    sharedWith: links.map((l) => ({ artistId: l.artist_id, name: names.get(l.artist_id) ?? "Artista", canDownload: l.can_download })),
    waveform: Array.isArray(row.waveform) ? row.waveform : null,
    previewTagged: row.preview_tagged,
    jobStatus: lastJob?.status ?? "none",
    jobError: lastJob?.error ?? null,
  };
}

export async function loadGenres(): Promise<{ id: string; name: string; beats: number }[]> {
  const supabase = await createClient();
  const [{ data: genres }, { data: used }] = await Promise.all([
    supabase.from("genres").select("id, name").order("name").limit(500),
    createAdminClient().from("beats").select("genre_id").is("deleted_at", null).not("genre_id", "is", null).limit(20000),
  ]);
  const counts = new Map<string, number>();
  for (const r of (used ?? []) as { genre_id: string }[]) counts.set(r.genre_id, (counts.get(r.genre_id) ?? 0) + 1);
  return ((genres ?? []) as { id: string; name: string }[]).map((g) => ({ id: g.id, name: g.name, beats: counts.get(g.id) ?? 0 }));
}
