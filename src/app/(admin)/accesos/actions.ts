"use server";

import { revalidatePath } from "next/cache";
import { fail, GENERIC_ERROR, ok, type ActionResult } from "@/lib/action-result";
import { RESOURCE_TYPES, type ResourceType } from "@/lib/permissions/keys";
import { logActivity } from "@/lib/permissions/audit";
import { requirePermission, runAction } from "@/lib/permissions/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseUuid } from "@/lib/validation";
import {
  actorRole,
  ceilingError,
  checkRecipient,
  parseExpiry,
  parseFlags,
  resourceExists,
} from "@/lib/access/grants";

/**
 * Accesos por recurso (grants) y asignaciones a artistas. Todas las acciones empiezan con
 * requirePermission('access.manage'). Reglas:
 *  - Un grant elige DÓNDE; el rol del destinatario es el techo (lo impone can_access en la base de datos).
 *  - Anti-escalada: nadie concede un acceso que él mismo no tendría (p. ej. descargar si su rol no descarga,
 *    o nada del Vault si su rol no tiene permisos de vault).
 *  - No se concede a uno mismo ni al owner (acceso total, inmutable).
 */

export type GrantInput = {
  userId: string;
  resourceType: ResourceType;
  resourceId: string | null;
  canView: boolean;
  canDownload: boolean;
  canUpload: boolean;
  canEdit: boolean;
  /** Fecha (YYYY-MM-DD) hasta la que vale el acceso, o null si no caduca. */
  expiresOn: string | null;
};

// ---------------------------------------------------------------------------

export async function createGrant(raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requirePermission("access.manage");
    const my = await actorRole();

    if (!raw || typeof raw !== "object") return fail("Datos no válidos.");
    const input = raw as Record<string, unknown>;

    const userId = parseUuid(input.userId as string);
    const type = RESOURCE_TYPES.find((t) => t === input.resourceType);
    if (!userId || !type) return fail("Datos no válidos.");
    // El acceso al Vault tiene su propia concesión (caducidad obligatoria, registro y solo owner): nunca por aquí
    if (type === "vault") return fail("El acceso al Vault se concede desde «Dar acceso al Vault».");
    const resourceId = parseUuid(input.resourceId as string);
    if (!resourceId) return fail("Elige el recurso.");

    const flags = parseFlags(input);
    if (!Object.values(flags).some(Boolean)) return fail("Marca al menos un permiso.");
    const expiry = parseExpiry(input.expiresOn);
    if (!expiry.ok) return fail("La fecha de caducidad debe ser futura.");

    const ceiling = ceilingError(my, type, flags);
    if (ceiling) return fail(ceiling);
    const recipient = await checkRecipient(actor.id, userId);
    if (recipient) return fail(recipient);
    if (!(await resourceExists(type, resourceId))) return fail("Ese recurso no existe.");

    const { data: created, error } = await createAdminClient()
      .from("grants")
      .insert({
        user_id: userId,
        resource_type: type,
        resource_id: resourceId,
        can_view: flags.canView,
        can_download: flags.canDownload,
        can_upload: flags.canUpload,
        can_edit: flags.canEdit,
        expires_at: expiry.iso,
        created_by: actor.id,
      })
      .select("id")
      .single();
    if (error || !created) {
      return fail(
        error?.code === "23505"
          ? "Ya hay un acceso vigente para esa persona y ese recurso. Edítalo."
          : GENERIC_ERROR,
      );
    }

    await logActivity({
      actorId: actor.id,
      action: "grant.created",
      resourceType: type,
      resourceId,
      metadata: { grantId: created.id, userId, ...flags, expiresOn: expiry.iso },
    });
    revalidatePath("/accesos");
    return ok("Acceso concedido.");
  });
}

export async function updateGrant(grantIdRaw: string, raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requirePermission("access.manage");
    const my = await actorRole();

    const grantId = parseUuid(grantIdRaw);
    if (!grantId || !raw || typeof raw !== "object") return fail("Datos no válidos.");
    const input = raw as Record<string, unknown>;

    const flags = parseFlags(input);
    if (!Object.values(flags).some(Boolean)) return fail("Marca al menos un permiso.");
    const expiry = parseExpiry(input.expiresOn);
    if (!expiry.ok) return fail("La fecha de caducidad debe ser futura.");

    const admin = createAdminClient();
    const { data: grant } = await admin
      .from("grants")
      .select("id, resource_type, resource_id")
      .eq("id", grantId)
      .is("revoked_at", null)
      .maybeSingle();
    const current = grant as { id: string; resource_type: ResourceType; resource_id: string | null } | null;
    if (!current) return fail("Ese acceso ya no está vigente.");

    const ceiling = ceilingError(my, current.resource_type, flags);
    if (ceiling) return fail(ceiling);

    const { error } = await admin
      .from("grants")
      .update({
        can_view: flags.canView,
        can_download: flags.canDownload,
        can_upload: flags.canUpload,
        can_edit: flags.canEdit,
        expires_at: expiry.iso,
      })
      .eq("id", grantId)
      .is("revoked_at", null);
    if (error) return fail(GENERIC_ERROR);

    await logActivity({
      actorId: actor.id,
      action: "grant.updated",
      resourceType: current.resource_type,
      resourceId: current.resource_id,
      metadata: { grantId, ...flags, expiresOn: expiry.iso },
    });
    revalidatePath("/accesos");
    return ok("Acceso actualizado.");
  });
}

export async function revokeGrant(grantIdRaw: string): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requirePermission("access.manage");

    const grantId = parseUuid(grantIdRaw);
    if (!grantId) return fail(GENERIC_ERROR);

    const { data, error } = await createAdminClient()
      .from("grants")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", grantId)
      .is("revoked_at", null)
      .select("id, resource_type, resource_id");
    const row = (data as { id: string; resource_type: string; resource_id: string | null }[] | null)?.[0];
    if (error || !row) return fail("Ese acceso ya estaba revocado.");

    await logActivity({
      actorId: actor.id,
      action: "grant.revoked",
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      metadata: { grantId },
    });
    revalidatePath("/accesos");
    return ok("Acceso revocado.");
  });
}

// ---------------------------------------------------------------------------
// Asignaciones persona ↔ artista (para roles con alcance "solo artistas asignados")
// ---------------------------------------------------------------------------

export async function assignMember(artistIdRaw: string, userIdRaw: string): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requirePermission("access.manage");

    const artistId = parseUuid(artistIdRaw);
    const userId = parseUuid(userIdRaw);
    if (!artistId || !userId) return fail(GENERIC_ERROR);
    if (!(await resourceExists("artist", artistId))) return fail("Ese artista no existe.");
    // Nadie se asigna a sí mismo (sería una forma de ampliarse el alcance).
    const recipient = await checkRecipient(actor.id, userId);
    if (recipient) return fail(recipient);

    const { error } = await createAdminClient()
      .from("artist_members")
      .insert({ artist_id: artistId, user_id: userId });
    if (error) {
      return fail(error.code === "23505" ? "Esa persona ya está asignada." : GENERIC_ERROR);
    }

    await logActivity({
      actorId: actor.id,
      action: "artist.member_assigned",
      resourceType: "artist",
      resourceId: artistId,
      metadata: { userId },
    });
    revalidatePath("/accesos");
    return ok("Persona asignada.");
  });
}

export async function unassignMember(memberIdRaw: string): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requirePermission("access.manage");

    const memberId = parseUuid(memberIdRaw);
    if (!memberId) return fail(GENERIC_ERROR);

    const { data, error } = await createAdminClient()
      .from("artist_members")
      .delete()
      .eq("id", memberId)
      .select("artist_id, user_id");
    const row = (data as { artist_id: string; user_id: string }[] | null)?.[0];
    if (error || !row) return fail("Esa asignación ya no existe.");

    await logActivity({
      actorId: actor.id,
      action: "artist.member_removed",
      resourceType: "artist",
      resourceId: row.artist_id,
      metadata: { userId: row.user_id },
    });
    revalidatePath("/accesos");
    return ok("Asignación eliminada.");
  });
}
