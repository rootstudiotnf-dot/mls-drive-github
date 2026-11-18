import "server-only";

import { createClient } from "@/lib/supabase/server";

/**
 * Lecturas del espacio de un artista. Todas con el cliente del usuario: RLS (can_access) decide qué ve.
 * Sin acceso → null / listas vacías (las páginas responden 404 como si no existiera).
 * Los slugs son solo de presentación: se resuelven a id y desde ahí todo va por id.
 */

export type ArtistRecord = {
  id: string;
  name: string;
  slug: string;
  bio: string | null;
  status: "active" | "archived";
  avatarAssetId: string | null;
};

type ArtistRow = {
  id: string;
  name: string;
  slug: string;
  bio: string | null;
  status: "active" | "archived";
  avatar_asset_id: string | null;
};

const toArtist = (r: ArtistRow): ArtistRecord => ({
  id: r.id,
  name: r.name,
  slug: r.slug,
  bio: r.bio,
  status: r.status,
  avatarAssetId: r.avatar_asset_id,
});

const ARTIST_COLUMNS = "id, name, slug, bio, status, avatar_asset_id";

export async function loadArtistBySlug(slug: string): Promise<ArtistRecord | null> {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return null;
  const supabase = await createClient();
  const { data } = await supabase
    .from("artists")
    .select(ARTIST_COLUMNS)
    .eq("slug", slug)
    .is("deleted_at", null)
    .maybeSingle();
  return data ? toArtist(data as unknown as ArtistRow) : null;
}

export async function loadVisibleArtists(): Promise<ArtistRecord[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("artists")
    .select(ARTIST_COLUMNS)
    .is("deleted_at", null)
    .order("name", { ascending: true })
    .limit(500);
  return ((data ?? []) as unknown as ArtistRow[]).map(toArtist);
}

export type ArtistSummary = {
  sessions: number;
  photos: number;
  videos: number;
  files: number;
  beatsShared: number;
  members: number;
  pending: number;
};

type SummaryRow = {
  artist_id: string;
  sessions: number;
  photos: number;
  videos: number;
  files: number;
  beats_shared: number;
  members: number;
  pending: number;
};

const toSummary = (r: SummaryRow): ArtistSummary => ({
  sessions: Number(r.sessions),
  photos: Number(r.photos),
  videos: Number(r.videos),
  files: Number(r.files),
  beatsShared: Number(r.beats_shared),
  members: Number(r.members),
  pending: Number(r.pending),
});

export const EMPTY_SUMMARY: ArtistSummary = {
  sessions: 0,
  photos: 0,
  videos: 0,
  files: 0,
  beatsShared: 0,
  members: 0,
  pending: 0,
};

/** Resumen de un artista (función de base de datos SECURITY INVOKER: cuenta solo lo que RLS deja ver). */
export async function loadSummary(artistId: string): Promise<ArtistSummary> {
  const supabase = await createClient();
  const { data } = await supabase.rpc("artist_summary", { p_artist: artistId });
  const row = (Array.isArray(data) ? data[0] : data) as SummaryRow | undefined;
  return row ? toSummary(row) : EMPTY_SUMMARY;
}

/** Resúmenes de todos los artistas visibles (una sola consulta). */
export async function loadSummaries(): Promise<Map<string, ArtistSummary>> {
  const supabase = await createClient();
  const { data } = await supabase.rpc("artist_summaries");
  return new Map(((data ?? []) as SummaryRow[]).map((r) => [r.artist_id, toSummary(r)]));
}

// ---------------------------------------------------------------------------
// Carpetas
// ---------------------------------------------------------------------------

export type FolderNode = {
  id: string;
  parentId: string | null;
  name: string;
  kind: "photos" | "videos" | "files" | "general";
  sort: number;
  depth: number;
  /** Elementos directamente en la carpeta */
  items: number;
  /** Elementos en la carpeta y todas sus subcarpetas */
  total: number;
};

type FolderRow = {
  id: string;
  parent_id: string | null;
  name: string;
  kind: FolderNode["kind"];
  sort: number;
};

/** Árbol de carpetas del artista, ordenado (cada nivel por `sort`) y con el número de elementos. */
export async function loadFolderTree(artistId: string): Promise<FolderNode[]> {
  const supabase = await createClient();
  const [foldersRes, countsRes] = await Promise.all([
    supabase.from("folders").select("id, parent_id, name, kind, sort").eq("artist_id", artistId).is("session_id", null).is("deleted_at", null).limit(2000),
    supabase.rpc("folder_counts", { p_artist: artistId }),
  ]);
  const rows = (foldersRes.data ?? []) as unknown as FolderRow[];
  const counts = new Map(((countsRes.data ?? []) as { folder_id: string; items: number }[]).map((c) => [c.folder_id, Number(c.items)]));

  const children = new Map<string | null, FolderRow[]>();
  for (const row of rows) children.set(row.parent_id, [...(children.get(row.parent_id) ?? []), row]);
  for (const list of children.values()) list.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "es"));

  const out: FolderNode[] = [];
  const walk = (parent: string | null, depth: number): number => {
    let subtotal = 0;
    for (const row of children.get(parent) ?? []) {
      const index = out.length;
      out.push({ id: row.id, parentId: row.parent_id, name: row.name, kind: row.kind, sort: row.sort, depth, items: counts.get(row.id) ?? 0, total: 0 });
      const inner = walk(row.id, depth + 1);
      const node = out[index] as FolderNode;
      node.total = node.items + inner;
      subtotal += node.total;
    }
    return subtotal;
  };
  walk(null, 0);
  return out;
}
