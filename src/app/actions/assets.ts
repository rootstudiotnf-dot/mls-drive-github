"use server";

import { after } from "next/server";
import { notifyPublished } from "@/lib/notifications/hooks";
import { revalidatePath } from "next/cache";
import { fail, GENERIC_ERROR, ok, type ActionResult } from "@/lib/action-result";
import { getActor, type Actor } from "@/lib/auth/session";
import { logActivity } from "@/lib/permissions/audit";
import {
  can,
  ForbiddenError,
  runAction,
} from "@/lib/permissions/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadAssetRow, moveAssetOp, requireEdit, trashAssetOp } from "@/lib/assets/ops";

/**
 * Ficha de archivo: editar, mover y enviar a la papelera.
 *
 * Cada acción: sesión activa + regla can_access de la Fase 2 (`edit`, y `publish` para cambiar la
 * visibilidad). Si no hay acceso se responde igual que si el archivo no existiera (no se revela nada).
 * Mover NO toca R2: la clave del objeto es opaca e inmutable; solo cambian filas de la base de datos.
 */

async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new ForbiddenError();
  return actor;
}

// ---------------------------------------------------------------------------

const TAG_RE = /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,29}$/u;

function parseTags(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > 10) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return null;
    const name = item.replace(/\s+/g, " ").trim().toLowerCase();
    if (!name) continue;
    if (!TAG_RE.test(name)) return null;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

async function replaceTags(assetId: string, names: string[]): Promise<void> {
  const admin = createAdminClient();
  await admin.from("taggings").delete().eq("resource_type", "asset").eq("resource_id", assetId);
  if (names.length === 0) return;

  const { data: existing } = await admin.from("tags").select("id, name").in("name", names);
  const have = new Map(((existing ?? []) as { id: string; name: string }[]).map((t) => [t.name, t.id]));
  const missing = names.filter((n) => !have.has(n));
  if (missing.length > 0) {
    const { data: created } = await admin.from("tags").insert(missing.map((name) => ({ name }))).select("id, name");
    for (const t of (created ?? []) as { id: string; name: string }[]) have.set(t.name, t.id);
  }
  const rows = names.flatMap((n) => {
    const id = have.get(n);
    return id ? [{ tag_id: id, resource_type: "asset", resource_id: assetId }] : [];
  });
  if (rows.length > 0) await admin.from("taggings").insert(rows);
}

export type UpdateAssetInput = {
  title?: string;
  tags?: string[];
  visibility?: "private" | "published";
  downloadable?: boolean;
};

export async function updateAsset(assetId: string, raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireActor();
    const asset = await loadAssetRow(assetId);
    await requireEdit(actor, asset);
    if (asset.status !== "ready") return fail("El archivo aún no está listo.");
    if (!raw || typeof raw !== "object") return fail("Datos no válidos.");
    const patch = raw as UpdateAssetInput;

    const update: Record<string, unknown> = {};
    const changed: string[] = [];

    if (patch.title !== undefined) {
      const title = String(patch.title).replace(/\s+/g, " ").trim();
      if (title.length < 1 || title.length > 120) return fail("El nombre debe tener entre 1 y 120 caracteres.");
      if (title !== (asset.title ?? "")) {
        update.title = title;
        changed.push("title");
      }
    }
    if (patch.downloadable !== undefined) {
      if (typeof patch.downloadable !== "boolean") return fail("Datos no válidos.");
      if (patch.downloadable !== asset.downloadable) {
        update.downloadable = patch.downloadable;
        changed.push("downloadable");
      }
    }
    let visibility: "private" | "published" | null = null;
    if (patch.visibility !== undefined) {
      if (patch.visibility !== "private" && patch.visibility !== "published") return fail("Datos no válidos.");
      if (patch.visibility !== asset.visibility) {
        // Publicar o retirar la publicación exige <área>.publish (can_access 'publish')
        if (!(await can(actor.id, "publish", { type: "asset", id: asset.id }))) throw new ForbiddenError();
        visibility = patch.visibility;
        changed.push("visibility");
      }
    }
    let tags: string[] | null = null;
    if (patch.tags !== undefined) {
      tags = parseTags(patch.tags);
      if (!tags) return fail("Las etiquetas no son válidas (máximo 10, hasta 30 caracteres).");
      changed.push("tags");
    }

    const admin = createAdminClient();
    if (Object.keys(update).length > 0) {
      const { error } = await admin.from("assets").update(update).eq("id", asset.id);
      if (error) return fail(GENERIC_ERROR);
    }
    if (visibility) {
      // Con autor: el trigger de publicación lo registra en activity_log
      const { error } = await admin.rpc("set_asset_visibility", {
        p_asset: asset.id,
        p_visibility: visibility,
        p_actor: actor.id,
      });
      if (error) return fail(GENERIC_ERROR);
      if (visibility === "published") after(() => void notifyPublished(actor, [asset.id]));
    }
    if (tags) await replaceTags(asset.id, tags);

    if (changed.length === 0) return ok("Sin cambios.");
    await logActivity({
      actorId: actor.id,
      action: "asset.updated",
      resourceType: "asset",
      resourceId: asset.id,
      metadata: { fields: changed },
    });
    revalidatePath(`/archivo/${asset.id}`);
    return ok("Cambios guardados.");
  });
}

// ---------------------------------------------------------------------------

export async function moveAsset(
  assetId: string,
  destination: { artistId: string | null; folderId: string | null },
): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireActor();
    const asset = await loadAssetRow(assetId);
    const result = await moveAssetOp(actor, asset, destination ?? { artistId: null, folderId: null });
    if (result.ok) revalidatePath(`/archivo/${asset.id}`);
    return result;
  });
}

// ---------------------------------------------------------------------------

export async function trashAsset(assetId: string): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireActor();
    const asset = await loadAssetRow(assetId);
    return trashAssetOp(actor, asset);
  });
}
