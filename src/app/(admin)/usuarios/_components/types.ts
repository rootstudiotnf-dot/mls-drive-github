export type UserState = "active" | "invited" | "expired" | "disabled";

export type UserRow = {
  /** id del perfil (= auth.users.id) */
  id: string;
  email: string;
  name: string | null;
  roleKey: string;
  roleName: string;
  state: UserState;
  /** Texto ya formateado en servidor ("Nunca", "16 nov 2026, 10:32"…) */
  lastSeenLabel: string;
  /** Solo si state es invited/expired */
  invitationId: string | null;
};

export type RoleOption = { value: string; label: string };

export const STATE_LABEL: Record<UserState, string> = {
  active: "Activo",
  invited: "Invitación enviada",
  expired: "Invitación caducada",
  disabled: "Desactivado",
};
