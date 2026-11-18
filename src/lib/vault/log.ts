import "server-only";

import type { Actor } from "@/lib/auth/session";
import { ForbiddenError } from "@/lib/permissions/server";
import { createAdminClient } from "@/lib/supabase/admin";

import { VAULT_ACTIONS, type VaultAction } from "./labels";
export { VAULT_ACTIONS, type VaultAction };

/**
 * Registro OBLIGATORIO del Vault: se inserta ANTES de devolver cualquier URL firmada o listado. Si la inserción
 * falla, lanza ForbiddenError y la acción se deniega (fail-closed). Nunca se guardan claves de objeto, URLs
 * firmadas, contraseñas ni códigos: solo ids y datos no sensibles.
 */
export async function logVault(
  actor: Pick<Actor, "id">,
  action: VaultAction,
  resource: { type: "vault" | "asset" | "folder" | "grant"; id: string | null } = { type: "vault", id: null },
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    const { error } = await createAdminClient()
      .from("activity_log")
      .insert({ actor_id: actor.id, action, resource_type: resource.type, resource_id: resource.id, metadata });
    if (error) throw new ForbiddenError();
  } catch {
    throw new ForbiddenError();
  }
}

/** Para eventos que no deben bloquear (intentos fallidos de desbloqueo): se intenta registrar y se sigue. */
export async function logVaultBestEffort(
  actorId: string | null,
  action: VaultAction,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await createAdminClient().from("activity_log").insert({ actor_id: actorId, action, resource_type: "vault", resource_id: null, metadata });
  } catch {
    /* sin registro no hay acceso: este camino solo se usa cuando ya se ha denegado */
  }
}
