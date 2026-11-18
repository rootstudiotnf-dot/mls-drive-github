import "server-only";
import { recordError } from "@/lib/ops/errors";

import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { fail, GENERIC_ERROR, NOT_ALLOWED, type ActionResult } from "@/lib/action-result";
import { getActor, type Actor } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { Action, PermissionKey, ResourceRef, RoleScope } from "./keys";
import type { RoleDef } from "./power";

/**
 * Capa de permisos de servidor. La decisión la toma la BASE DE DATOS (funciones SQL `has_permission`
 * y `can_access`, las mismas que usan las políticas RLS); aquí solo se invocan.
 *
 * Regla de oro: TODA acción de servidor empieza con `requirePermission(...)`.
 * Denegar por defecto: cualquier error, sesión ausente o respuesta distinta de `true` es un 403.
 */

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(message = NOT_ALLOWED) {
    super(message);
    this.name = "ForbiddenError";
  }
}

export type Permission = PermissionKey | { action: Action; resource: ResourceRef };

/** ¿Puede `userId` hacer `action` sobre `resource`? (regla can_access completa). */
export async function can(userId: string, action: Action, resource: ResourceRef): Promise<boolean> {
  const { data, error } = await createAdminClient().rpc("can_access", {
    p_user: userId,
    p_action: action,
    p_resource_type: resource.type,
    p_resource_id: resource.id,
  });
  return !error && data === true;
}

/** ¿Tiene `userId` este permiso (de catálogo) en su rol? */
export async function userHasPermission(userId: string, key: PermissionKey): Promise<boolean> {
  const { data, error } = await createAdminClient().rpc("has_permission", {
    p_user: userId,
    p_key: key,
  });
  return !error && data === true;
}

/**
 * Exige que el usuario actual tenga el permiso (de catálogo) o el acceso (acción sobre recurso).
 * Lanza ForbiddenError (403) si no. Devuelve el actor.
 */
export async function requirePermission(permission: Permission): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new ForbiddenError();
  const allowed =
    typeof permission === "string"
      ? await userHasPermission(actor.id, permission)
      : await can(actor.id, permission.action, permission.resource);
  if (!allowed) throw new ForbiddenError();
  return actor;
}

/** Igual pero aceptando cualquiera de varios permisos de catálogo. */
export async function requireAnyPermission(...keys: PermissionKey[]): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new ForbiddenError();
  for (const key of keys) if (await userHasPermission(actor.id, key)) return actor;
  throw new ForbiddenError();
}

/** Para páginas: sin sesión → /login; sin permiso → 404 (no revela que la pantalla existe). */
export async function requirePagePermission(...keys: PermissionKey[]): Promise<Actor> {
  const actor = await getActor();
  if (!actor) redirect("/login");
  for (const key of keys) if (await userHasPermission(actor.id, key)) return actor;
  notFound();
}

/** Ejecuta el cuerpo de una acción convirtiendo 403 y fallos inesperados en un resultado seguro. */
export async function runAction<T = undefined>(
  body: () => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof ForbiddenError) return fail(error.message);
    // Next usa excepciones para redirect()/notFound(): se dejan pasar.
    if (error instanceof Error && "digest" in error) throw error;
    await recordError("action", error);
    return fail(GENERIC_ERROR);
  }
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

type RoleRow = {
  id: string;
  key: string;
  name: string;
  scope: RoleScope;
  is_locked: boolean;
  is_system: boolean;
};

function toRoleDef(row: RoleRow, keys: string[]): RoleDef {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    scope: row.scope,
    isLocked: row.is_locked,
    isSystem: row.is_system,
    permissions: new Set(keys),
  };
}

/** Definición completa (con permisos) de un rol por id. Lectura con service role: solo servidor. */
export async function loadRoleDef(roleId: string): Promise<RoleDef | null> {
  const admin = createAdminClient();
  const { data: role } = await admin
    .from("roles")
    .select("id, key, name, scope, is_locked, is_system")
    .eq("id", roleId)
    .maybeSingle();
  if (!role) return null;
  const { data: perms } = await admin
    .from("role_permissions")
    .select("permission_key")
    .eq("role_id", roleId);
  return toRoleDef(
    role as unknown as RoleRow,
    ((perms ?? []) as { permission_key: string }[]).map((p) => p.permission_key),
  );
}

/** Todos los roles con sus permisos (servidor). */
export async function loadAllRoleDefs(): Promise<RoleDef[]> {
  const admin = createAdminClient();
  const [{ data: roles }, { data: perms }] = await Promise.all([
    admin.from("roles").select("id, key, name, scope, is_locked, is_system").order("created_at"),
    admin.from("role_permissions").select("role_id, permission_key"),
  ]);
  const byRole = new Map<string, string[]>();
  for (const p of (perms ?? []) as { role_id: string; permission_key: string }[]) {
    byRole.set(p.role_id, [...(byRole.get(p.role_id) ?? []), p.permission_key]);
  }
  return ((roles ?? []) as unknown as RoleRow[]).map((r) => toRoleDef(r, byRole.get(r.id) ?? []));
}

/** Rol efectivo del usuario actual (con sus permisos). Una sola consulta por petición. */
export const getEffectiveRole = cache(async (): Promise<RoleDef | null> => {
  const actor = await getActor();
  if (!actor) return null;
  // Con el cliente del usuario: RLS (role_permissions_select) solo le deja leer los de su rol.
  const supabase = await createClient();
  const [{ data: role }, { data: perms }] = await Promise.all([
    supabase.from("roles").select("id, key, name, scope, is_locked, is_system").eq("id", actor.roleId).maybeSingle(),
    supabase.from("role_permissions").select("permission_key").eq("role_id", actor.roleId),
  ]);
  if (!role) return null;
  return toRoleDef(
    role as unknown as RoleRow,
    ((perms ?? []) as { permission_key: string }[]).map((p) => p.permission_key),
  );
});
