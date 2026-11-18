"use server";

import { revalidatePath } from "next/cache";
import { fail, GENERIC_ERROR, ok, type ActionResult } from "@/lib/action-result";
import { getActor, type Actor } from "@/lib/auth/session";
import { signAssetUrl } from "@/lib/assets/urls";
import { variantAllowed, type AssetVariant, type DownloadMode } from "@/lib/assets/variants";
import { logActivity } from "@/lib/permissions/audit";
import { can, ForbiddenError, runAction, userHasPermission } from "@/lib/permissions/server";
import { loadSession, loadSessionPhotos, MAX_SESSION_PHOTOS } from "@/lib/sessions/data";
import type { FavoriteEntry, SessionPhoto } from "@/lib/sessions/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/storage/keys";

/**
 * Sesiones de fotos: crear y editar, participantes, portada, orden manual, carpetas de la sesión, favoritas
 * y preparación de descargas. Toda acción empieza comprobando sesión y permisos EN SERVIDOR; las lecturas
 * van con el cliente del usuario (RLS) y las escrituras con el de servicio, tras autorizar.
 *
 * Quién puede qué:
 *  - crear / editar una sesión → `photos.edit` y poder editar en su artista;
 *  - cambiar el modo de descarga → además poder publicar (`photos.publish`);
 *  - añadir artistas participantes → poder ver a esos artistas (alcance del rol).
 */

const MODES: readonly DownloadMode[] = ["off", "web", "original"];

async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new ForbiddenError();
  return actor;
}

async function requireSessionEdit(actor: Actor, sessionId: unknown): Promise<{ id: string; artist_id: string }> {
  if (!isUuid(sessionId)) throw new ForbiddenError();
  if (!(await userHasPermission(actor.id, "photos.edit"))) throw new ForbiddenError();
  if (!(await can(actor.id, "edit", { type: "session", id: sessionId }))) throw new ForbiddenError();
  const { data } = await createAdminClient().from("sessions").select("id, artist_id").eq("id", sessionId).is("deleted_at", null).maybeSingle();
  if (!data) throw new ForbiddenError();
  return data as { id: string; artist_id: string };
}

function parseText(value: unknown, max: number): string | null {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length <= max ? text : null;
}

function parseDate(value: unknown): string | null | undefined {
  if (value === null || value === "" || value === undefined) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) return undefined;
  return value;
}

type SessionInput = {
  name: string;
  date: string | null;
  description: string | null;
  artistId: string;
  participantIds: string[];
  downloadMode: DownloadMode;
};

function parseSessionInput(raw: unknown): SessionInput | string {
  if (!raw || typeof raw !== "object") return "Datos no válidos.";
  const input = raw as Record<string, unknown>;
  const name = parseText(input.name, 80);
  if (!name || name.length < 2) return "El nombre debe tener entre 2 y 80 caracteres.";
  const description = parseText(input.description ?? "", 1000);
  if (description === null) return "La descripción es demasiado larga.";
  const date = parseDate(input.date);
  if (date === undefined) return "La fecha no es válida.";
  if (!isUuid(input.artistId)) return "Elige el artista principal.";
  const participants = Array.isArray(input.participantIds) ? [...new Set(input.participantIds)] : [];
  if (participants.length > 30 || !participants.every((id) => isUuid(id))) return "Participantes no válidos.";
  const downloadMode = MODES.find((m) => m === input.downloadMode);
  if (!downloadMode) return "Modo de descarga no válido.";
  return {
    name,
    date,
    description: description || null,
    artistId: input.artistId,
    participantIds: (participants as string[]).filter((id) => id !== input.artistId),
    downloadMode,
  };
}

async function checkArtistsScope(actor: Actor, artistId: string, participantIds: string[]): Promise<string | null> {
  if (!(await can(actor.id, "edit", { type: "artist", id: artistId }))) throw new ForbiddenError();
  for (const id of participantIds) {
    if (!(await can(actor.id, "view", { type: "artist", id }))) throw new ForbiddenError();
  }
  const { data } = await createAdminClient()
    .from("artists")
    .select("id")
    .in("id", [artistId, ...participantIds])
    .is("deleted_at", null);
  return (data?.length ?? 0) === new Set([artistId, ...participantIds]).size ? null : "Alguno de los artistas no existe.";
}

async function replaceParticipants(sessionId: string, participantIds: string[]) {
  const admin = createAdminClient();
  await admin.from("session_participants").delete().eq("session_id", sessionId);
  if (participantIds.length > 0) {
    await admin.from("session_participants").insert(participantIds.map((artist_id) => ({ session_id: sessionId, artist_id })));
  }
}

// ---------------------------------------------------------------------------
// Crear y editar
// ---------------------------------------------------------------------------

export async function createSession(raw: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const actor = await requireActor();
    if (!(await userHasPermission(actor.id, "photos.edit"))) throw new ForbiddenError();
    const input = parseSessionInput(raw);
    if (typeof input === "string") return fail(input);
    // El modo de descarga distinto de «off» exige poder publicar
    if (input.downloadMode !== "off" && !(await userHasPermission(actor.id, "photos.publish"))) throw new ForbiddenError();
    const scope = await checkArtistsScope(actor, input.artistId, input.participantIds);
    if (scope) return fail(scope);

    const { data, error } = await createAdminClient()
      .from("sessions")
      .insert({
        artist_id: input.artistId,
        name: input.name,
        date: input.date,
        description: input.description,
        download_mode: input.downloadMode,
        created_by: actor.id,
      })
      .select("id")
      .single();
    if (error || !data) return fail(GENERIC_ERROR);
    const id = (data as { id: string }).id;
    await replaceParticipants(id, input.participantIds);
    await logActivity({ actorId: actor.id, action: "session.created", resourceType: "session", resourceId: id, metadata: { name: input.name } });
    revalidatePath("/sesiones");
    return ok("Sesión creada.", { id });
  });
}

export async function updateSession(sessionId: string, raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireActor();
    const session = await requireSessionEdit(actor, sessionId);
    const input = parseSessionInput(raw);
    if (typeof input === "string") return fail(input);

    const current = await loadSession(session.id).catch(() => null);
    const modeChanged = !current || current.downloadMode !== input.downloadMode;
    if (modeChanged && !(await can(actor.id, "publish", { type: "session", id: session.id }))) throw new ForbiddenError();
    if (input.artistId !== session.artist_id) {
      // Cambiar el artista principal arrastra todo el contenido: se hace moviendo fotos, no editando la sesión
      return fail("El artista principal no se puede cambiar. Mueve las fotos a otra sesión.");
    }
    const scope = await checkArtistsScope(actor, input.artistId, input.participantIds);
    if (scope) return fail(scope);

    const { error } = await createAdminClient()
      .from("sessions")
      .update({ name: input.name, date: input.date, description: input.description, download_mode: input.downloadMode })
      .eq("id", session.id);
    if (error) return fail(GENERIC_ERROR);
    await replaceParticipants(session.id, input.participantIds);
    await logActivity({
      actorId: actor.id,
      action: modeChanged ? "session.download_mode_changed" : "session.updated",
      resourceType: "session",
      resourceId: session.id,
      metadata: { name: input.name, downloadMode: input.downloadMode },
    });
    revalidatePath("/sesiones");
    revalidatePath(`/sesiones/${session.id}`);
    return ok("Sesión guardada.");
  });
}

/** Portada: una foto de la propia sesión (null la quita). */
export async function setSessionCover(sessionId: string, assetId: string | null): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireActor();
    const session = await requireSessionEdit(actor, sessionId);
    const admin = createAdminClient();
    if (assetId !== null) {
      if (!isUuid(assetId)) return fail(GENERIC_ERROR);
      const { data } = await admin
        .from("assets")
        .select("id")
        .eq("id", assetId)
        .eq("session_id", session.id)
        .eq("kind", "photo")
        .eq("status", "ready")
        .is("deleted_at", null)
        .maybeSingle();
      if (!data) return fail("Esa foto no es de esta sesión.");
    }
    const { error } = await admin.from("sessions").update({ cover_asset_id: assetId }).eq("id", session.id);
    if (error) return fail(GENERIC_ERROR);
    await logActivity({ actorId: actor.id, action: "session.cover_changed", resourceType: "session", resourceId: session.id });
    revalidatePath("/sesiones");
    return ok(assetId ? "Portada actualizada." : "Portada quitada.");
  });
}

/** Orden manual: `ids` es el orden completo de las fotos de la sesión que se están viendo. */
export async function reorderSessionPhotos(sessionId: string, ids: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireActor();
    const session = await requireSessionEdit(actor, sessionId);
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_SESSION_PHOTOS || !ids.every((id) => isUuid(id))) {
      return fail("Orden no válido.");
    }
    const unique = [...new Set(ids as string[])];
    if (unique.length !== ids.length) return fail("Orden no válido.");
    const { error } = await createAdminClient().rpc("set_session_order", { p_session: session.id, p_ids: unique });
    if (error) return fail(GENERIC_ERROR);
    return ok("Orden guardado.");
  });
}

// ---------------------------------------------------------------------------
// Carpetas de la sesión
// ---------------------------------------------------------------------------

export async function createSessionFolder(input: { sessionId: string; name: string }): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const actor = await requireActor();
    const session = await requireSessionEdit(actor, input?.sessionId);
    const name = parseText(input?.name, 60);
    if (!name) return fail("El nombre debe tener entre 1 y 60 caracteres.");
    const admin = createAdminClient();
    const { data: last } = await admin.from("folders").select("sort").eq("session_id", session.id).is("deleted_at", null).order("sort", { ascending: false }).limit(1);
    const sort = ((last as { sort: number }[] | null)?.[0]?.sort ?? -1) + 1;
    const { data, error } = await admin
      .from("folders")
      .insert({ artist_id: session.artist_id, session_id: session.id, parent_id: null, name, kind: "photos", sort })
      .select("id")
      .single();
    if (error || !data) return fail(error?.code === "23505" ? "Ya hay una carpeta con ese nombre en esta sesión." : GENERIC_ERROR);
    await logActivity({ actorId: actor.id, action: "folder.created", resourceType: "session", resourceId: session.id, metadata: { name } });
    return ok("Carpeta creada.", { id: (data as { id: string }).id });
  });
}

async function loadSessionFolder(actor: Actor, folderId: unknown) {
  if (!isUuid(folderId)) throw new ForbiddenError();
  const { data } = await createAdminClient().from("folders").select("id, session_id, name").eq("id", folderId).is("deleted_at", null).maybeSingle();
  const folder = data as { id: string; session_id: string | null; name: string } | null;
  if (!folder || !folder.session_id) throw new ForbiddenError(); // las carpetas base del artista no son de sesión
  await requireSessionEdit(actor, folder.session_id);
  return folder as { id: string; session_id: string; name: string };
}

export async function renameSessionFolder(folderId: string, rawName: string): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireActor();
    const folder = await loadSessionFolder(actor, folderId);
    const name = parseText(rawName, 60);
    if (!name) return fail("El nombre debe tener entre 1 y 60 caracteres.");
    const { error } = await createAdminClient().from("folders").update({ name }).eq("id", folder.id);
    if (error) return fail(error.code === "23505" ? "Ya hay una carpeta con ese nombre en esta sesión." : GENERIC_ERROR);
    await logActivity({ actorId: actor.id, action: "folder.renamed", resourceType: "session", resourceId: folder.session_id, metadata: { name } });
    return ok("Carpeta renombrada.");
  });
}

export async function deleteSessionFolder(folderId: string): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireActor();
    const folder = await loadSessionFolder(actor, folderId);
    const admin = createAdminClient();
    const { data } = await admin.from("assets").select("id").eq("folder_id", folder.id).is("deleted_at", null).limit(1);
    if ((data?.length ?? 0) > 0) return fail("La carpeta no está vacía: mueve sus fotos antes de borrarla.");
    const { error } = await admin.from("folders").update({ deleted_at: new Date().toISOString() }).eq("id", folder.id);
    if (error) return fail(GENERIC_ERROR);
    await logActivity({ actorId: actor.id, action: "folder.deleted", resourceType: "session", resourceId: folder.session_id, metadata: { name: folder.name } });
    return ok("Carpeta borrada.");
  });
}

// ---------------------------------------------------------------------------
// Favoritas
// ---------------------------------------------------------------------------

/** Marca o desmarca una favorita PROPIA. Solo se puede marcar lo que se puede ver (can_access en la base de datos). */
export async function setFavorite(assetId: string, favorite: boolean): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireActor();
    if (!isUuid(assetId) || typeof favorite !== "boolean") return fail(GENERIC_ERROR);
    if (!(await can(actor.id, "view", { type: "asset", id: assetId }))) throw new ForbiddenError();
    const admin = createAdminClient();
    if (favorite) {
      const { error } = await admin.from("favorites").upsert({ user_id: actor.id, asset_id: assetId }, { onConflict: "user_id,asset_id", ignoreDuplicates: true });
      if (error) return fail(GENERIC_ERROR);
    } else {
      const { error } = await admin.from("favorites").delete().eq("user_id", actor.id).eq("asset_id", assetId);
      if (error) return fail(GENERIC_ERROR);
    }
    return ok();
  });
}

/** ids de las fotos de la sesión que la persona actual tiene marcadas. */
export async function listMyFavorites(sessionId: string): Promise<ActionResult<string[]>> {
  return runAction(async () => {
    const actor = await requireActor();
    if (!isUuid(sessionId)) return fail(GENERIC_ERROR);
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("session_favorites", { p_session: sessionId });
    if (error) return fail(GENERIC_ERROR);
    const mine = ((data ?? []) as { asset_id: string; user_id: string }[]).filter((r) => r.user_id === actor.id).map((r) => r.asset_id);
    return ok<string[]>(undefined, mine);
  });
}

/** Favoritas de TODA la sesión con quién las marcó. Solo quien puede editar o publicar en ella. */
export async function listSessionFavorites(sessionId: string): Promise<ActionResult<FavoriteEntry[]>> {
  return runAction(async () => {
    const actor = await requireActor();
    if (!isUuid(sessionId)) return fail(GENERIC_ERROR);
    const allowed =
      (await can(actor.id, "edit", { type: "session", id: sessionId })) || (await can(actor.id, "publish", { type: "session", id: sessionId }));
    if (!allowed) throw new ForbiddenError();

    const supabase = await createClient();
    const { data, error } = await supabase.rpc("session_favorites", { p_session: sessionId });
    if (error) return fail(GENERIC_ERROR);
    const rows = (data ?? []) as { asset_id: string; user_id: string; created_at: string }[];
    if (rows.length === 0) return ok<FavoriteEntry[]>(undefined, []);

    const admin = createAdminClient();
    const [{ data: assets }, { data: people }] = await Promise.all([
      admin.from("assets").select("id, title, original_filename").in("id", [...new Set(rows.map((r) => r.asset_id))]),
      admin.from("profiles").select("id, full_name, email").in("id", [...new Set(rows.map((r) => r.user_id))]),
    ]);
    const names = new Map(((people ?? []) as { id: string; full_name: string | null; email: string }[]).map((p) => [p.id, p.full_name || p.email]));
    const info = new Map(((assets ?? []) as { id: string; title: string | null; original_filename: string }[]).map((a) => [a.id, a]));
    const grouped = new Map<string, FavoriteEntry>();
    for (const row of rows) {
      const a = info.get(row.asset_id);
      if (!a) continue;
      const entry = grouped.get(row.asset_id) ?? { assetId: row.asset_id, title: a.title ?? a.original_filename, filename: a.original_filename, by: [] };
      entry.by.push({ name: names.get(row.user_id) ?? "Alguien", at: row.created_at });
      grouped.set(row.asset_id, entry);
    }
    return ok<FavoriteEntry[]>(undefined, [...grouped.values()].sort((x, y) => x.filename.localeCompare(y.filename, "es", { numeric: true })));
  });
}

// ---------------------------------------------------------------------------
// Fotos de la sesión (para la galería) y descargas
// ---------------------------------------------------------------------------

/** Recarga las fotos de la sesión (tras acciones en lote). `portal`: solo publicado o propio. */
export async function listSessionPhotos(input: { sessionId: string; portal?: boolean }): Promise<ActionResult<{ photos: SessionPhoto[]; truncated: boolean }>> {
  return runAction(async () => {
    const actor = await requireActor();
    if (!isUuid(input?.sessionId)) return fail(GENERIC_ERROR);
    const session = await loadSession(input.sessionId); // RLS: sin acceso → null
    if (!session) return fail("Sesión no disponible.");
    const result = await loadSessionPhotos(session.id, { portalFor: input.portal ? actor.id : undefined });
    return ok(undefined, result);
  });
}

export type DownloadPlan = {
  mode: DownloadMode;
  variant: AssetVariant;
  files: { id: string; name: string; size: number }[];
};

function webName(name: string): string {
  const dot = name.lastIndexOf(".");
  return `${dot > 0 ? name.slice(0, dot) : name}.webp`;
}

/**
 * Prepara una descarga (selección o sesión entera): comprueba el modo de descarga de la sesión para la
 * variante pedida y que CADA foto sea descargable y visible para quien la pide. Devuelve solo nombre y
 * tamaño; las URLs se piden después, una a una (getAssetUrl), justo antes de descargar cada archivo.
 */
export async function prepareSessionDownload(input: {
  sessionId: string;
  ids: string[] | null;
  variant: AssetVariant;
}): Promise<ActionResult<DownloadPlan>> {
  return runAction(async () => {
    const actor = await requireActor();
    if (!isUuid(input?.sessionId) || (input.variant !== "original" && input.variant !== "web")) return fail(GENERIC_ERROR);
    const session = await loadSession(input.sessionId);
    if (!session) return fail("Sesión no disponible.");
    if (!variantAllowed(session.downloadMode, input.variant)) return fail("Esta sesión no permite esa descarga.");
    if (!(await can(actor.id, "download", { type: "session", id: session.id }))) throw new ForbiddenError();

    const { photos } = await loadSessionPhotos(session.id, { portalFor: actor.id });
    const wanted = input.ids === null ? null : new Set(Array.isArray(input.ids) ? input.ids.filter((id) => isUuid(id)) : []);
    const candidates = photos.filter((p) => p.downloadable && (wanted === null || wanted.has(p.id)));
    if (candidates.length === 0) return fail("No hay fotos descargables en la selección.");

    // Cada foto se autoriza individualmente (can_access download); las que no pasan se omiten
    // (en tandas de 25 en paralelo: son hasta 500 comprobaciones y hacerlas una a una tardaría demasiado)
    const files: DownloadPlan["files"] = [];
    for (let i = 0; i < candidates.length; i += 25) {
      const batch = candidates.slice(i, i + 25);
      const allowed = await Promise.all(batch.map((photo) => can(actor.id, "download", { type: "asset", id: photo.id })));
      batch.forEach((photo, k) => {
        if (allowed[k]) files.push({ id: photo.id, name: input.variant === "web" ? webName(photo.filename) : photo.filename, size: photo.sizeBytes });
      });
    }
    if (files.length === 0) return fail("No hay fotos descargables en la selección.");
    return ok(undefined, { mode: session.downloadMode, variant: input.variant, files });
  });
}

/**
 * URLs de descarga de hasta 10 fotos de una vez (para el ZIP: evita una llamada por foto). CADA foto se autoriza
 * y se registra por separado, con las mismas reglas que getAssetUrl (modo de descarga, downloadable, can_access).
 */
export async function getDownloadUrls(ids: string[], variant: AssetVariant): Promise<ActionResult<Record<string, string>>> {
  return runAction(async () => {
    const actor = await requireActor();
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 10 || (variant !== "original" && variant !== "web")) return fail(GENERIC_ERROR);
    const unique = [...new Set(ids.filter((id) => isUuid(id)))];
    const results = await Promise.all(unique.map((id) => signAssetUrl(actor, id, variant, "download")));
    const out: Record<string, string> = {};
    results.forEach((r, i) => {
      if (r.ok && r.data) out[unique[i] as string] = r.data.url;
    });
    return ok(undefined, out);
  });
}

/** Deja constancia en activity_log de una descarga en ZIP (completa o cancelada). */
export async function logSessionZip(input: {
  sessionId: string;
  files: number;
  bytes: number;
  variant: AssetVariant;
  parts: number;
  completed: boolean;
}): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireActor();
    if (!isUuid(input?.sessionId)) return fail(GENERIC_ERROR);
    if (!(await can(actor.id, "download", { type: "session", id: input.sessionId }))) throw new ForbiddenError();
    const clamp = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(n, Number.MAX_SAFE_INTEGER)) : 0);
    await logActivity({
      actorId: actor.id,
      action: input.completed ? "session.zip_downloaded" : "session.zip_canceled",
      resourceType: "session",
      resourceId: input.sessionId,
      metadata: { files: clamp(input.files), bytes: clamp(input.bytes), variant: input.variant === "web" ? "web" : "original", parts: clamp(input.parts) },
    });
    return ok();
  });
}
