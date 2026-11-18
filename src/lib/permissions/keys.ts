/**
 * Catálogo de permisos (constantes tipadas). Es la misma lista que siembra 0002_core.sql:
 * si cambias una, cambia la otra. Sin dependencias de servidor: lo usa también la interfaz
 * (solo para pintar; la decisión real la toman el servidor y RLS).
 */

export const AREAS = ["photos", "videos", "files", "beats", "vault"] as const;
export type Area = (typeof AREAS)[number];

export const ACTIONS = ["view", "download", "upload", "edit", "delete", "publish"] as const;
export type Action = (typeof ACTIONS)[number];

export const ADMIN_PERMISSIONS = [
  "users.invite",
  "users.manage",
  "access.manage",
  "roles.manage",
  "artists.manage",
] as const;
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

/** Permisos de comentar (fuera de la rejilla área × acción: solo existen para fotos, vídeos y beats). */
export const COMMENT_PERMISSIONS = ["photos.comment", "videos.comment", "beats.comment"] as const;
export type CommentPermission = (typeof COMMENT_PERMISSIONS)[number];

export const COMMENT_PERMISSION_LABEL: Record<CommentPermission, { label: string; hint: string }> = {
  "photos.comment": { label: "Comentar fotos", hint: "Escribir comentarios en las fotos a las que accede." },
  "videos.comment": { label: "Comentar vídeos", hint: "Escribir comentarios con marca de tiempo en los vídeos a los que accede." },
  "beats.comment": { label: "Comentar beats", hint: "Escribir comentarios en los beats a los que accede." },
};

export type ContentPermission = `${Area}.${Action}`;
export type PermissionKey = ContentPermission | AdminPermission | CommentPermission;

export const CONTENT_PERMISSIONS: readonly ContentPermission[] = AREAS.flatMap((area) =>
  ACTIONS.map((action): ContentPermission => `${area}.${action}`),
);

export const ALL_PERMISSIONS: readonly PermissionKey[] = [
  ...CONTENT_PERMISSIONS,
  ...ADMIN_PERMISSIONS,
  ...COMMENT_PERMISSIONS,
];

const PERMISSION_SET: ReadonlySet<string> = new Set(ALL_PERMISSIONS);

export function isPermissionKey(value: unknown): value is PermissionKey {
  return typeof value === "string" && PERMISSION_SET.has(value);
}

export const AREA_LABEL: Record<Area, string> = {
  photos: "Fotos",
  videos: "Vídeos",
  files: "Archivos",
  beats: "Beats",
  vault: "Vault",
};

export const ACTION_LABEL: Record<Action, string> = {
  view: "Ver",
  download: "Descargar",
  upload: "Subir",
  edit: "Editar",
  delete: "Eliminar",
  publish: "Publicar",
};

export const ADMIN_PERMISSION_LABEL: Record<AdminPermission, { label: string; hint: string }> = {
  "users.invite": { label: "Invitar usuarios", hint: "Enviar invitaciones y reenviarlas o revocarlas." },
  "users.manage": { label: "Gestionar usuarios", hint: "Activar, desactivar y cambiar el rol de usuarios de menor rango." },
  "access.manage": { label: "Gestionar accesos", hint: "Asignar personas a artistas y conceder accesos por recurso." },
  "roles.manage": { label: "Gestionar roles", hint: "Crear y editar roles y sus permisos." },
  "artists.manage": { label: "Gestionar artistas", hint: "Crear, editar y archivar artistas y sus espacios." },
};

/** Recursos sobre los que se evalúa el acceso (regla `can_access`). */
export const RESOURCE_TYPES = ["artist", "session", "folder", "asset", "beat", "vault"] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export type ResourceRef = { type: ResourceType; id: string | null };

export const ROLE_SCOPES = ["all", "assigned"] as const;
export type RoleScope = (typeof ROLE_SCOPES)[number];

export const SCOPE_LABEL: Record<RoleScope, string> = {
  all: "Todos los artistas",
  assigned: "Solo artistas asignados",
};
