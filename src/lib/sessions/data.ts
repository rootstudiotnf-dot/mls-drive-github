import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/storage/keys";
import type { DownloadMode } from "@/lib/assets/variants";
import type { SessionFolder, SessionMaterial, SessionPhoto, SessionRecord } from "./types";

/**
 * Lecturas de sesiones. Todas con el cliente del USUARIO: RLS (can_access, que incluye a los artistas
 * participantes) decide qué ve. Sin acceso → null / listas vacías, y las páginas responden 404 (nunca 403).
 */

type SessionRow = {
  id: string;
  name: string;
  date: string | null;
  description: string | null;
  artist_id: string;
  download_mode: DownloadMode;
  cover_asset_id: string | null;
  status: "active" | "archived";
};

const SESSION_COLUMNS = "id, name, date, description, artist_id, download_mode, cover_asset_id, status";

const toSession = (r: SessionRow): SessionRecord => ({
  id: r.id,
  name: r.name,
  date: r.date,
  description: r.description,
  artistId: r.artist_id,
  downloadMode: r.download_mode,
  coverAssetId: r.cover_asset_id,
  status: r.status,
});

export async function loadSession(sessionId: string): Promise<SessionRecord | null> {
  if (!isUuid(sessionId)) return null;
  const supabase = await createClient();
  const { data } = await supabase
    .from("sessions")
    .select(SESSION_COLUMNS)
    .eq("id", sessionId)
    .is("deleted_at", null)
    .maybeSingle();
  return data ? toSession(data as unknown as SessionRow) : null;
}

export async function loadSessions(): Promise<SessionRecord[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("sessions")
    .select(SESSION_COLUMNS)
    .is("deleted_at", null)
    .order("date", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(500);
  return ((data ?? []) as unknown as SessionRow[]).map(toSession);
}

/** Artistas participantes (además del principal) de varias sesiones. */
export async function loadParticipants(sessionIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (sessionIds.length === 0) return out;
  const supabase = await createClient();
  const { data } = await supabase.from("session_participants").select("session_id, artist_id").in("session_id", sessionIds.slice(0, 500));
  for (const row of (data ?? []) as { session_id: string; artist_id: string }[]) {
    out.set(row.session_id, [...(out.get(row.session_id) ?? []), row.artist_id]);
  }
  return out;
}

/** Nombres de artistas. Lectura de servidor SOLO del nombre, para mostrar a quien ya tiene acceso a la sesión. */
export async function loadArtistNames(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id) => isUuid(id)))];
  if (unique.length === 0) return new Map();
  const { data } = await createAdminClient().from("artists").select("id, name").in("id", unique).is("deleted_at", null);
  return new Map(((data ?? []) as { id: string; name: string }[]).map((a) => [a.id, a.name]));
}

export async function loadSessionCounts(): Promise<Map<string, { photos: number; others: number }>> {
  const supabase = await createClient();
  const { data } = await supabase.rpc("session_counts");
  return new Map(
    ((data ?? []) as { session_id: string; photos: number; others: number }[]).map((r) => [
      r.session_id,
      { photos: Number(r.photos), others: Number(r.others) },
    ]),
  );
}

type PhotoRow = {
  id: string;
  title: string | null;
  original_filename: string;
  folder_id: string | null;
  visibility: "private" | "published";
  downloadable: boolean;
  width: number | null;
  height: number | null;
  avg_color: string | null;
  size_bytes: number | null;
  created_at: string;
  sort_index: number | null;
};

export const PHOTO_COLUMNS =
  "id, title, original_filename, folder_id, visibility, downloadable, width, height, avg_color, size_bytes, created_at, sort_index";

export const MAX_SESSION_PHOTOS = 2000;

export const toPhoto = (r: PhotoRow): SessionPhoto => ({
  id: r.id,
  title: r.title ?? r.original_filename,
  filename: r.original_filename,
  folderId: r.folder_id,
  visibility: r.visibility,
  downloadable: r.downloadable,
  width: r.width,
  height: r.height,
  avgColor: r.avg_color,
  sizeBytes: r.size_bytes ?? 0,
  createdAt: r.created_at,
  sortIndex: r.sort_index,
});

/** Fotos de la sesión en orden manual (sin sort_index al final, por fecha de subida). */
export async function loadSessionPhotos(
  sessionId: string,
  options: { folderId?: string | null; portalFor?: string } = {},
): Promise<{ photos: SessionPhoto[]; truncated: boolean }> {
  if (!isUuid(sessionId)) return { photos: [], truncated: false };
  const supabase = await createClient();
  let query = supabase
    .from("assets")
    .select(PHOTO_COLUMNS)
    .eq("session_id", sessionId)
    .eq("kind", "photo")
    .eq("status", "ready")
    .eq("space", "workspace")
    .is("deleted_at", null);
  if (options.folderId && isUuid(options.folderId)) query = query.eq("folder_id", options.folderId);
  if (options.portalFor) query = query.or(`visibility.eq.published,uploaded_by.eq.${options.portalFor}`);
  const { data } = await query
    .order("sort_index", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(MAX_SESSION_PHOTOS + 1);
  const rows = (data ?? []) as unknown as PhotoRow[];
  return { photos: rows.slice(0, MAX_SESSION_PHOTOS).map(toPhoto), truncated: rows.length > MAX_SESSION_PHOTOS };
}

export async function loadSessionFolders(sessionId: string, photos?: SessionPhoto[]): Promise<SessionFolder[]> {
  if (!isUuid(sessionId)) return [];
  const supabase = await createClient();
  const { data } = await supabase
    .from("folders")
    .select("id, name, sort")
    .eq("session_id", sessionId)
    .is("deleted_at", null)
    .order("sort", { ascending: true })
    .order("name", { ascending: true })
    .limit(200);
  const counts = new Map<string, number>();
  for (const p of photos ?? []) if (p.folderId) counts.set(p.folderId, (counts.get(p.folderId) ?? 0) + 1);
  return ((data ?? []) as { id: string; name: string }[]).map((f) => ({ id: f.id, name: f.name, photos: counts.get(f.id) ?? 0 }));
}

export async function loadSessionMaterial(sessionId: string): Promise<SessionMaterial[]> {
  if (!isUuid(sessionId)) return [];
  const supabase = await createClient();
  const { data } = await supabase
    .from("assets")
    .select("id, title, original_filename, kind, size_bytes, visibility, created_at")
    .eq("session_id", sessionId)
    .neq("kind", "photo")
    .eq("status", "ready")
    .eq("space", "workspace")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(300);
  return ((data ?? []) as { id: string; title: string | null; original_filename: string; kind: string; size_bytes: number | null; visibility: "private" | "published"; created_at: string }[]).map((r) => ({
    id: r.id,
    title: r.title ?? r.original_filename,
    filename: r.original_filename,
    kind: r.kind,
    sizeBytes: r.size_bytes ?? 0,
    visibility: r.visibility,
    createdAt: r.created_at,
  }));
}
