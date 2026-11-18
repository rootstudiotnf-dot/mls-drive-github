"use server";

import { revalidatePath } from "next/cache";
import { fail, GENERIC_ERROR, ok, type ActionResult } from "@/lib/action-result";
import { actorRole, ceilingError, parseExpiry } from "@/lib/access/grants";
import { getActor, type Actor } from "@/lib/auth/session";
import { logActivity } from "@/lib/permissions/audit";
import { can, ForbiddenError, requirePermission, runAction } from "@/lib/permissions/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/storage/keys";
import { performInvite } from "@/lib/users/invite";

/**
 * Artistas, carpetas y accesos del espacio de cada artista.
 *
 * - Crear, editar y archivar artistas exige `artists.manage`.
 * - Carpetas: exige poder EDITAR en el artista (regla can_access sobre el artista: rol + alcance).
 * - Los accesos reutilizan los grants de la Fase 2 y la invitación de la Fase 1. Una invitación desde aquí
 *   nunca concede más de lo que tiene quien invita (rol estrictamente menor + techo de permisos).
 * - Los slugs son solo de presentación: ninguna decisión de seguridad depende de ellos.
 */

async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new ForbiddenError();
  return actor;
}

async function requireArtistEdit(actor: Actor, artistId: unknown): Promise<string> {
  if (!isUuid(artistId)) throw new ForbiddenError();
  if (!(await can(actor.id, "edit", { type: "artist", id: artistId }))) throw new ForbiddenError();
  return artistId;
}

// ---------------------------------------------------------------------------
// Artistas
// ---------------------------------------------------------------------------

function slugify(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
  return slug || "artista";
}

function parseArtistFields(raw: unknown, requireName: boolean): { name?: string; bio?: string | null } | string {
  if (!raw || typeof raw !== "object") return "Datos no válidos.";
  const input = raw as Record<string, unknown>;
  const out: { name?: string; bio?: string | null } = {};
  if (input.name !== undefined || requireName) {
    const name = typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim() : "";
    if (name.length < 2 || name.length > 80) return "El nombre debe tener entre 2 y 80 caracteres.";
    out.name = name;
  }
  if (input.bio !== undefined) {
    const bio = typeof input.bio === "string" ? input.bio.trim() : "";
    if (bio.length > 600) return "La biografía admite 600 caracteres como máximo.";
    out.bio = bio === "" ? null : bio;
  }
  return out;
}

export async function createArtist(raw: unknown): Promise<ActionResult<{ id: string; slug: string }>> {
  return runAction(async () => {
    const actor = await requirePermission("artists.manage");
    const fields = parseArtistFields(raw, true);
    if (typeof fields === "string") return fail(fields);

    const admin = createAdminClient();
    const base = slugify(fields.name ?? "");
    for (let attempt = 1; attempt <= 20; attempt++) {
      const slug = attempt === 1 ? base : `${base}-${attempt}`.slice(0, 56);
      const { data, error } = await admin
        .from("artists")
        .insert({ name: fields.name, slug, bio: fields.bio ?? null, status: "active", created_by: actor.id })
        .select("id, slug")
        .single();
      if (error?.code === "23505") continue; // slug ocupado: se prueba el siguiente
      if (error || !data) return fail(GENERIC_ERROR);
      // El trigger de la base de datos crea las carpetas base (Fotos, Vídeos y Archivos).
      await logActivity({
        actorId: actor.id,
        action: "artist.created",
        resourceType: "artist",
        resourceId: data.id,
        metadata: { name: fields.name },
      });
      revalidatePath("/artistas");
      return ok<{ id: string; slug: string }>("Artista creado.", { id: data.id, slug: data.slug });
    }
    return fail("No se pudo generar una dirección única para ese nombre. Prueba con otro.");
  });
}

export async function updateArtist(artistId: string, raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requirePermission("artists.manage");
    if (!isUuid(artistId)) return fail(GENERIC_ERROR);
    const fields = parseArtistFields(raw, false);
    if (typeof fields === "string") return fail(fields);
    if (Object.keys(fields).length === 0) return ok("Sin cambios.");

    const { data, error } = await createAdminClient()
      .from("artists")
      .update(fields)
      .eq("id", artistId)
      .is("deleted_at", null)
      .select("slug");
    if (error || !data || data.length === 0) return fail("Ese artista no existe.");

    await logActivity({ actorId: actor.id, action: "artist.updated", resourceType: "artist", resourceId: artistId });
    revalidatePath("/artistas");
    revalidatePath(`/artistas/${(data[0] as { slug: string }).slug}`);
    return ok("Cambios guardados.");
  });
}

/** El avatar es un asset (foto lista) del propio artista; null lo quita. */
export async function setArtistAvatar(artistId: string, assetId: string | null): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requirePermission("artists.manage");
    if (!isUuid(artistId) || (assetId !== null && !isUuid(assetId))) return fail(GENERIC_ERROR);

    const admin = createAdminClient();
    if (assetId !== null) {
      const { data } = await admin
        .from("assets")
        .select("id")
        .eq("id", assetId)
        .eq("artist_id", artistId)
        .eq("kind", "photo")
        .eq("status", "ready")
        .eq("space", "workspace")
        .is("deleted_at", null)
        .maybeSingle();
      if (!data) return fail("Esa foto no es válida para este artista.");
    }
    const { data, error } = await admin
      .from("artists")
      .update({ avatar_asset_id: assetId })
      .eq("id", artistId)
      .is("deleted_at", null)
      .select("slug");
    if (error || !data || data.length === 0) return fail("Ese artista no existe.");

    await logActivity({ actorId: actor.id, action: "artist.avatar_changed", resourceType: "artist", resourceId: artistId });
    revalidatePath("/artistas");
    revalidatePath(`/artistas/${(data[0] as { slug: string }).slug}`);
    return ok(assetId ? "Avatar actualizado." : "Avatar quitado.");
  });
}

export async function archiveArtist(artistId: string, archived: boolean): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requirePermission("artists.manage");
    if (!isUuid(artistId) || typeof archived !== "boolean") return fail(GENERIC_ERROR);
    const { data, error } = await createAdminClient()
      .from("artists")
      .update({ status: archived ? "archived" : "active" })
      .eq("id", artistId)
      .is("deleted_at", null)
      .select("slug");
    if (error || !data || data.length === 0) return fail("Ese artista no existe.");

    await logActivity({
      actorId: actor.id,
      action: archived ? "artist.archived" : "artist.unarchived",
      resourceType: "artist",
      resourceId: artistId,
    });
    revalidatePath("/artistas");
    revalidatePath(`/artistas/${(data[0] as { slug: string }).slug}`);
    return ok(archived ? "Artista archivado." : "Artista reactivado.");
  });
}

// ---------------------------------------------------------------------------
// Carpetas (subcarpetas dentro de Fotos, Vídeos y Archivos)
// ---------------------------------------------------------------------------

type FolderRow = {
  id: string;
  artist_id: string;
  parent_id: string | null;
  name: string;
  kind: string;
  sort: number;
};

const FOLDER_COLUMNS = "id, artist_id, parent_id, name, kind, sort";
const MAX_FOLDER_DEPTH = 4;

function parseFolderName(value: unknown): string | null {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (name.length < 1 || name.length > 60) return null;
  if (/[\\/\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

async function loadFolder(folderId: unknown): Promise<FolderRow> {
  if (!isUuid(folderId)) throw new ForbiddenError();
  const { data } = await createAdminClient()
    .from("folders")
    .select(FOLDER_COLUMNS)
    .eq("id", folderId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) throw new ForbiddenError();
  return data as unknown as FolderRow;
}

async function folderDepth(folder: FolderRow): Promise<number> {
  const admin = createAdminClient();
  let depth = 1;
  let current: FolderRow = folder;
  while (current.parent_id && depth < 10) {
    const { data } = await admin.from("folders").select(FOLDER_COLUMNS).eq("id", current.parent_id).maybeSingle();
    if (!data) break;
    current = data as unknown as FolderRow;
    depth++;
  }
  return depth;
}

/** Crea una subcarpeta (hereda el tipo de la carpeta madre). Las de primer nivel las crea la base de datos. */
export async function createFolder(input: { parentId: string; name: string }): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const actor = await requireActor();
    const parent = await loadFolder(input?.parentId);
    await requireArtistEdit(actor, parent.artist_id);
    const name = parseFolderName(input.name);
    if (!name) return fail("El nombre de la carpeta debe tener entre 1 y 60 caracteres (sin barras).");
    if ((await folderDepth(parent)) >= MAX_FOLDER_DEPTH) return fail("Demasiados niveles de carpetas.");

    const admin = createAdminClient();
    const { data: siblings } = await admin
      .from("folders")
      .select("sort")
      .eq("parent_id", parent.id)
      .is("deleted_at", null)
      .order("sort", { ascending: false })
      .limit(1);
    const sort = ((siblings?.[0] as { sort: number } | undefined)?.sort ?? -1) + 1;

    const { data, error } = await admin
      .from("folders")
      .insert({ artist_id: parent.artist_id, parent_id: parent.id, name, kind: parent.kind, sort })
      .select("id")
      .single();
    if (error?.code === "23505") return fail("Ya hay una carpeta con ese nombre en este nivel.");
    if (error || !data) return fail(GENERIC_ERROR);

    await logActivity({
      actorId: actor.id,
      action: "folder.created",
      resourceType: "artist",
      resourceId: parent.artist_id,
      metadata: { name },
    });
    return ok<{ id: string }>("Carpeta creada.", { id: data.id });
  });
}

export async function renameFolder(folderId: string, rawName: string): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireActor();
    const folder = await loadFolder(folderId);
    await requireArtistEdit(actor, folder.artist_id);
    if (!folder.parent_id) return fail("Las carpetas base (Fotos, Vídeos y Archivos) no se renombran.");
    const name = parseFolderName(rawName);
    if (!name) return fail("El nombre de la carpeta debe tener entre 1 y 60 caracteres (sin barras).");

    const { error } = await createAdminClient().from("folders").update({ name }).eq("id", folder.id);
    if (error?.code === "23505") return fail("Ya hay una carpeta con ese nombre en este nivel.");
    if (error) return fail(GENERIC_ERROR);

    await logActivity({
      actorId: actor.id,
      action: "folder.renamed",
      resourceType: "artist",
      resourceId: folder.artist_id,
      metadata: { from: folder.name, to: name },
    });
    return ok("Carpeta renombrada.");
  });
}

/** Sube o baja una carpeta entre sus hermanas (intercambia el orden). */
export async function reorderFolder(folderId: string, direction: "up" | "down"): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireActor();
    const folder = await loadFolder(folderId);
    await requireArtistEdit(actor, folder.artist_id);
    if (direction !== "up" && direction !== "down") return fail(GENERIC_ERROR);

    const admin = createAdminClient();
    let query = admin
      .from("folders")
      .select(FOLDER_COLUMNS)
      .eq("artist_id", folder.artist_id)
      .is("deleted_at", null)
      .order("sort", { ascending: true })
      .order("name", { ascending: true });
    query = folder.parent_id ? query.eq("parent_id", folder.parent_id) : query.is("parent_id", null);
    const { data } = await query;
    const siblings = (data ?? []) as unknown as FolderRow[];
    const index = siblings.findIndex((f) => f.id === folder.id);
    const swapWith = siblings[direction === "up" ? index - 1 : index + 1];
    if (index < 0 || !swapWith) return ok("Ya está en el extremo.");

    // Se renumera todo el nivel (evita empates) intercambiando las dos posiciones
    const order = siblings.map((f) => f.id);
    [order[index], order[direction === "up" ? index - 1 : index + 1]] = [swapWith.id, folder.id];
    for (let i = 0; i < order.length; i++) {
      await admin.from("folders").update({ sort: i }).eq("id", order[i] as string);
    }
    return ok("Orden actualizado.");
  });
}

/** Solo se borra una carpeta VACÍA (sin elementos ni subcarpetas): primero hay que mover su contenido. */
export async function deleteFolder(folderId: string): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireActor();
    const folder = await loadFolder(folderId);
    await requireArtistEdit(actor, folder.artist_id);
    if (!folder.parent_id) return fail("Las carpetas base (Fotos, Vídeos y Archivos) no se pueden borrar.");

    const admin = createAdminClient();
    const [children, items] = await Promise.all([
      admin.from("folders").select("id").eq("parent_id", folder.id).is("deleted_at", null).limit(1),
      admin.from("assets").select("id").eq("folder_id", folder.id).is("deleted_at", null).limit(1),
    ]);
    if ((children.data?.length ?? 0) > 0 || (items.data?.length ?? 0) > 0) {
      return fail("La carpeta no está vacía: mueve sus elementos y subcarpetas antes de borrarla.");
    }
    const { error } = await admin
      .from("folders")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", folder.id);
    if (error) return fail(GENERIC_ERROR);

    await logActivity({
      actorId: actor.id,
      action: "folder.deleted",
      resourceType: "artist",
      resourceId: folder.artist_id,
      metadata: { name: folder.name },
    });
    return ok("Carpeta borrada.");
  });
}

// ---------------------------------------------------------------------------
// Invitar a alguien al espacio de un artista
// ---------------------------------------------------------------------------

export type InviteToArtistInput = {
  artistId: string;
  email: string;
  roleKey: string;
  canDownload: boolean;
  canUpload: boolean;
  expiresOn: string | null;
};

/**
 * Crea la invitación (Fase 1) y un acceso (grant) sobre el artista con los permisos elegidos y la
 * caducidad. El acceso nace ligado a la cuenta invitada y solo vale cuando acepte (su perfil sigue
 * desactivado hasta entonces). Se necesitan `users.invite` y `access.manage`; el rol debe ser
 * estrictamente menor que el del que invita y los permisos no pueden superar los de su propio rol.
 */
export async function inviteToArtist(raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requirePermission("users.invite");
    await requirePermission("access.manage");
    const my = await actorRole();

    if (!raw || typeof raw !== "object") return fail("Datos no válidos.");
    const input = raw as Partial<InviteToArtistInput>;
    if (!isUuid(input.artistId)) return fail("Artista no válido.");
    const flags = {
      canView: true,
      canDownload: input.canDownload === true,
      canUpload: input.canUpload === true,
      canEdit: false,
    };
    const expiry = parseExpiry(input.expiresOn);
    if (!expiry.ok) return fail("La fecha de caducidad debe ser futura.");
    const ceiling = ceilingError(my, "artist", flags);
    if (ceiling) return fail(ceiling);

    const admin = createAdminClient();
    const { data: artist } = await admin
      .from("artists")
      .select("id, slug")
      .eq("id", input.artistId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!artist) return fail("Ese artista no existe.");

    const invited = await performInvite(actor, input.email, input.roleKey);
    if (!invited.ok) return fail(invited.message);
    if (!invited.userId) {
      return fail("Invitación enviada, pero no se pudo asignar el acceso. Asígnalo desde «Asignar persona».");
    }

    const { error } = await admin.from("grants").insert({
      user_id: invited.userId,
      resource_type: "artist",
      resource_id: artist.id,
      can_view: true,
      can_download: flags.canDownload,
      can_upload: flags.canUpload,
      can_edit: false,
      expires_at: expiry.iso,
      created_by: actor.id,
    });
    if (error) return fail("Invitación enviada, pero no se pudo asignar el acceso. Asígnalo desde «Asignar persona».");

    await logActivity({
      actorId: actor.id,
      action: "grant.created",
      resourceType: "artist",
      resourceId: artist.id,
      metadata: { email: invited.email, ...flags, expiresOn: expiry.iso },
    });
    revalidatePath(`/artistas/${(artist as { slug: string }).slug}`);
    revalidatePath("/accesos");
    return ok(`Invitación enviada a ${invited.email}. Tendrá acceso cuando la acepte.`);
  });
}
