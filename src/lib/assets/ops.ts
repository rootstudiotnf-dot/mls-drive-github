import "server-only";

import { fail, GENERIC_ERROR, ok, type ActionResult } from "@/lib/action-result";
import type { Actor } from "@/lib/auth/session";
import { logActivity } from "@/lib/permissions/audit";
import { can, ForbiddenError, getEffectiveRole, userHasPermission } from "@/lib/permissions/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/storage/keys";
import { deleteObject } from "@/lib/storage/multipart";
import { AREA_OF_CLASS, type UploadClass } from "@/lib/storage/validate";

/**
 * Operaciones sobre assets compartidas por la ficha, las acciones en lote y la papelera.
 * Cada una recibe el actor ya autenticado y comprueba SIEMPRE el permiso (regla can_access de la Fase 2
 * o, en la papelera —donde can_access no aplica porque el recurso está borrado—, el permiso del rol +
 * alcance sobre el artista). Si no hay acceso, ForbiddenError (el llamador responde como si no existiera).
 *
 * Mover NO toca R2: la clave del objeto es opaca e inmutable; solo cambian filas de la base de datos.
 */

export type AssetRow = {
  id: string;
  kind: UploadClass;
  space: "workspace" | "vault";
  artist_id: string | null;
  folder_id: string | null;
  session_id: string | null;
  status: string;
  visibility: "private" | "published";
  downloadable: boolean;
  title: string | null;
  deleted_at: string | null;
};

const COLUMNS =
  "id, kind, space, artist_id, folder_id, session_id, status, visibility, downloadable, title, deleted_at";

export async function loadAssetRow(assetId: unknown, includeDeleted = false): Promise<AssetRow> {
  if (!isUuid(assetId)) throw new ForbiddenError();
  let query = createAdminClient().from("assets").select(COLUMNS).eq("id", assetId);
  if (!includeDeleted) query = query.is("deleted_at", null);
  const { data } = await query.maybeSingle();
  if (!data) throw new ForbiddenError();
  // El Vault solo se toca desde sus propias acciones (desbloqueo, registro y bucket propios)
  if ((data as { space?: string }).space === "vault") throw new ForbiddenError();
  return data as unknown as AssetRow;
}

/** Permiso de edición sobre el asset (can_access completo: rol, alcance, visibilidad, Vault…). */
export async function requireEdit(actor: Actor, asset: AssetRow): Promise<void> {
  if (!(await can(actor.id, "edit", { type: "asset", id: asset.id }))) throw new ForbiddenError();
}

const FOLDER_KIND_FOR: Record<UploadClass, string> = {
  photo: "photos",
  video: "videos",
  audio: "files",
  document: "files",
};

// ---------------------------------------------------------------------------
// Publicar / despublicar
// ---------------------------------------------------------------------------

/** Exige `<área>.publish` (can_access 'publish') y deja al autor en activity_log (trigger). */
export async function setVisibilityOp(
  actor: Actor,
  asset: AssetRow,
  visibility: "private" | "published",
): Promise<ActionResult> {
  if (asset.status !== "ready") return fail("El archivo aún no está listo.");
  if (asset.visibility === visibility) return ok();
  if (!(await can(actor.id, "publish", { type: "asset", id: asset.id }))) throw new ForbiddenError();
  // Fase 6: un vídeo no se publica hasta que su procesado está listo (la base de datos lo exige también)
  if (visibility === "published" && asset.kind === "video") {
    const { data: ready } = await createAdminClient().from("media_jobs").select("id").eq("asset_id", asset.id).eq("status", "ready").limit(1);
    if ((ready?.length ?? 0) === 0) return fail("El vídeo aún no está procesado: no se puede publicar.");
  }
  const { error } = await createAdminClient().rpc("set_asset_visibility", {
    p_asset: asset.id,
    p_visibility: visibility,
    p_actor: actor.id,
  });
  return error ? fail(GENERIC_ERROR) : ok();
}

// ---------------------------------------------------------------------------
// Mover (carpeta y/o artista)
// ---------------------------------------------------------------------------

export async function moveAssetOp(
  actor: Actor,
  asset: AssetRow,
  destination: { artistId: string | null; folderId: string | null },
): Promise<ActionResult> {
  await requireEdit(actor, asset); // permiso de editar en el ORIGEN
  if (asset.status !== "ready") return fail("El archivo aún no está listo.");
  if (asset.space === "vault") return fail("Los archivos del Vault no se mueven.");

  const artistId = destination.artistId ?? null;
  const folderId = destination.folderId ?? null;
  if (artistId !== null && !isUuid(artistId)) return fail("Artista no válido.");
  if (folderId !== null && !isUuid(folderId)) return fail("Carpeta no válida.");

  // Permiso de editar en el DESTINO: el rol edita ese tipo de contenido y tiene alcance sobre el artista
  const area = AREA_OF_CLASS[asset.kind];
  if (!(await userHasPermission(actor.id, `${area}.edit`))) throw new ForbiddenError();
  const admin = createAdminClient();
  if (artistId === null) {
    if (asset.kind !== "audio" || folderId !== null) return fail("Elige un artista de destino.");
    const role = await getEffectiveRole();
    if (!role || role.scope !== "all") throw new ForbiddenError();
  } else {
    let allowed = await can(actor.id, "edit", { type: "artist", id: artistId });
    if (!allowed && folderId) allowed = await can(actor.id, "edit", { type: "folder", id: folderId });
    if (!allowed) throw new ForbiddenError();
  }

  if (folderId !== null) {
    const { data: folder } = await admin
      .from("folders")
      .select("id, artist_id, kind")
      .eq("id", folderId)
      .is("deleted_at", null)
      .maybeSingle();
    const f = folder as { id: string; artist_id: string; kind: string } | null;
    if (!f || f.artist_id !== artistId) return fail("Esa carpeta no pertenece al artista elegido.");
    if (f.kind !== "general" && f.kind !== FOLDER_KIND_FOR[asset.kind]) {
      return fail("Esa carpeta es de otro tipo de contenido.");
    }
  }

  const artistChanged = artistId !== asset.artist_id;
  const { error } = await admin
    .from("assets")
    .update({
      artist_id: artistId,
      folder_id: folderId,
      // Una sesión pertenece a un artista: al cambiar de artista el archivo sale de ella
      ...(artistChanged ? { session_id: null } : {}),
    })
    .eq("id", asset.id);
  if (error) return fail(GENERIC_ERROR);

  await logActivity({
    actorId: actor.id,
    action: "asset.moved",
    resourceType: "asset",
    resourceId: asset.id,
    metadata: { fromArtist: asset.artist_id, toArtist: artistId, folderId },
  });
  return ok("Archivo movido.");
}

// ---------------------------------------------------------------------------
// Papelera
// ---------------------------------------------------------------------------

export async function trashAssetOp(actor: Actor, asset: AssetRow): Promise<ActionResult> {
  await requireEdit(actor, asset);
  if (asset.status !== "ready") return fail("Cancela la subida en lugar de enviarla a la papelera.");
  const { error } = await createAdminClient()
    .from("assets")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", asset.id)
    .is("deleted_at", null);
  if (error) return fail(GENERIC_ERROR);
  await logActivity({ actorId: actor.id, action: "asset.trashed", resourceType: "asset", resourceId: asset.id });
  return ok("Enviado a la papelera.");
}

/**
 * En la papelera `can_access` deniega (el recurso está borrado), así que se comprueba aparte:
 * el rol tiene `<área>.<acción>` y el alcance sobre el artista del archivo (container check de can_access).
 */
export async function requireTrashAccess(
  actor: Actor,
  asset: AssetRow,
  action: "edit" | "delete",
): Promise<void> {
  if (asset.space === "vault") throw new ForbiddenError();
  const area = AREA_OF_CLASS[asset.kind];
  if (!(await userHasPermission(actor.id, `${area}.${action}`))) throw new ForbiddenError();
  if (asset.artist_id) {
    if (!(await can(actor.id, action, { type: "artist", id: asset.artist_id }))) throw new ForbiddenError();
  } else {
    const role = await getEffectiveRole();
    if (!role || role.scope !== "all") throw new ForbiddenError();
  }
}

export async function restoreAssetOp(actor: Actor, assetId: unknown): Promise<ActionResult> {
  const asset = await loadAssetRow(assetId, true);
  if (!asset.deleted_at) return fail("Ese archivo no está en la papelera.");
  await requireTrashAccess(actor, asset, "edit");

  const admin = createAdminClient();
  // Si su carpeta se borró mientras tanto, vuelve a la raíz del artista
  let folderId = asset.folder_id;
  if (folderId) {
    const { data: folder } = await admin
      .from("folders")
      .select("id")
      .eq("id", folderId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!folder) folderId = null;
  }
  const { error } = await admin.from("assets").update({ deleted_at: null, folder_id: folderId }).eq("id", asset.id);
  if (error) return fail(GENERIC_ERROR);
  await logActivity({ actorId: actor.id, action: "asset.restored", resourceType: "asset", resourceId: asset.id });
  return ok("Restaurado.");
}

/** Borrado DEFINITIVO: objetos de R2 y filas. Exige `<área>.delete` (además del alcance). */
export async function purgeAssetOp(actor: Actor, assetId: unknown): Promise<ActionResult> {
  const asset = await loadAssetRow(assetId, true);
  if (!asset.deleted_at) return fail("Solo se pueden eliminar definitivamente los archivos de la papelera.");
  await requireTrashAccess(actor, asset, "delete");

  const admin = createAdminClient();
  const [{ data: row }, { data: derivatives }] = await Promise.all([
    admin.from("assets").select("storage_key").eq("id", asset.id).maybeSingle(),
    admin.from("asset_derivatives").select("storage_key").eq("asset_id", asset.id),
  ]);
  const keys = [
    ...(row ? [(row as { storage_key: string }).storage_key] : []),
    ...((derivatives ?? []) as { storage_key: string }[]).map((d) => d.storage_key),
  ];

  // Primero las filas (si un beat usa el archivo, no se borra nada), después los objetos
  const { error } = await admin.from("assets").delete().eq("id", asset.id);
  if (error) {
    return fail(error.code === "23503" ? "Un beat usa este archivo: no se puede eliminar." : GENERIC_ERROR);
  }
  await admin.from("taggings").delete().eq("resource_type", "asset").eq("resource_id", asset.id);
  await admin.from("grants").delete().eq("resource_type", "asset").eq("resource_id", asset.id);
  for (const key of keys) {
    await deleteObject(key).catch(() => console.error("purge: no se pudo borrar un objeto de R2"));
  }

  await logActivity({ actorId: actor.id, action: "asset.purged", resourceType: "asset", resourceId: asset.id });
  return ok("Eliminado definitivamente.");
}

// ---------------------------------------------------------------------------
// Mover a una sesión (y, opcionalmente, a una de sus carpetas)
// ---------------------------------------------------------------------------

/**
 * Mueve una foto a otra sesión (o a una carpeta de su misma sesión). Exige editar en el ORIGEN y en el
 * DESTINO (la sesión). Si la sesión es de otro artista, el archivo pasa a ese artista. `sessionId` null saca
 * la foto de la sesión (queda en la raíz del artista). Solo cambian filas: la clave de R2 no se toca.
 */
export async function moveToSessionOp(
  actor: Actor,
  asset: AssetRow,
  destination: { sessionId: string | null; folderId: string | null },
): Promise<ActionResult> {
  await requireEdit(actor, asset);
  if (asset.status !== "ready") return fail("El archivo aún no está listo.");
  if (asset.space === "vault" || asset.kind !== "photo") return fail("Solo se pueden mover fotos entre sesiones.");

  const sessionId = destination.sessionId ?? null;
  const folderId = destination.folderId ?? null;
  if (sessionId !== null && !isUuid(sessionId)) return fail("Sesión no válida.");
  if (folderId !== null && !isUuid(folderId)) return fail("Carpeta no válida.");
  const admin = createAdminClient();

  let artistId = asset.artist_id;
  if (sessionId !== null) {
    const { data } = await admin.from("sessions").select("id, artist_id").eq("id", sessionId).is("deleted_at", null).maybeSingle();
    const session = data as { id: string; artist_id: string } | null;
    if (!session) throw new ForbiddenError();
    if (!(await can(actor.id, "edit", { type: "session", id: session.id }))) throw new ForbiddenError(); // DESTINO
    if (!(await userHasPermission(actor.id, "photos.edit"))) throw new ForbiddenError();
    artistId = session.artist_id;
  } else if (folderId !== null) {
    return fail("Una carpeta de sesión exige elegir la sesión.");
  }

  if (folderId !== null) {
    const { data: folder } = await admin
      .from("folders")
      .select("id, artist_id, session_id, kind")
      .eq("id", folderId)
      .is("deleted_at", null)
      .maybeSingle();
    const f = folder as { id: string; artist_id: string; session_id: string | null; kind: string } | null;
    if (!f || f.session_id !== sessionId) return fail("Esa carpeta no es de la sesión elegida.");
  }

  const { error } = await admin
    .from("assets")
    .update({ session_id: sessionId, folder_id: folderId, artist_id: artistId, sort_index: null })
    .eq("id", asset.id);
  if (error) return fail(GENERIC_ERROR);

  await logActivity({
    actorId: actor.id,
    action: "asset.moved",
    resourceType: "asset",
    resourceId: asset.id,
    metadata: { fromSession: asset.session_id, toSession: sessionId, folderId },
  });
  return ok("Foto movida.");
}
