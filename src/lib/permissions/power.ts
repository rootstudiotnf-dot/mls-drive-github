import type { RoleScope } from "./keys";

/**
 * "Rango" entre roles (anti-escalada). Funciones puras: las usa el servidor para APLICAR las reglas
 * y la interfaz solo para ocultar lo que no procede.
 *
 *  - Un rol es "más poderoso" si tiene permisos que el otro no tiene, o un alcance mayor.
 *  - Nadie puede conceder permisos que no tiene, ni crear/editar un rol más poderoso que el suyo.
 */

export type RoleDef = {
  id: string;
  key: string;
  name: string;
  scope: RoleScope;
  isLocked: boolean;
  isSystem: boolean;
  permissions: ReadonlySet<string>;
};

const SCOPE_RANK: Record<RoleScope, number> = { assigned: 0, all: 1 };

export function scopeWithin(actor: RoleScope, target: RoleScope): boolean {
  return SCOPE_RANK[target] <= SCOPE_RANK[actor];
}

export function isSubset(subset: Iterable<string>, superset: ReadonlySet<string>): boolean {
  for (const key of subset) if (!superset.has(key)) return false;
  return true;
}

/** Permisos de `wanted` que el actor no tiene (no puede concederlos). */
export function missingPermissions(actor: RoleDef, wanted: Iterable<string>): string[] {
  const out: string[] = [];
  for (const key of wanted) if (!actor.permissions.has(key)) out.push(key);
  return out;
}

/** ¿Puede el actor definir (crear, editar, duplicar) un rol con estos permisos y alcance? */
export function canDefineRole(
  actor: RoleDef,
  wanted: { permissions: Iterable<string>; scope: RoleScope },
): boolean {
  return isSubset(wanted.permissions, actor.permissions) && scopeWithin(actor.scope, wanted.scope);
}

/**
 * ¿Es `target` un rol de MENOR rango que `actor`? Se usa para gestionar usuarios: se puede invitar,
 * activar/desactivar o cambiar el rol solo de personas cuyo rol sea estrictamente menos poderoso.
 * (Con los roles de serie: el owner gestiona al admin y por debajo; el admin, solo por debajo del admin.)
 */
export function isStrictlyBelow(actor: RoleDef, target: RoleDef): boolean {
  if (target.isLocked || target.id === actor.id) return false;
  if (!isSubset(target.permissions, actor.permissions)) return false;
  if (!scopeWithin(actor.scope, target.scope)) return false;
  // Estrictamente menos poderoso: tiene menos permisos o menor alcance.
  return (
    target.permissions.size < actor.permissions.size ||
    SCOPE_RANK[target.scope] < SCOPE_RANK[actor.scope]
  );
}
