"use server";

import { revalidatePath } from "next/cache";
import { fail, GENERIC_ERROR, NOT_ALLOWED, ok, type ActionResult } from "@/lib/action-result";
import { isStrictlyBelow, type RoleDef } from "@/lib/permissions/power";
import { logActivity } from "@/lib/permissions/audit";
import {
  ForbiddenError,
  getEffectiveRole,
  loadRoleDef,
  requirePermission,
  runAction,
} from "@/lib/permissions/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseRoleKey, parseUuid } from "@/lib/validation";
import { inviteRedirect, performInvite } from "@/lib/users/invite";

/**
 * Acciones de gestión de usuarios. CADA acción:
 *  1) requirePermission('users.invite' | 'users.manage')  → sesión activa + permiso del rol (403 si no)
 *  2) comprueba el rango: solo se gestionan roles ESTRICTAMENTE menos poderosos que el del actor
 *  3) solo entonces escribe, con el service role (los clientes no tienen permiso de escritura)
 * Nunca se registran tokens, contraseñas ni enlaces.
 */

export type { ActionResult };

const BAN_FOREVER = "876000h"; // ~100 años

async function actorRole(): Promise<RoleDef> {
  const role = await getEffectiveRole();
  if (!role) throw new ForbiddenError();
  return role;
}

/** ¿Puede el rol del actor gestionar a alguien con el rol `targetRoleId`? */
async function mayManage(actor: RoleDef, targetRoleId: string): Promise<boolean> {
  const target = await loadRoleDef(targetRoleId);
  return !!target && isStrictlyBelow(actor, target);
}

type TargetProfile = {
  id: string;
  email: string;
  status: "active" | "disabled";
  role_id: string;
  roles: { key: string } | null;
};

async function loadProfile(userId: string): Promise<TargetProfile | null> {
  const { data } = await createAdminClient()
    .from("profiles")
    .select("id, email, status, role_id, roles(key)")
    .eq("id", userId)
    .maybeSingle();
  return (data as unknown as TargetProfile | null) ?? null;
}

async function hasPendingInvitation(email: string): Promise<boolean> {
  const { data } = await createAdminClient()
    .from("invitations")
    .select("id")
    .eq("email", email)
    .eq("status", "pending")
    .limit(1);
  return (data?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------

export async function inviteUser(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requirePermission("users.invite");
    const result = await performInvite(actor, formData.get("email"), formData.get("role"));
    if (!result.ok) return fail(result.message);
    revalidatePath("/usuarios");
    return ok(`Invitación enviada a ${result.email}.`);
  });
}

// ---------------------------------------------------------------------------

type PendingInvitationRow = {
  id: string;
  email: string;
  status: string;
  role_id: string;
};

async function loadPendingInvitation(invitationId: string): Promise<PendingInvitationRow | null> {
  const { data } = await createAdminClient()
    .from("invitations")
    .select("id, email, status, role_id")
    .eq("id", invitationId)
    .eq("status", "pending")
    .maybeSingle();
  return (data as unknown as PendingInvitationRow | null) ?? null;
}

/** Id del usuario de Auth que aún no ha aceptado (perfil 'disabled'), si existe. */
async function unacceptedUserId(email: string): Promise<string | null> {
  const { data } = await createAdminClient()
    .from("profiles")
    .select("id")
    .eq("email", email)
    .eq("status", "disabled")
    .maybeSingle();
  return data?.id ?? null;
}

export async function resendInvitation(invitationIdRaw: string): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requirePermission("users.invite");
    const mine = await actorRole();

    const invitationId = parseUuid(invitationIdRaw);
    if (!invitationId) return fail(GENERIC_ERROR);

    const invitation = await loadPendingInvitation(invitationId);
    if (!invitation) return fail("Esa invitación ya no está pendiente.");
    if (!(await mayManage(mine, invitation.role_id))) return fail(NOT_ALLOWED);

    const admin = createAdminClient();

    // Nueva caducidad de 7 días (antes de recrear el usuario: el trigger exige invitación vigente).
    const { error: renewError } = await admin
      .from("invitations")
      .update({ expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() })
      .eq("id", invitation.id)
      .eq("status", "pending");
    if (renewError) return fail(GENERIC_ERROR);

    // Se recrea el usuario de Auth (aún sin aceptar) para emitir un enlace nuevo y anular el anterior.
    const staleUserId = await unacceptedUserId(invitation.email);
    if (staleUserId) {
      const { error } = await admin.auth.admin.deleteUser(staleUserId);
      if (error) return fail(GENERIC_ERROR);
    }

    const { error: inviteError } = await admin.auth.admin.inviteUserByEmail(invitation.email, {
      redirectTo: inviteRedirect(),
    });
    if (inviteError) {
      console.error("resend inviteUserByEmail failed:", inviteError.status ?? "", inviteError.code ?? "");
      return fail("No se pudo reenviar el correo. Inténtalo de nuevo en unos minutos.");
    }

    await logActivity({
      actorId: actor.id,
      action: "invitation.resent",
      resourceType: "invitation",
      resourceId: invitation.id,
      metadata: { email: invitation.email },
    });
    revalidatePath("/usuarios");
    return ok(`Invitación reenviada a ${invitation.email}.`);
  });
}

export async function revokeInvitation(invitationIdRaw: string): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requirePermission("users.invite");
    const mine = await actorRole();

    const invitationId = parseUuid(invitationIdRaw);
    if (!invitationId) return fail(GENERIC_ERROR);

    const invitation = await loadPendingInvitation(invitationId);
    if (!invitation) return fail("Esa invitación ya no está pendiente.");
    if (!(await mayManage(mine, invitation.role_id))) return fail(NOT_ALLOWED);

    const admin = createAdminClient();

    // 1) Se revoca (atómico: solo si sigue pendiente). Desde aquí no puede aceptarse.
    const { data: revoked, error } = await admin
      .from("invitations")
      .update({ status: "revoked" })
      .eq("id", invitation.id)
      .eq("status", "pending")
      .select("id");
    if (error || !revoked || revoked.length !== 1) return fail("Esa invitación ya no está pendiente.");

    // 2) Se elimina el usuario de Auth que nunca llegó a aceptar (cierra cualquier enlace o sesión).
    const staleUserId = await unacceptedUserId(invitation.email);
    if (staleUserId) {
      const { error: deleteError } = await admin.auth.admin.deleteUser(staleUserId);
      if (deleteError) {
        console.error("revoke deleteUser failed:", deleteError.status ?? "", deleteError.code ?? "");
        return fail("La invitación se revocó, pero no se pudo limpiar la cuenta. Avisa al administrador.");
      }
    }

    await logActivity({
      actorId: actor.id,
      action: "invitation.revoked",
      resourceType: "invitation",
      resourceId: invitation.id,
      metadata: { email: invitation.email },
    });
    revalidatePath("/usuarios");
    return ok("Invitación revocada.");
  });
}

// ---------------------------------------------------------------------------

export async function setUserStatus(
  userIdRaw: string,
  next: "active" | "disabled",
): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requirePermission("users.manage");
    const mine = await actorRole();

    const userId = parseUuid(userIdRaw);
    if (!userId || (next !== "active" && next !== "disabled")) return fail(GENERIC_ERROR);
    if (userId === actor.id) return fail("No puedes cambiar el estado de tu propia cuenta.");

    const target = await loadProfile(userId);
    if (!target) return fail("Ese usuario no existe.");
    if (!(await mayManage(mine, target.role_id))) return fail(NOT_ALLOWED);

    const admin = createAdminClient();

    if (next === "disabled") {
      if (target.status !== "active") return fail("Ese usuario ya está desactivado.");

      // Primero la puerta de acceso (perfil), luego se bloquean los inicios de sesión y renovaciones.
      const { error } = await admin.from("profiles").update({ status: "disabled" }).eq("id", userId);
      if (error) return fail(GENERIC_ERROR);

      const { error: banError } = await admin.auth.admin.updateUserById(userId, {
        ban_duration: BAN_FOREVER,
      });
      if (banError) {
        console.error("ban failed:", banError.status ?? "", banError.code ?? "");
        return fail("El usuario queda sin acceso, pero no se pudo bloquear su inicio de sesión.");
      }
    } else {
      if (target.status !== "disabled") return fail("Ese usuario ya está activo.");
      // Un invitado que no ha aceptado no se "reactiva": solo puede aceptar su invitación.
      if (await hasPendingInvitation(target.email)) {
        return fail("Ese usuario tiene una invitación pendiente.");
      }

      const { error: unbanError } = await admin.auth.admin.updateUserById(userId, {
        ban_duration: "none",
      });
      if (unbanError) return fail(GENERIC_ERROR);

      const { error } = await admin.from("profiles").update({ status: "active" }).eq("id", userId);
      if (error) return fail(GENERIC_ERROR);
    }

    await logActivity({
      actorId: actor.id,
      action: next === "disabled" ? "user.disabled" : "user.reactivated",
      resourceType: "user",
      resourceId: userId,
    });
    revalidatePath("/usuarios");
    return ok(next === "disabled" ? "Usuario desactivado." : "Usuario reactivado.");
  });
}

export async function changeUserRole(userIdRaw: string, roleKeyRaw: string): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requirePermission("users.manage");
    const mine = await actorRole();

    const userId = parseUuid(userIdRaw);
    const roleKey = parseRoleKey(roleKeyRaw);
    if (!userId || !roleKey) return fail(GENERIC_ERROR);
    if (userId === actor.id) return fail("No puedes cambiar tu propio rol.");

    const target = await loadProfile(userId);
    if (!target?.roles) return fail("Ese usuario no existe.");

    const admin = createAdminClient();
    const { data: role } = await admin.from("roles").select("id").eq("key", roleKey).maybeSingle();
    if (!role) return fail("Ese rol no existe.");

    // Debe poder gestionar tanto el rol actual como el nuevo (nadie asciende a otro por encima de sí).
    if (!(await mayManage(mine, target.role_id)) || !(await mayManage(mine, role.id))) {
      return fail(NOT_ALLOWED);
    }
    if (target.role_id === role.id) return fail("Ya tiene ese rol.");
    if (target.status === "disabled" && (await hasPendingInvitation(target.email))) {
      return fail("Ese usuario tiene una invitación pendiente: revócala y vuelve a invitar con otro rol.");
    }

    const { error } = await admin.from("profiles").update({ role_id: role.id }).eq("id", userId);
    if (error) return fail(GENERIC_ERROR);

    await logActivity({
      actorId: actor.id,
      action: "user.role_changed",
      resourceType: "user",
      resourceId: userId,
      metadata: { from: target.roles.key, to: roleKey },
    });
    revalidatePath("/usuarios");
    return ok("Rol actualizado.");
  });
}
