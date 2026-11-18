"use server";

import { fail, ok, type ActionResult } from "@/lib/action-result";
import { notify } from "@/lib/notifications/notify";
import {
  assetInShare,
  clientInfo,
  grantPasswordAccess,
  hasPasswordAccess,
  IP_REQUESTS_PER_MINUTE,
  listShareItems,
  loadShare,
  passwordAttemptsLeft,
  rateLimit,
  recordEvent,
  signShare,
  signThumbs,
  type ClientInfo,
  type PublicPage,
  type ShareLink,
  type SignMode,
} from "@/lib/share/server";
import { MAX_PASSWORD, verifyPasswordHash } from "@/lib/share/token";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Acciones PÚBLICAS de un enlace externo. Sin sesión: cada una valida el token (hash, caducidad, revocación,
 * acceso del creador, contraseña) y limita las peticiones por IP. Todo fallo es el mismo mensaje neutro.
 */

const GONE = "Este enlace no está disponible.";

type Guarded = { link: ShareLink; client: ClientInfo };

async function guard(token: unknown, options: { needPassword?: boolean } = {}): Promise<Guarded | null> {
  const client = await clientInfo();
  if (!client) return null;
  if (!(await rateLimit(`ip:${client.ipHash}`, 60, IP_REQUESTS_PER_MINUTE))) return null; // límite por IP al endpoint público
  const link = await loadShare(token);
  if (!link) return null;
  if (options.needPassword !== false && !(await hasPasswordAccess(link))) return null;
  return { link, client };
}

export type ShareListData = PublicPage & { thumbs: Record<string, string> };

export async function shareList(input: { token: string; cursor?: string | null }): Promise<ActionResult<ShareListData>> {
  const g = await guard(input?.token);
  if (!g) return fail(GONE);
  const page = await listShareItems(g.link, typeof input.cursor === "string" ? input.cursor : null);
  return ok<ShareListData>(undefined, { ...page, thumbs: await signThumbs(page.items) });
}

export async function shareSign(input: { token: string; assetId: string; mode: SignMode }): Promise<ActionResult<{ url: string }>> {
  if (input?.mode !== "thumb" && input?.mode !== "view" && input?.mode !== "download") return fail(GONE);
  const g = await guard(input.token);
  if (!g) return fail(GONE);
  const result = await signShare(g.link, input.assetId, input.mode, g.client);
  if (result.ok) return ok(undefined, { url: result.url });
  return fail(result.reason === "limit" ? "Se ha alcanzado el límite de descargas de este enlace." : result.reason === "denied" ? "Este enlace no permite descargar." : GONE);
}

export async function shareUnlock(input: { token: string; password: string }): Promise<ActionResult> {
  const g = await guard(input?.token, { needPassword: false });
  if (!g || !g.link.password_hash) return fail(GONE);
  if ((await passwordAttemptsLeft(g.link.id, g.client.ipHash)) <= 0) return fail("Demasiados intentos. Inténtalo de nuevo en 15 minutos.");
  const password = typeof input.password === "string" ? input.password : "";
  if (password.length === 0 || password.length > MAX_PASSWORD || !verifyPasswordHash(password, g.link.password_hash)) {
    await recordEvent(g.link.id, "password_fail", g.client);
    const left = await passwordAttemptsLeft(g.link.id, g.client.ipHash);
    return fail(left <= 0 ? "Demasiados intentos. Inténtalo de nuevo en 15 minutos." : "La contraseña no es correcta.");
  }
  await grantPasswordAccess(g.link);
  return ok();
}

// --- Comentarios de visitantes (nombre obligatorio, sin menciones, límites) ------------------------------------------

export type PublicComment = { id: string; author: string; external: boolean; body: string; timecodeMs: number | null; createdAt: string; replyTo: string | null };

export async function shareComments(input: { token: string; assetId: string }): Promise<ActionResult<PublicComment[]>> {
  const g = await guard(input?.token);
  if (!g || !g.link.can_comment) return fail(GONE);
  const asset = await assetInShare(g.link, input.assetId);
  if (!asset) return fail(GONE);
  const admin = createAdminClient();
  const { data } = await admin.from("comments").select("id, user_id, external_name, body, timecode_ms, created_at, parent_id").eq("asset_id", asset.id).is("deleted_at", null).order("created_at", { ascending: true }).limit(300);
  const rows = (data ?? []) as { id: string; user_id: string | null; external_name: string | null; body: string; timecode_ms: number | null; created_at: string; parent_id: string | null }[];
  return ok<PublicComment[]>(undefined, rows.map((r) => ({ id: r.id, author: r.external_name ?? "Equipo", external: r.external_name !== null, body: r.body, timecodeMs: r.timecode_ms, createdAt: r.created_at, replyTo: r.parent_id })));
}

const cleanName = (value: unknown) => String(value ?? "").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
const cleanBody = (value: unknown) => String(value ?? "").replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();

export async function shareAddComment(input: { token: string; assetId: string; name: string; body: string; timecodeMs?: number | null }): Promise<ActionResult> {
  const g = await guard(input?.token);
  if (!g || !g.link.can_comment) return fail(GONE);
  const asset = await assetInShare(g.link, input.assetId);
  if (!asset || (asset.kind !== "photo" && asset.kind !== "video" && asset.kind !== "audio")) return fail(GONE);
  const name = cleanName(input.name);
  const body = cleanBody(input.body);
  if (name.length < 1) return fail("Escribe tu nombre para comentar.");
  if (body.length < 1 || body.length > 1000) return fail("El comentario debe tener entre 1 y 1000 caracteres.");
  const timecode = input.timecodeMs === null || input.timecodeMs === undefined ? null : Number.isInteger(input.timecodeMs) && input.timecodeMs >= 0 && input.timecodeMs <= 86_400_000 && asset.kind !== "photo" ? input.timecodeMs : undefined;
  if (timecode === undefined) return fail("La marca de tiempo no es válida.");
  if (!(await rateLimit(`cm:${g.link.id}:${g.client.ipHash}`, 600, 10))) return fail("Has comentado demasiado seguido. Inténtalo en unos minutos.");

  const admin = createAdminClient();
  const { error } = await admin.from("comments").insert({ asset_id: asset.id, user_id: null, external_name: name, share_link_id: g.link.id, body, timecode_ms: timecode, mentions: [] });
  if (error) return fail(GONE);
  await recordEvent(g.link.id, "comment", g.client);

  // Aviso a quien creó el enlace (solo texto y una ruta de la plataforma)
  const { data: beat } = asset.kind === "audio" ? await admin.from("beats").select("id").eq("asset_id", asset.id).is("deleted_at", null).maybeSingle() : { data: null };
  const path = beat ? `/beats/${(beat as { id: string }).id}` : `/archivo/${asset.id}`;
  await notify("comment", { recipients: g.link.created_by ? [g.link.created_by] : [], groupKey: `comment:${asset.id}`, assetIds: [asset.id], payload: { title: g.link.title, path, actorName: `${name} (externo)` } });
  return ok("Comentario enviado.");
}
