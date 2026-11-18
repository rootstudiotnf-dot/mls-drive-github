/**
 * ¿Qué layout usa cada persona? Quien NO tiene ningún permiso de administración (artistas y colaboradores)
 * usa el PORTAL (barra superior, sin barra lateral); el resto usa el shell de administración.
 * Función pura: se usa en servidor para decidir y nunca como medida de seguridad (eso lo hacen
 * requirePermission/RLS).
 */
export const ADMIN_SHELL_PERMISSIONS = [
  "users.invite",
  "users.manage",
  "access.manage",
  "roles.manage",
  "artists.manage",
] as const;

export function hasAdminShell(permissions: ReadonlySet<string>): boolean {
  return ADMIN_SHELL_PERMISSIONS.some((key) => permissions.has(key));
}
