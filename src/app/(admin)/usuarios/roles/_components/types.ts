import type { RoleScope } from "@/lib/permissions/keys";

export type RoleView = {
  id: string;
  key: string;
  name: string;
  description: string;
  scope: RoleScope;
  isSystem: boolean;
  isLocked: boolean;
  userCount: number;
  permissions: string[];
  /** Por qué se puede o no editar (la decisión real la repite el servidor). */
  editState: "editable" | "locked" | "own" | "higher";
};

export const EDIT_STATE_MESSAGE: Record<Exclude<RoleView["editState"], "editable">, string> = {
  locked: "Rol bloqueado: es inmutable y no se puede editar.",
  own: "Este es tu propio rol: no puedes editarlo.",
  higher: "Este rol es más poderoso que el tuyo: no puedes editarlo.",
};
