"use server";

import { revalidatePath } from "next/cache";
import { fail, GENERIC_ERROR, NOT_ALLOWED, ok, type ActionResult } from "@/lib/action-result";
import {
  ALL_PERMISSIONS,
  isPermissionKey,
  ROLE_SCOPES,
  type PermissionKey,
  type RoleScope,
} from "@/lib/permissions/keys";
import { canDefineRole, missingPermissions, scopeWithin, type RoleDef } from "@/lib/permissions/power";
import { logActivity } from "@/lib/permissions/audit";
import {
  ForbiddenError,
  getEffectiveRole,
  loadAllRoleDefs,
  loadRoleDef,
  requirePermission,
  runAction,
} from "@/lib/permissions/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseUuid } from "@/lib/validation";

/**
 * Acciones sobre roles. Todas empiezan con requirePermission('roles.manage') y aplican la ANTI-ESCALADA:
 *  - nadie concede permisos que no tiene
 *  - nadie edita su propio rol
 *  - nadie crea/edita/duplica un rol más poderoso que el suyo (permisos o alcance)
 *  - los roles bloqueados (owner) son inmutables (también lo impone un trigger en la base de datos)
 *  - el sistema siempre conserva al menos un usuario activo con roles.manage
 */

export type RoleInput = {
  name: string;
  description: string;
  scope: RoleScope;
  permissions: PermissionKey[];
};

const ROLES_PATH = "/usuarios/roles";

function parseInput(raw: unknown): RoleInput | string {
  if (!raw || typeof raw !== "object") return "Datos no válidos.";
  const input = raw as Record<string, unknown>;

  const name = typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim() : "";
  if (name.length < 2 || name.length > 40) return "El nombre debe tener entre 2 y 40 caracteres.";
  if (/[\u0000-\u001f\u007f]/.test(name)) return "El nombre contiene caracteres no válidos.";

  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (description.length > 200) return "La descripción admite 200 caracteres como máximo.";

  const scope = ROLE_SCOPES.find((s) => s === input.scope);
  if (!scope) return "Alcance no válido.";

  if (!Array.isArray(input.permissions) || input.permissions.length > ALL_PERMISSIONS.length) {
    return "Permisos no válidos.";
  }
  const permissions: PermissionKey[] = [];
  for (const key of input.permissions) {
    if (!isPermissionKey(key)) return "Permisos no válidos.";
    if (!permissions.includes(key)) permissions.push(key);
  }
  return { name, description, scope, permissions };
}

function roleKeyFrom(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 20);
  const base = /^[a-z]/.test(slug) ? slug : `r_${slug}`;
  const suffix = Math.random().toString(16).slice(2, 6);
  return `${base}_${suffix}`.slice(0, 32);
}

async function mine(): Promise<RoleDef> {
  const role = await getEffectiveRole();
  if (!role) throw new ForbiddenError();
  return role;
}

/** ¿Seguirá habiendo al menos un usuario ACTIVO con roles.manage tras el cambio? */
async function keepsAnotherRoleManager(change: {
  roleId: string;
  /** undefined = el rol desaparece */
  permissions?: ReadonlySet<string>;
}): Promise<boolean> {
  const roles = await loadAllRoleDefs();
  const ids = roles
    .filter((r) => {
      const perms = r.id === change.roleId ? change.permissions : r.permissions;
      return !!perms && perms.has("roles.manage");
    })
    .map((r) => r.id);
  if (ids.length === 0) return false;
  const { data } = await createAdminClient()
    .from("profiles")
    .select("id")
    .eq("status", "active")
    .in("role_id", ids)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

async function replacePermissions(roleId: string, keys: readonly string[]): Promise<boolean> {
  const { error } = await createAdminClient().rpc("replace_role_permissions", {
    p_role: roleId,
    p_keys: [...keys],
  });
  return !error;
}

/** Comprobaciones comunes de anti-escalada para definir un rol (crear, guardar o duplicar). */
function escalationError(actor: RoleDef, input: Pick<RoleInput, "permissions" | "scope">): string | null {
  const missing = missingPermissions(actor, input.permissions);
  if (missing.length > 0) return "No puedes conceder permisos que tú no tienes.";
  if (!scopeWithin(actor.scope, input.scope)) return "No puedes crear un rol con más alcance que el tuyo.";
  return null;
}

// ---------------------------------------------------------------------------

export async function createRole(raw: unknown): Promise<ActionResult<{ key: string }>> {
  return runAction(async () => {
    const actor = await requirePermission("roles.manage");
    const my = await mine();

    const input = parseInput(raw);
    if (typeof input === "string") return fail(input);
    const escalation = escalationError(my, input);
    if (escalation) return fail(escalation);

    const admin = createAdminClient();
    const key = roleKeyFrom(input.name);
    const { data: created, error } = await admin
      .from("roles")
      .insert({ key, name: input.name, description: input.description, scope: input.scope, is_system: false })
      .select("id")
      .single();
    if (error || !created) {
      return fail(error?.code === "23505" ? "Ya existe un rol con ese nombre." : GENERIC_ERROR);
    }
    if (!(await replacePermissions(created.id, input.permissions))) {
      await admin.from("roles").delete().eq("id", created.id);
      return fail(GENERIC_ERROR);
    }

    await logActivity({
      actorId: actor.id,
      action: "role.created",
      resourceType: "role",
      resourceId: created.id,
      metadata: { name: input.name, scope: input.scope, permissions: input.permissions },
    });
    revalidatePath(ROLES_PATH);
    return ok("Rol creado.", { key });
  });
}

export async function saveRole(roleIdRaw: string, raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requirePermission("roles.manage");
    const my = await mine();

    const roleId = parseUuid(roleIdRaw);
    const input = parseInput(raw);
    if (!roleId) return fail(GENERIC_ERROR);
    if (typeof input === "string") return fail(input);

    const target = await loadRoleDef(roleId);
    if (!target) return fail("Ese rol no existe.");
    if (target.isLocked) return fail("Este rol está bloqueado y no se puede editar.");
    if (target.id === actor.roleId) return fail("No puedes editar tu propio rol.");
    if (!canDefineRole(my, { permissions: target.permissions, scope: target.scope })) {
      return fail("Este rol es más poderoso que el tuyo: no puedes editarlo.");
    }
    const escalation = escalationError(my, input);
    if (escalation) return fail(escalation);

    if (!(await keepsAnotherRoleManager({ roleId, permissions: new Set(input.permissions) }))) {
      return fail("Debe quedar al menos un usuario activo que pueda gestionar roles.");
    }

    const admin = createAdminClient();
    const { data: before } = await admin
      .from("roles")
      .select("name, description, scope")
      .eq("id", roleId)
      .maybeSingle();

    const { error } = await admin
      .from("roles")
      .update({ name: input.name, description: input.description, scope: input.scope })
      .eq("id", roleId);
    if (error) {
      return fail(error.code === "23505" ? "Ya existe un rol con ese nombre." : GENERIC_ERROR);
    }
    if (!(await replacePermissions(roleId, input.permissions))) {
      if (before) await admin.from("roles").update(before).eq("id", roleId); // revierte nombre y alcance
      return fail(GENERIC_ERROR);
    }

    await logActivity({
      actorId: actor.id,
      action: "role.updated",
      resourceType: "role",
      resourceId: roleId,
      metadata: {
        name: input.name,
        scope: input.scope,
        added: input.permissions.filter((k) => !target.permissions.has(k)),
        removed: [...target.permissions].filter((k) => !input.permissions.includes(k as PermissionKey)),
      },
    });
    revalidatePath(ROLES_PATH);
    revalidatePath("/usuarios");
    return ok("Rol guardado.");
  });
}

export async function duplicateRole(roleIdRaw: string): Promise<ActionResult<{ key: string }>> {
  return runAction(async () => {
    const actor = await requirePermission("roles.manage");
    const my = await mine();

    const roleId = parseUuid(roleIdRaw);
    if (!roleId) return fail(GENERIC_ERROR);
    const source = await loadRoleDef(roleId);
    if (!source) return fail("Ese rol no existe.");
    // No se puede duplicar (y así obtener) un rol más poderoso que el propio.
    if (!canDefineRole(my, { permissions: source.permissions, scope: source.scope })) {
      return fail("Este rol es más poderoso que el tuyo: no puedes duplicarlo.");
    }

    const admin = createAdminClient();
    const { data: meta } = await admin.from("roles").select("description").eq("id", roleId).maybeSingle();

    for (let attempt = 1; attempt <= 5; attempt++) {
      const name = `${attempt === 1 ? "Copia de" : `Copia ${attempt} de`} ${source.name}`.slice(0, 40);
      const key = roleKeyFrom(name);
      const { data: created, error } = await admin
        .from("roles")
        .insert({
          key,
          name,
          description: (meta as { description?: string } | null)?.description ?? "",
          scope: source.scope,
          is_system: false,
        })
        .select("id")
        .single();
      if (error?.code === "23505") continue; // nombre ocupado: se prueba otro
      if (error || !created) return fail(GENERIC_ERROR);

      if (!(await replacePermissions(created.id, [...source.permissions]))) {
        await admin.from("roles").delete().eq("id", created.id);
        return fail(GENERIC_ERROR);
      }
      await logActivity({
        actorId: actor.id,
        action: "role.duplicated",
        resourceType: "role",
        resourceId: created.id,
        metadata: { from: source.key },
      });
      revalidatePath(ROLES_PATH);
      return ok("Rol duplicado.", { key });
    }
    return fail("Ya existen varias copias de este rol. Renombra alguna antes de duplicar.");
  });
}

export async function deleteRole(roleIdRaw: string): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requirePermission("roles.manage");
    const my = await mine();

    const roleId = parseUuid(roleIdRaw);
    if (!roleId) return fail(GENERIC_ERROR);
    const target = await loadRoleDef(roleId);
    if (!target) return fail("Ese rol no existe.");
    if (target.isLocked) return fail("Este rol está bloqueado y no se puede eliminar.");
    if (target.isSystem) return fail("Los roles de sistema no se pueden eliminar.");
    if (target.id === actor.roleId) return fail("No puedes eliminar tu propio rol.");
    if (!canDefineRole(my, { permissions: target.permissions, scope: target.scope })) return fail(NOT_ALLOWED);

    const admin = createAdminClient();
    const [users, invitations] = await Promise.all([
      admin.from("profiles").select("id").eq("role_id", roleId).limit(1),
      admin.from("invitations").select("id").eq("role_id", roleId).limit(1),
    ]);
    if ((users.data?.length ?? 0) > 0 || (invitations.data?.length ?? 0) > 0) {
      return fail("Hay usuarios o invitaciones con este rol. Cámbialos de rol antes de eliminarlo.");
    }
    if (!(await keepsAnotherRoleManager({ roleId }))) {
      return fail("Debe quedar al menos un usuario activo que pueda gestionar roles.");
    }

    const { error } = await admin.from("roles").delete().eq("id", roleId);
    if (error) {
      // 23503: un usuario o invitación lo usa (carrera) · P0001: bloqueado en la base de datos
      return fail(error.code === "23503" ? "Hay usuarios con este rol." : GENERIC_ERROR);
    }

    await logActivity({
      actorId: actor.id,
      action: "role.deleted",
      resourceType: "role",
      resourceId: roleId,
      metadata: { name: target.name },
    });
    revalidatePath(ROLES_PATH);
    return ok("Rol eliminado.");
  });
}
