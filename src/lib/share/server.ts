import "server-only";

import { cookies, headers } from "next/headers";
import { getShareSalt } from "@/lib/env";
import { can } from "@/lib/permissions/server";
import { signGetUrl } from "@/lib/storage/urls";
import { classifyFilename } from "@/lib/storage/validate";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashIp, hashToken, isTokenShape, sameHash, signUnlocked, summarizeUserAgent, verifyUnlocked } from "./token";

/**
 * Validación y firmado de los enlaces externos. TODO ocurre en servidor y en CADA petición: no hay sesión ni acceso
 * a tablas para los visitantes. Un token inexistente, caducado, revocado o cuyo creador ya no tiene acceso son
 * indistinguibles (devuelven `null` → 404 neutro).
 */

export type ShareLink = {
  id: string;
  token_hash: string;
  resource_type: "session" | "folder" | "asset_set" | "beat_set";
  resource_id: string | null;
  resource_ids: string[] | null;
  title: string;
  message: string | null;
  can_download: boolean;
  can_comment: boolean;
  password_hash: string | null;
  expires_at: string;
  max_downloads: number | null;
  view_count: number;
  download_count: number;
  first_opened_at: string | null;
  created_by: string | null;
  revoked_at: string | null;
  created_at: string;
};

const COLUMNS = "id, token_hash, resource_type, resource_id, resource_ids, title, message, can_download, can_comment, password_hash, expires_at, max_downloads, view_count, download_count, first_opened_at, created_by, revoked_at, created_at";
export const SHARE_VIEW_TTL = 5 * 60;
export const SHARE_DOWNLOAD_TTL = 2 * 60;
export const PAGE_SIZE = 60;
export const IP_REQUESTS_PER_MINUTE = 120;
export const PASSWORD_ATTEMPTS = 5;
export const PASSWORD_WINDOW_MINUTES = 15;

// --- Cliente (IP con hash, navegador resumido) -----------------------------------------------------------------

export type ClientInfo = { ipHash: string; userAgent: string };

export async function clientInfo(): Promise<ClientInfo | null> {
  const salt = getShareSalt();
  if (!salt) return null; // sin sal del servidor no se atiende ningún enlace (falla cerrado)
  const h = await headers();
  const ip = (h.get("x-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip") ?? "desconocida").trim();
  return { ipHash: hashIp(ip, salt), userAgent: summarizeUserAgent(h.get("user-agent")) };
}

export async function rateLimit(key: string, windowSeconds: number, limit: number): Promise<boolean> {
  const { data, error } = await createAdminClient().rpc("rate_hit", { p_key: key, p_window_seconds: windowSeconds, p_limit: limit });
  return !error && data === true; // sin poder contar, se deniega
}

export async function recordEvent(linkId: string, type: "open" | "view" | "download" | "password_fail" | "comment", client: ClientInfo): Promise<void> {
  await createAdminClient().from("share_link_events").insert({ link_id: linkId, type, ip_hash: client.ipHash, user_agent: client.userAgent });
}

// --- Carga y validación ------------------------------------------------------------------------------------------

/** El enlace si el token existe, no está revocado ni caducado y su creador sigue teniendo acceso; si no, null. */
export async function loadShare(token: unknown): Promise<ShareLink | null> {
  if (!isTokenShape(token)) return null;
  const hash = hashToken(token);
  const { data } = await createAdminClient().from("share_links").select(COLUMNS).eq("token_hash", hash).maybeSingle();
  const link = data as ShareLink | null;
  if (!link || !sameHash(link.token_hash, hash)) return null;
  if (link.revoked_at || Date.parse(link.expires_at) <= Date.now() || !link.created_by) return null;
  if (!(await creatorStillHasAccess(link))) return null;
  return link;
}

async function creatorStillHasAccess(link: ShareLink): Promise<boolean> {
  const creator = link.created_by as string;
  if (link.resource_type === "session" || link.resource_type === "folder") {
    return can(creator, "view", { type: link.resource_type, id: link.resource_id as string });
  }
  // Selecciones: basta con que le quede algo (lo demás deja de mostrarse)
  const ids = (link.resource_ids ?? []).slice(0, 20);
  const type = link.resource_type === "asset_set" ? "asset" : "beat";
  const checks = await Promise.all(ids.map((id) => can(creator, "view", { type, id })));
  return checks.some(Boolean);
}

// --- Contraseña ------------------------------------------------------------------------------------------------------

const cookieName = (link: ShareLink) => `share_${link.id.slice(0, 13)}`;

export async function hasPasswordAccess(link: ShareLink): Promise<boolean> {
  if (!link.password_hash) return true;
  const salt = getShareSalt();
  if (!salt) return false;
  return verifyUnlocked((await cookies()).get(cookieName(link))?.value, link.id, salt);
}

export async function grantPasswordAccess(link: ShareLink): Promise<void> {
  const salt = getShareSalt();
  if (!salt) return;
  const expires = Math.min(Date.parse(link.expires_at), Date.now() + 12 * 3600_000);
  (await cookies()).set(cookieName(link), signUnlocked(link.id, expires, salt), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/c",
    maxAge: Math.max(1, Math.floor((expires - Date.now()) / 1000)),
  });
}

/** ¿Quedan intentos de contraseña para esta IP en este enlace? (5 por 15 minutos, contados en los eventos). */
export async function passwordAttemptsLeft(linkId: string, ipHash: string): Promise<number> {
  const since = new Date(Date.now() - PASSWORD_WINDOW_MINUTES * 60_000).toISOString();
  const { count, error } = await createAdminClient().from("share_link_events").select("id", { count: "exact", head: true }).eq("link_id", linkId).eq("ip_hash", ipHash).eq("type", "password_fail").gte("created_at", since);
  if (error) return 0; // sin poder contar, no hay intentos
  return Math.max(0, PASSWORD_ATTEMPTS - (count ?? 0));
}

// --- Contenido ---------------------------------------------------------------------------------------------------------

export type PublicItem = {
  id: string;
  kind: "photo" | "video" | "audio" | "document" | "other";
  title: string;
  /** Nombre de archivo para el ZIP y la descarga */
  fileName: string;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  sizeBytes: number;
  beat?: { title: string; bpm: number | null; key: string | null };
};
export type PublicPage = { items: PublicItem[]; nextCursor: string | null };

type AssetRow = { id: string; kind: PublicItem["kind"]; title: string | null; original_filename: string; width: number | null; height: number | null; duration_seconds: number | null; size_bytes: number | null; created_at: string; session_id: string | null; folder_id: string | null; space: string; status: string; storage_key: string; artist_id: string | null; deleted_at: string | null };
const ASSET_COLUMNS = "id, kind, title, original_filename, width, height, duration_seconds, size_bytes, created_at, session_id, folder_id, space, status, storage_key, artist_id, deleted_at";

async function folderTree(folderId: string): Promise<string[] | null> {
  const admin = createAdminClient();
  const { data: root } = await admin.from("folders").select("id, artist_id, space").eq("id", folderId).is("deleted_at", null).maybeSingle();
  const r = root as { id: string; artist_id: string | null; space: string } | null;
  if (!r || r.space !== "workspace" || !r.artist_id) return null;
  const { data } = await admin.from("folders").select("id, parent_id").eq("artist_id", r.artist_id).eq("space", "workspace").is("deleted_at", null).limit(5000);
  const all = (data ?? []) as { id: string; parent_id: string | null }[];
  const out = [folderId];
  for (let i = 0; i < out.length; i++) for (const f of all) if (f.parent_id === out[i] && !out.includes(f.id)) out.push(f.id);
  return out;
}

/** Los ids de archivo (audio) de los beats de un enlace de beats, con sus datos. */
async function beatsOf(link: ShareLink): Promise<{ id: string; asset_id: string; title: string; bpm: number | null; musical_key: string | null }[]> {
  const { data } = await createAdminClient().from("beats").select("id, asset_id, title, bpm, musical_key").in("id", link.resource_ids ?? []).is("deleted_at", null);
  return (data ?? []) as { id: string; asset_id: string; title: string; bpm: number | null; musical_key: string | null }[];
}

/** ¿Pertenece este archivo a lo compartido? (nunca se confía en el id que manda el cliente). */
async function inScope(link: ShareLink, asset: AssetRow): Promise<boolean> {
  if (asset.space !== "workspace" || asset.status !== "ready" || asset.deleted_at) return false; // nada del Vault
  switch (link.resource_type) {
    case "session":
      return asset.session_id === link.resource_id;
    case "folder": {
      const tree = await folderTree(link.resource_id as string);
      return !!tree && !!asset.folder_id && tree.includes(asset.folder_id);
    }
    case "asset_set":
      return (link.resource_ids ?? []).includes(asset.id) && (await can(link.created_by as string, "view", { type: "asset", id: asset.id }));
    case "beat_set": {
      const beat = (await beatsOf(link)).find((b) => b.asset_id === asset.id);
      return !!beat && (await can(link.created_by as string, "view", { type: "beat", id: beat.id }));
    }
  }
}

export async function listShareItems(link: ShareLink, cursor: string | null): Promise<PublicPage> {
  const admin = createAdminClient();
  if (link.resource_type === "beat_set") {
    const beats = (await beatsOf(link)).sort((a, b) => a.title.localeCompare(b.title, "es"));
    const visible = (await Promise.all(beats.map(async (b) => ((await can(link.created_by as string, "view", { type: "beat", id: b.id })) ? b : null)))).filter((b) => b !== null);
    const { data: assets } = await admin.from("assets").select("id, original_filename, duration_seconds, size_bytes, space, status, deleted_at").in("id", visible.map((b) => b.asset_id));
    const byId = new Map(((assets ?? []) as { id: string; original_filename: string; duration_seconds: number | null; size_bytes: number | null; space: string; status: string; deleted_at: string | null }[]).map((a) => [a.id, a]));
    const items = visible
      .filter((b) => { const a = byId.get(b.asset_id); return a && a.space === "workspace" && a.status === "ready" && !a.deleted_at; })
      .map((b): PublicItem => ({ id: b.asset_id, kind: "audio", title: b.title, fileName: byId.get(b.asset_id)?.original_filename ?? `${b.title}.wav`, width: null, height: null, durationSeconds: byId.get(b.asset_id)?.duration_seconds ?? null, sizeBytes: Number(byId.get(b.asset_id)?.size_bytes ?? 0), beat: { title: b.title, bpm: b.bpm, key: b.musical_key } }));
    return { items, nextCursor: null };
  }

  let query = admin.from("assets").select(ASSET_COLUMNS).eq("space", "workspace").eq("status", "ready").is("deleted_at", null);
  if (link.resource_type === "session") query = query.eq("session_id", link.resource_id as string);
  else if (link.resource_type === "folder") {
    const tree = await folderTree(link.resource_id as string);
    if (!tree) return { items: [], nextCursor: null };
    query = query.in("folder_id", tree);
  } else query = query.in("id", link.resource_ids ?? []);
  if (cursor) {
    const [at, id] = cursor.split("|");
    if (!at || !id || Number.isNaN(Date.parse(at))) return { items: [], nextCursor: null };
    query = query.or(`created_at.gt.${at},and(created_at.eq.${at},id.gt.${id})`);
  }
  const { data } = await query.order("created_at", { ascending: true }).order("id", { ascending: true }).limit(PAGE_SIZE + 1);
  const rows = (data ?? []) as AssetRow[];
  const page = rows.slice(0, PAGE_SIZE);
  // En selecciones se vuelve a comprobar el acceso del creador archivo a archivo
  const allowed = link.resource_type === "asset_set" ? (await Promise.all(page.map(async (a) => ((await can(link.created_by as string, "view", { type: "asset", id: a.id })) ? a : null)))).filter((a) => a !== null) : page;
  const last = page[page.length - 1];
  return {
    items: allowed.map((a) => ({ id: a.id, kind: a.kind, title: a.title || a.original_filename, fileName: a.original_filename, width: a.width, height: a.height, durationSeconds: a.duration_seconds, sizeBytes: Number(a.size_bytes ?? 0) })),
    nextCursor: rows.length > PAGE_SIZE && last ? `${last.created_at}|${last.id}` : null,
  };
}

// --- Firmado ---------------------------------------------------------------------------------------------------------------

export type SignMode = "thumb" | "view" | "download";
export type SignResult = { ok: true; url: string; expiresIn: number } | { ok: false; reason: "gone" | "denied" | "limit" };

const DERIVATIVE: Record<string, { type: "thumb" | "web" | "proxy" | "poster" | "audio_preview"; mime: string }> = {
  thumb: { type: "thumb", mime: "image/webp" },
  web: { type: "web", mime: "image/webp" },
  proxy: { type: "proxy", mime: "video/mp4" },
  poster: { type: "poster", mime: "image/jpeg" },
  audio_preview: { type: "audio_preview", mime: "audio/mpeg" },
};

export async function signShare(link: ShareLink, assetId: unknown, mode: SignMode, client: ClientInfo): Promise<SignResult> {
  if (typeof assetId !== "string" || !/^[0-9a-f-]{36}$/i.test(assetId)) return { ok: false, reason: "gone" };
  const admin = createAdminClient();
  const { data } = await admin.from("assets").select(ASSET_COLUMNS).eq("id", assetId).maybeSingle();
  const asset = data as AssetRow | null;
  if (!asset || !(await inScope(link, asset))) return { ok: false, reason: "gone" };

  let variant: keyof typeof DERIVATIVE | "original";
  if (mode === "download") {
    if (!link.can_download) return { ok: false, reason: "denied" };
    // Descargar exige que el creador siga pudiendo (rol, alcance, sesión con descarga activa, beat descargable…)
    let allowed = false;
    if (link.resource_type === "beat_set") {
      const beat = (await beatsOf(link)).find((b) => b.asset_id === asset.id);
      allowed = !!beat && (await can(link.created_by as string, "download", { type: "beat", id: beat.id }));
    } else allowed = await can(link.created_by as string, "download", { type: "asset", id: asset.id });
    if (!allowed) return { ok: false, reason: "denied" };
    variant = "original";
    if (asset.session_id) {
      const { data: session } = await admin.from("sessions").select("download_mode").eq("id", asset.session_id).maybeSingle();
      const downloadMode = (session as { download_mode: string } | null)?.download_mode ?? "off";
      if (downloadMode === "off") return { ok: false, reason: "denied" };
      if (downloadMode === "web") variant = "web";
    }
  } else if (asset.kind === "photo") variant = mode === "thumb" ? "thumb" : "web";
  else if (asset.kind === "video") variant = mode === "thumb" ? "poster" : "proxy";
  else if (asset.kind === "audio") {
    if (mode === "thumb") return { ok: false, reason: "gone" }; // el audio no tiene miniatura
    variant = "audio_preview";
  } else return { ok: false, reason: "denied" }; // documentos: solo descarga

  let key = asset.storage_key;
  let contentType = classifyFilename(asset.original_filename)?.mime ?? "application/octet-stream";
  let filename = asset.original_filename;
  if (variant !== "original") {
    const spec = DERIVATIVE[variant] as (typeof DERIVATIVE)[string];
    const { data: derivative } = await admin.from("asset_derivatives").select("storage_key, status").eq("asset_id", asset.id).eq("type", spec.type).maybeSingle();
    const d = derivative as { storage_key: string; status: string } | null;
    if (!d || d.status !== "ready") return { ok: false, reason: "gone" };
    key = d.storage_key;
    contentType = spec.mime;
    if (mode === "download") filename = `${asset.original_filename.replace(/\.[^.]*$/, "")}.webp`;
  }
  if (mode === "download" && asset.kind === "audio") {
    const beat = (await beatsOf(link)).find((b) => b.asset_id === asset.id);
    const ext = asset.original_filename.includes(".") ? asset.original_filename.slice(asset.original_filename.lastIndexOf(".")) : "";
    if (beat) filename = `${beat.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").trim().slice(0, 120) || "beat"}${ext}`;
  }

  // Cupo de descargas (atómico) ANTES de firmar
  if (mode === "download") {
    const { data: counted, error } = await admin.rpc("share_register_download", { p_link: link.id });
    if (error || counted !== true) return { ok: false, reason: "limit" };
  }
  const signed = await signGetUrl({ key, mode: mode === "download" ? "download" : "view", contentType, filename, ttlSeconds: mode === "download" ? SHARE_DOWNLOAD_TTL : SHARE_VIEW_TTL });
  if (mode !== "thumb") await recordEvent(link.id, mode === "download" ? "download" : "view", client);
  return { ok: true, url: signed.url, expiresIn: signed.expiresIn };
}

/** Archivos del enlace sobre los que se puede comentar (para validar `assetId`). */
export async function assetInShare(link: ShareLink, assetId: unknown): Promise<AssetRow | null> {
  if (typeof assetId !== "string" || !/^[0-9a-f-]{36}$/i.test(assetId)) return null;
  const { data } = await createAdminClient().from("assets").select(ASSET_COLUMNS).eq("id", assetId).maybeSingle();
  const asset = data as AssetRow | null;
  return asset && (await inScope(link, asset)) ? asset : null;
}

/** Miniaturas (5 min) de una página ya validada: una sola consulta de derivados y firmado directo. */
export async function signThumbs(items: PublicItem[]): Promise<Record<string, string>> {
  const wanted = items.filter((i) => i.kind === "photo" || i.kind === "video");
  if (wanted.length === 0) return {};
  const { data } = await createAdminClient().from("asset_derivatives").select("asset_id, type, storage_key").in("asset_id", wanted.map((i) => i.id)).in("type", ["thumb", "poster"]).eq("status", "ready");
  const rows = (data ?? []) as { asset_id: string; type: string; storage_key: string }[];
  const out: Record<string, string> = {};
  await Promise.all(
    wanted.map(async (item) => {
      const type = item.kind === "photo" ? "thumb" : "poster";
      const row = rows.find((r) => r.asset_id === item.id && r.type === type);
      if (row) out[item.id] = (await signGetUrl({ key: row.storage_key, mode: "view", contentType: type === "thumb" ? "image/webp" : "image/jpeg", ttlSeconds: SHARE_VIEW_TTL })).url;
    }),
  );
  return out;
}
