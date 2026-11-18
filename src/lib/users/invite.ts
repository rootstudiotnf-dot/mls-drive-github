import "server-only";

import { fail, GENERIC_ERROR } from "@/lib/action-result";
import type { Actor } from "@/lib/auth/session";
import { getSiteUrl } from "@/lib/env";
import { logActivity } from "@/lib/permissions/audit";
import { isStrictlyBelow } from "@/lib/permissions/power";
import { ForbiddenError, getEffectiveRole, loadRoleDef } from "@/lib/permissions/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseEmail, parseRoleKey } from "@/lib/validation";

/**
 * Invitación de una persona (la usa /usuarios y el panel de accesos de cada artista).
 * El que llama YA debe haber comprobado requirePermission('users.invite').
 *
 * Reglas: solo se invita con roles estrictamente menos poderosos que el del que invita; un correo con
 * cuenta o invitación vigente se rechaza; la invitación se registra en activity_log.
 */

export function inviteRedirect(): string {
  return `${getSiteUrl()}/auth/callback?next=/invitacion`;
}

export type InviteResult =
  | { ok: true; email: string; invitationId: string; userId: string | null }
  | { ok: false; message: string };

export async function performInvite(actor: Actor, rawEmail: unknown, rawRole: unknown): Promise<InviteResult> {
  const mine = await getEffectiveRole();
  if (!mine) throw new ForbiddenError();

  const email = parseEmail(rawEmail as string);
  if (!email) return fail("Escribe un correo válido.");
  const roleKey = parseRoleKey(rawRole as string);
  if (!roleKey) return fail("Elige un rol.");

  const admin = createAdminClient();
  const { data: role } = await admin.from("roles").select("id").eq("key", roleKey).maybeSingle();
  if (!role) return fail("Ese rol no existe.");
  const target = await loadRoleDef(role.id);
  if (!target || !isStrictlyBelow(mine, target)) return fail("No puedes invitar con ese rol.");

  const { data: existing } = await admin.from("profiles").select("id").eq("email", email).limit(1);
  if (existing && existing.length > 0) return fail("Ya existe una cuenta con ese correo.");

  const { data: invitation, error: insertError } = await admin
    .from("invitations")
    .insert({ email, role_id: role.id, invited_by: actor.id })
    .select("id")
    .single();
  if (insertError || !invitation) {
    return fail(
      insertError?.code === "23505" ? "Ya hay una invitación pendiente para ese correo." : GENERIC_ERROR,
    );
  }

  const { error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: inviteRedirect(),
  });
  if (inviteError) {
    await admin.from("invitations").delete().eq("id", invitation.id);
    console.error("inviteUserByEmail failed:", inviteError.status ?? "", inviteError.code ?? "");
    return fail("No se pudo enviar el correo de invitación. Inténtalo de nuevo en unos minutos.");
  }

  // El perfil (aún sin aceptar) nace con la invitación: sirve para asociarle accesos desde ya.
  const { data: profile } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();

  await logActivity({
    actorId: actor.id,
    action: "user.invited",
    resourceType: "invitation",
    resourceId: invitation.id,
    metadata: { email, role: roleKey },
  });
  return { ok: true, email, invitationId: invitation.id, userId: profile?.id ?? null };
}
