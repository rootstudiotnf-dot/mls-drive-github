"use server";

import { fail, GENERIC_ERROR, ok, type ActionResult } from "@/lib/action-result";
import { getActor, type Actor } from "@/lib/auth/session";
import { getShareSalt, getSiteUrl } from "@/lib/env";
import { logActivity } from "@/lib/permissions/audit";
import { can, ForbiddenError, getEffectiveRole, runAction } from "@/lib/permissions/server";
import { isExpiryDays, generateToken, hashPassword, hashToken, linkState, MAX_PASSWORD, MIN_PASSWORD, type LinkState } from "@/lib/share/token";
import { rateLimit } from "@/lib/share/server";
import { isUuid } from "@/lib/storage/keys";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * Enlaces externos (gestión interna). Todo se comprueba en servidor:
 *  - quien crea debe poder PUBLICAR (rol) y VER cada recurso que comparte (y DESCARGARLO si lo permite);
 *  - NADA del Vault (se rechaza aquí y, además, lo impide un trigger de la base de datos);
 *  - caducidad obligatoria de 1, 7 o 30 días; el token se muestra UNA vez y solo se guarda su hash.
 */

export type ShareTarget =
  | { kind: "session"; id: string }
  | { kind: "folder"; id: string }
  | { kind: "assets"; ids: string[] }
  | { kind: "beats"; ids: string[] };

export type CreateShareInput = {
  target: ShareTarget;
  title: string;
  message?: string;
  days: number;
  password?: string;
  canDownload: boolean;
  canComment: boolean;
  maxDownloads?: number | null;
};

const VAULT_MESSAGE = "El contenido del Vault no se puede compartir por enlace.";
const NO_ACCESS = "No tienes acceso a todo lo que quieres compartir.";

async function requireSharer(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new ForbiddenError();
  const role = await getEffectiveRole();
  // Compartir hacia fuera es un acto de publicación: hace falta poder publicar algo
  if (!role || !["photos", "videos", "files", "beats"].some((a) => role.permissions.has(`${a}.publish`))) throw new ForbiddenError();
  return actor;
}

const cleanText = (value: unknown, max: number) => String(value ?? "").replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);

export async function createShareLink(input: CreateShareInput): Promise<ActionResult<{ id: string; url: string }>> {
  return runAction(async () => {
    const actor = await requireSharer();
    if (!getShareSalt()) return fail("Los enlaces externos no están configurados en este servidor (SHARE_LINK_SALT).");
    if (!input || typeof input !== "object" || !input.target) return fail(GENERIC_ERROR);
    if (!isExpiryDays(input.days)) return fail("Elige 1, 7 o 30 días de caducidad.");
    const title = cleanText(input.title, 120);
    if (title.length < 1) return fail("Pon un título al enlace.");
    const message = cleanText(input.message, 1000) || null;
    const canDownload = input.canDownload === true;
    const canComment = input.canComment === true;
    let passwordHash: string | null = null;
    if (typeof input.password === "string" && input.password.length > 0) {
      if (input.password.length < MIN_PASSWORD || input.password.length > MAX_PASSWORD) return fail(`La contraseña debe tener entre ${MIN_PASSWORD} y ${MAX_PASSWORD} caracteres.`);
      passwordHash = hashPassword(input.password);
    }
    let maxDownloads: number | null = null;
    if (input.maxDownloads !== null && input.maxDownloads !== undefined) {
      if (!Number.isInteger(input.maxDownloads) || input.maxDownloads < 1 || input.maxDownloads > 100000) return fail("El límite de descargas no es válido.");
      if (canDownload) maxDownloads = input.maxDownloads;
    }
    if (!(await rateLimit(`mk:${actor.id}`, 3600, 30))) return fail("Has creado demasiados enlaces seguidos. Inténtalo más tarde.");

    const admin = createAdminClient();
    const t = input.target;
    const row: Record<string, unknown> = {};
    let count = 1;

    if (t.kind === "session" || t.kind === "folder") {
      if (!isUuid(t.id)) return fail(GENERIC_ERROR);
      if (t.kind === "session") {
        const { data } = await admin.from("sessions").select("id, download_mode").eq("id", t.id).is("deleted_at", null).maybeSingle();
        const s = data as { id: string; download_mode: string } | null;
        if (!s || !(await can(actor.id, "view", { type: "session", id: s.id }))) return fail(NO_ACCESS);
        if (canDownload && s.download_mode === "off") return fail("Esa sesión tiene la descarga desactivada: actívala antes de permitir descargas en el enlace.");
      } else {
        const { data } = await admin.from("folders").select("id, space, deleted_at").eq("id", t.id).maybeSingle();
        const f = data as { id: string; space: string; deleted_at: string | null } | null;
        if (f?.space === "vault") return fail(VAULT_MESSAGE);
        if (!f || f.deleted_at || !(await can(actor.id, "view", { type: "folder", id: f.id }))) return fail(NO_ACCESS);
      }
      Object.assign(row, { resource_type: t.kind, resource_id: t.id });
    } else if (t.kind === "assets" || t.kind === "beats") {
      const ids = Array.isArray(t.ids) ? [...new Set(t.ids)] : [];
      const max = t.kind === "assets" ? 500 : 200;
      if (ids.length === 0 || ids.length > max || !ids.every((i) => isUuid(i))) return fail(`Elige entre 1 y ${max} elementos.`);
      count = ids.length;
      if (t.kind === "assets") {
        const { data } = await admin.from("assets").select("id, space, status, deleted_at").in("id", ids);
        const found = (data ?? []) as { id: string; space: string; status: string; deleted_at: string | null }[];
        if (found.some((a) => a.space === "vault")) return fail(VAULT_MESSAGE);
        if (found.length !== ids.length || found.some((a) => a.status !== "ready" || a.deleted_at)) return fail(NO_ACCESS);
        const views = await Promise.all(ids.map((id) => can(actor.id, "view", { type: "asset", id })));
        if (!views.every(Boolean)) return fail(NO_ACCESS);
        if (canDownload && !(await Promise.all(ids.map((id) => can(actor.id, "download", { type: "asset", id })))).every(Boolean)) return fail("No puedes permitir la descarga de algunos de esos archivos.");
      } else {
        const { data } = await admin.from("beats").select("id, asset_id, deleted_at").in("id", ids);
        const beats = (data ?? []) as { id: string; asset_id: string; deleted_at: string | null }[];
        const { data: assets } = await admin.from("assets").select("id, space").in("id", beats.map((b) => b.asset_id));
        if (((assets ?? []) as { space: string }[]).some((a) => a.space === "vault")) return fail(VAULT_MESSAGE);
        if (beats.length !== ids.length || beats.some((b) => b.deleted_at)) return fail(NO_ACCESS);
        if (!(await Promise.all(ids.map((id) => can(actor.id, "view", { type: "beat", id })))).every(Boolean)) return fail(NO_ACCESS);
        if (canDownload && !(await Promise.all(ids.map((id) => can(actor.id, "download", { type: "beat", id })))).every(Boolean)) return fail("No puedes permitir la descarga de algunos de esos beats.");
      }
      Object.assign(row, { resource_type: t.kind === "assets" ? "asset_set" : "beat_set", resource_ids: ids });
    } else return fail(GENERIC_ERROR);

    const token = generateToken();
    const expires = new Date(Date.now() + input.days * 24 * 3600_000 - 60_000).toISOString();
    const { data: created, error } = await admin
      .from("share_links")
      .insert({ ...row, token_hash: hashToken(token), title, message, can_download: canDownload, can_comment: canComment, password_hash: passwordHash, expires_at: expires, max_downloads: maxDownloads, created_by: actor.id })
      .select("id")
      .single();
    if (error || !created) return fail(error?.code === "P0001" ? VAULT_MESSAGE : GENERIC_ERROR);
    const id = (created as { id: string }).id;
    await logActivity({ actorId: actor.id, action: "share.created", resourceType: "share_link", resourceId: id, metadata: { type: row.resource_type, days: input.days, download: canDownload, comments: canComment, password: passwordHash !== null, items: count } });
    return ok("Enlace creado.", { id, url: `${getSiteUrl()}/c/${token}` }); // el token en claro solo existe en esta respuesta
  });
}

// ---------------------------------------------------------------------------
// Gestión: lista, detalle, revocar
// ---------------------------------------------------------------------------

export type ShareLinkSummary = {
  id: string;
  title: string;
  target: string;
  state: LinkState;
  views: number;
  downloads: number;
  maxDownloads: number | null;
  expiresAt: string;
  createdAt: string;
  creator: string;
  canDownload: boolean;
  canComment: boolean;
  hasPassword: boolean;
  /** El enlace puede revocarlo quien lo creó o quien gestiona accesos (lo comprueba la base de datos y el servidor) */
  openedAt: string | null;
};

type LinkRow = { id: string; title: string; resource_type: string; resource_id: string | null; resource_ids: string[] | null; can_download: boolean; can_comment: boolean; password_hash: string | null; expires_at: string; max_downloads: number | null; view_count: number; download_count: number; first_opened_at: string | null; created_by: string | null; revoked_at: string | null; created_at: string };
const LINK_COLUMNS = "id, title, resource_type, resource_id, resource_ids, can_download, can_comment, password_hash, expires_at, max_downloads, view_count, download_count, first_opened_at, created_by, revoked_at, created_at";

async function describeTargets(rows: LinkRow[]): Promise<Map<string, string>> {
  const admin = createAdminClient();
  const sessionIds = rows.filter((r) => r.resource_type === "session" && r.resource_id).map((r) => r.resource_id as string);
  const folderIds = rows.filter((r) => r.resource_type === "folder" && r.resource_id).map((r) => r.resource_id as string);
  const [sessions, folders] = await Promise.all([
    sessionIds.length ? admin.from("sessions").select("id, name").in("id", sessionIds) : { data: [] },
    folderIds.length ? admin.from("folders").select("id, name").in("id", folderIds) : { data: [] },
  ]);
  const names = new Map<string, string>();
  for (const s of (sessions.data ?? []) as { id: string; name: string }[]) names.set(s.id, `Sesión «${s.name}»`);
  for (const f of (folders.data ?? []) as { id: string; name: string }[]) names.set(f.id, `Carpeta «${f.name}»`);
  const out = new Map<string, string>();
  for (const r of rows) {
    const n = r.resource_ids?.length ?? 0;
    out.set(r.id, r.resource_type === "asset_set" ? `${n} ${n === 1 ? "archivo" : "archivos"}` : r.resource_type === "beat_set" ? `${n} ${n === 1 ? "beat" : "beats"}` : (names.get(r.resource_id as string) ?? "Recurso eliminado"));
  }
  return out;
}

async function toSummaries(rows: LinkRow[]): Promise<ShareLinkSummary[]> {
  const targets = await describeTargets(rows);
  const creatorIds = [...new Set(rows.map((r) => r.created_by).filter((v): v is string => !!v))];
  const { data: people } = creatorIds.length ? await createAdminClient().from("profiles").select("id, full_name, email").in("id", creatorIds) : { data: [] };
  const names = new Map(((people ?? []) as { id: string; full_name: string | null; email: string }[]).map((p) => [p.id, p.full_name || p.email]));
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    target: targets.get(r.id) ?? "—",
    state: linkState(r),
    views: r.view_count,
    downloads: r.download_count,
    maxDownloads: r.max_downloads,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    creator: r.created_by ? (names.get(r.created_by) ?? "—") : "Cuenta eliminada",
    canDownload: r.can_download,
    canComment: r.can_comment,
    hasPassword: r.password_hash !== null,
    openedAt: r.first_opened_at,
  }));
}

/** Enlaces visibles para esta persona (RLS: los suyos o todos si gestiona accesos). */
export async function listShareLinks(): Promise<ActionResult<ShareLinkSummary[]>> {
  return runAction(async () => {
    const actor = await getActor();
    if (!actor) throw new ForbiddenError();
    const supabase = await createClient();
    const { data } = await supabase.from("share_links").select(LINK_COLUMNS).order("created_at", { ascending: false }).limit(300);
    return ok<ShareLinkSummary[]>(undefined, await toSummaries((data ?? []) as LinkRow[]));
  });
}

export type ShareEvent = { id: string; type: string; who: string; userAgent: string | null; createdAt: string };

export async function getShareLinkDetail(id: string): Promise<ActionResult<{ link: ShareLinkSummary; events: ShareEvent[] }>> {
  return runAction(async () => {
    const actor = await getActor();
    if (!actor || !isUuid(id)) throw new ForbiddenError();
    const supabase = await createClient();
    const { data } = await supabase.from("share_links").select(LINK_COLUMNS).eq("id", id).maybeSingle();
    if (!data) throw new ForbiddenError();
    const { data: events } = await supabase.from("share_link_events").select("id, type, ip_hash, user_agent, created_at").eq("link_id", id).order("created_at", { ascending: false }).limit(100);
    const [link] = await toSummaries([data as LinkRow]);
    return ok(undefined, {
      link: link as ShareLinkSummary,
      // Solo un fragmento del hash: sirve para distinguir visitantes, no para identificarlos
      events: ((events ?? []) as { id: string; type: string; ip_hash: string | null; user_agent: string | null; created_at: string }[]).map((e) => ({ id: e.id, type: e.type, who: e.ip_hash ? e.ip_hash.slice(0, 8) : "—", userAgent: e.user_agent, createdAt: e.created_at })),
    });
  });
}

export async function revokeShareLink(id: string): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await getActor();
    if (!actor || !isUuid(id)) throw new ForbiddenError();
    // Solo si la base de datos (RLS) le deja ver el enlace: el creador o quien gestiona accesos
    const supabase = await createClient();
    const { data } = await supabase.from("share_links").select("id, revoked_at").eq("id", id).maybeSingle();
    const link = data as { id: string; revoked_at: string | null } | null;
    if (!link) throw new ForbiddenError();
    if (link.revoked_at) return ok("Ya estaba revocado.");
    const { error } = await createAdminClient().from("share_links").update({ revoked_at: new Date().toISOString() }).eq("id", id).is("revoked_at", null);
    if (error) return fail(GENERIC_ERROR);
    await logActivity({ actorId: actor.id, action: "share.revoked", resourceType: "share_link", resourceId: id });
    return ok("Enlace revocado. Ya no se puede abrir.");
  });
}
