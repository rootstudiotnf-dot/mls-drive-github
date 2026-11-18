"use server";

import { fail, GENERIC_ERROR, ok, type ActionResult } from "@/lib/action-result";
import { getActor, type Actor } from "@/lib/auth/session";
import { MAX_COMMENT_LENGTH, MAX_COMMENTS_PER_HOUR, type CommentItem, type CommentsData } from "@/lib/comments/types";
import { logActivity } from "@/lib/permissions/audit";
import { can, ForbiddenError, runAction } from "@/lib/permissions/server";
import { notify, withAccess } from "@/lib/notifications/notify";
import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/storage/keys";

/**
 * Comentarios con marca de tiempo (vídeo ahora; audio en la Fase 7). Reglas, todas en servidor y base de datos:
 *  - se LEE lo que `can_access(view)` deja ver del asset (RLS de `comments`): quien pierde el acceso deja de verlos;
 *  - se ESCRIBE solo con `<área>.comment` (función `can_comment`), nunca desde el cliente;
 *  - cada persona edita y borra los suyos; quien puede EDITAR el asset (owner/admin) resuelve y borra cualquiera;
 *  - 2.000 caracteres como máximo y 30 comentarios por persona y hora;
 *  - el texto es siempre texto (React lo escapa al pintarlo); en activity_log solo queda un resumen, sin copiar el texto.
 */

async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new ForbiddenError();
  return actor;
}

async function canComment(actorId: string, assetId: string): Promise<boolean> {
  const { data, error } = await createAdminClient().rpc("can_comment", { p_user: actorId, p_asset: assetId });
  return !error && data === true;
}

type Row = {
  id: string;
  parent_id: string | null;
  user_id: string | null;
  body: string;
  timecode_ms: number | null;
  resolved: boolean;
  created_at: string;
  edited_at: string | null;
  external_name: string | null;
  mentions: string[] | null;
};

/** Comentarios de un asset (RLS decide si se ven) y qué puede hacer la persona actual. */
export async function listComments(assetId: string): Promise<ActionResult<CommentsData>> {
  return runAction(async () => {
    const actor = await requireActor();
    if (!isUuid(assetId)) return fail(GENERIC_ERROR);
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("comments")
      .select("id, parent_id, user_id, body, timecode_ms, resolved, created_at, edited_at, external_name, mentions")
      .eq("asset_id", assetId)
      .is("deleted_at", null)
      .order("created_at", { ascending: true })
      .limit(1000);
    if (error) return fail(GENERIC_ERROR);
    const rows = (data ?? []) as unknown as Row[];

    const userIds = [...new Set([...rows.map((r) => r.user_id), ...rows.flatMap((r) => r.mentions ?? [])].filter((v): v is string => !!v))];
    const names = new Map<string, string>();
    if (userIds.length > 0) {
      const { data: people } = await createAdminClient().from("profiles").select("id, full_name, email").in("id", userIds);
      for (const p of (people ?? []) as { id: string; full_name: string | null; email: string }[]) names.set(p.id, p.full_name || p.email.split("@")[0] || "Alguien");
    }
    const [commenter, moderator] = await Promise.all([canComment(actor.id, assetId), can(actor.id, "edit", { type: "asset", id: assetId })]);
    const comments: CommentItem[] = rows.map((r) => ({
      id: r.id,
      parentId: r.parent_id,
      authorName: r.external_name ? r.external_name : r.user_id ? (names.get(r.user_id) ?? "Alguien") : "Usuario eliminado",
      external: r.external_name !== null,
      mentions: (r.mentions ?? []).map((id) => ({ id, name: names.get(id) ?? "Alguien" })),
      mine: r.user_id === actor.id,
      body: r.body,
      timecodeMs: r.timecode_ms,
      resolved: r.resolved,
      createdAt: r.created_at,
      editedAt: r.edited_at,
    }));
    return ok<CommentsData>(undefined, { comments, canComment: commenter, canModerate: moderator });
  });
}

function parseBody(value: unknown): string | null {
  const body = typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : "";
  return body.length >= 1 && body.length <= MAX_COMMENT_LENGTH ? body : null;
}

export async function createComment(input: {
  assetId: string;
  body: string;
  timecodeMs: number | null;
  parentId?: string | null;
  /** Personas mencionadas con @ (solo se admiten las que pueden ver el archivo) */
  mentions?: string[];
}): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const actor = await requireActor();
    if (!input || !isUuid(input.assetId)) return fail(GENERIC_ERROR);
    if (!(await canComment(actor.id, input.assetId))) throw new ForbiddenError();

    const body = parseBody(input.body);
    if (!body) return fail(`El comentario debe tener entre 1 y ${MAX_COMMENT_LENGTH} caracteres.`);
    const timecode =
      input.timecodeMs === null || input.timecodeMs === undefined
        ? null
        : Number.isInteger(input.timecodeMs) && input.timecodeMs >= 0 && input.timecodeMs <= 86_400_000
          ? input.timecodeMs
          : undefined;
    if (timecode === undefined) return fail("La marca de tiempo no es válida.");
    const parentId = input.parentId ?? null;
    if (parentId !== null && !isUuid(parentId)) return fail(GENERIC_ERROR);

    const admin = createAdminClient();
    const { count } = await admin
      .from("comments")
      .select("id", { count: "exact", head: true })
      .eq("user_id", actor.id)
      .gte("created_at", new Date(Date.now() - 60 * 60 * 1000).toISOString());
    if ((count ?? 0) >= MAX_COMMENTS_PER_HOUR) return fail("Has llegado al límite de comentarios por hora. Inténtalo más tarde.");

    if (parentId) {
      const { data: parent } = await admin.from("comments").select("id, parent_id").eq("id", parentId).eq("asset_id", input.assetId).is("deleted_at", null).maybeSingle();
      if (!parent) return fail("El comentario al que respondes ya no existe.");
    }
    // Menciones: solo personas activas con acceso al archivo (nunca se revela el recurso a quien no lo ve)
    const wanted = Array.isArray(input.mentions) ? [...new Set(input.mentions.filter((m) => isUuid(m) && m !== actor.id))].slice(0, 10) : [];
    const mentioned = wanted.length > 0 ? await withAccess(wanted, { type: "asset", id: input.assetId }) : [];
    const { data, error } = await admin
      .from("comments")
      .insert({ asset_id: input.assetId, user_id: actor.id, parent_id: parentId, body, timecode_ms: parentId ? null : timecode, mentions: mentioned })
      .select("id")
      .single();
    if (error || !data) return fail(GENERIC_ERROR);
    const id = (data as { id: string }).id;
    after(() => void notifyComment(actor, input.assetId, parentId, mentioned));
    await logActivity({ actorId: actor.id, action: "comment.created", resourceType: "asset", resourceId: input.assetId, metadata: { commentId: id, reply: parentId !== null, timed: timecode !== null } });
    return ok(undefined, { id });
  });
}

async function loadOwnOrModerated(actor: Actor, commentId: unknown): Promise<{ id: string; asset_id: string; user_id: string | null; parent_id: string | null; mine: boolean; moderator: boolean }> {
  if (!isUuid(commentId)) throw new ForbiddenError();
  const { data } = await createAdminClient().from("comments").select("id, asset_id, user_id, parent_id").eq("id", commentId).is("deleted_at", null).maybeSingle();
  const row = data as { id: string; asset_id: string; user_id: string | null; parent_id: string | null } | null;
  if (!row) throw new ForbiddenError();
  // Debe seguir viendo el asset (si pierde el acceso, ya no toca sus comentarios)
  if (!(await can(actor.id, "view", { type: "asset", id: row.asset_id }))) throw new ForbiddenError();
  const moderator = await can(actor.id, "edit", { type: "asset", id: row.asset_id });
  return { ...row, mine: row.user_id === actor.id, moderator };
}

export async function editComment(commentId: string, rawBody: string): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireActor();
    const row = await loadOwnOrModerated(actor, commentId);
    if (!row.mine) throw new ForbiddenError(); // solo los suyos
    const body = parseBody(rawBody);
    if (!body) return fail(`El comentario debe tener entre 1 y ${MAX_COMMENT_LENGTH} caracteres.`);
    const { error } = await createAdminClient().from("comments").update({ body, edited_at: new Date().toISOString() }).eq("id", row.id);
    if (error) return fail(GENERIC_ERROR);
    await logActivity({ actorId: actor.id, action: "comment.edited", resourceType: "asset", resourceId: row.asset_id, metadata: { commentId: row.id } });
    return ok();
  });
}

export async function deleteComment(commentId: string): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireActor();
    const row = await loadOwnOrModerated(actor, commentId);
    if (!row.mine && !row.moderator) throw new ForbiddenError();
    const admin = createAdminClient();
    const now = new Date().toISOString();
    // Borrar un comentario borra también sus respuestas (el hilo)
    await admin.from("comments").update({ deleted_at: now }).eq("parent_id", row.id).is("deleted_at", null);
    const { error } = await admin.from("comments").update({ deleted_at: now }).eq("id", row.id);
    if (error) return fail(GENERIC_ERROR);
    await logActivity({ actorId: actor.id, action: "comment.deleted", resourceType: "asset", resourceId: row.asset_id, metadata: { commentId: row.id, byModerator: !row.mine } });
    return ok();
  });
}

/** Marcar como resuelto o pendiente: quien escribió el comentario o quien puede editar el archivo (moderación). */
export async function resolveComment(commentId: string, resolved: boolean): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireActor();
    const row = await loadOwnOrModerated(actor, commentId);
    if ((!row.moderator && !row.mine) || typeof resolved !== "boolean" || row.parent_id) throw new ForbiddenError();
    const { error } = await createAdminClient()
      .from("comments")
      .update({ resolved, resolved_by: resolved ? actor.id : null, resolved_at: resolved ? new Date().toISOString() : null })
      .eq("id", row.id);
    if (error) return fail(GENERIC_ERROR);
    await logActivity({ actorId: actor.id, action: resolved ? "comment.resolved" : "comment.reopened", resourceType: "asset", resourceId: row.asset_id, metadata: { commentId: row.id } });
    return ok();
  });
}

/** Personas a las que se puede mencionar en este archivo: activas y con acceso (no se ofrece a nadie más). */
export async function searchMentionable(assetId: string, query: string): Promise<ActionResult<{ id: string; name: string }[]>> {
  return runAction(async () => {
    const actor = await requireActor();
    if (!isUuid(assetId) || !(await can(actor.id, "view", { type: "asset", id: assetId }))) throw new ForbiddenError();
    const q = String(query ?? "").replace(/[%_\,()]/g, "").trim().slice(0, 40);
    let search = createAdminClient().from("profiles").select("id, full_name, email").eq("status", "active").neq("id", actor.id).limit(30);
    if (q) search = search.or(`full_name.ilike.${q}%,email.ilike.${q}%`);
    const { data } = await search;
    const people = (data ?? []) as { id: string; full_name: string | null; email: string }[];
    const allowed = await withAccess(people.map((p) => p.id), { type: "asset", id: assetId });
    return ok(undefined, people.filter((p) => allowed.includes(p.id)).slice(0, 8).map((p) => ({ id: p.id, name: p.full_name || p.email.split("@")[0] || "Alguien" })));
  });
}

/** Avisos de un comentario nuevo: menciones y participantes del hilo (siempre filtrados por acceso). */
async function notifyComment(actor: Actor, assetId: string, parentId: string | null, mentioned: string[]): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: asset } = await admin.from("assets").select("id, kind, title, original_filename, uploaded_by, space").eq("id", assetId).maybeSingle();
    const a = asset as { id: string; kind: string; title: string | null; original_filename: string; uploaded_by: string | null; space: string } | null;
    if (!a || a.space !== "workspace") return;
    const { data: beat } = a.kind === "audio" ? await admin.from("beats").select("id, title").eq("asset_id", a.id).is("deleted_at", null).maybeSingle() : { data: null };
    const b = beat as { id: string; title: string } | null;
    const title = b?.title ?? a.title ?? a.original_filename;
    const path = b ? `/beats/${b.id}` : `/archivo/${a.id}`;
    const payload = { title, path, actorName: actor.displayName };
    if (mentioned.length > 0) await notify("mention", { recipients: mentioned, actorId: actor.id, groupKey: `mention:${assetId}`, assetIds: [assetId], payload });
    const { data: thread } = await admin.from("comments").select("user_id").eq("asset_id", assetId).is("deleted_at", null).limit(200);
    const parent = parentId ? (await admin.from("comments").select("user_id").eq("id", parentId).maybeSingle()).data as { user_id: string | null } | null : null;
    const candidates = [...new Set([...((thread ?? []) as { user_id: string | null }[]).map((c) => c.user_id), a.uploaded_by, parent?.user_id].filter((v): v is string => !!v))].filter((id) => !mentioned.includes(id));
    const recipients = await withAccess(candidates, { type: "asset", id: assetId });
    await notify("comment", { recipients, actorId: actor.id, groupKey: `comment:${assetId}`, assetIds: [assetId], payload });
  } catch (error) {
    console.error("notifyComment failed:", error instanceof Error ? error.name : "unknown");
  }
}
