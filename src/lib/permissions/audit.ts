import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

export type ActivityEntry = {
  actorId: string;
  /** p. ej. "role.created", "grant.revoked" */
  action: string;
  resourceType?: string;
  resourceId?: string | null;
  /** Datos no sensibles del cambio (nunca contraseñas, tokens ni enlaces). */
  metadata?: Record<string, unknown>;
};

/**
 * Anota en activity_log (solo inserción; un trigger impide modificar o borrar).
 * Nunca rompe la acción que la llama: si falla, solo se registra el error.
 */
export async function logActivity(entry: ActivityEntry): Promise<void> {
  const { error } = await createAdminClient()
    .from("activity_log")
    .insert({
      actor_id: entry.actorId,
      action: entry.action,
      resource_type: entry.resourceType ?? null,
      resource_id: entry.resourceId ?? null,
      metadata: entry.metadata ?? {},
    });
  if (error) console.error("activity_log insert failed:", error.code ?? "");
}
