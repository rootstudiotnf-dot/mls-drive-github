import type { ResourceType } from "@/lib/permissions/keys";

export type GrantState = "active" | "expired" | "revoked";

export type GrantRow = {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  resourceType: ResourceType;
  resourceId: string | null;
  resourceLabel: string;
  canView: boolean;
  canDownload: boolean;
  canUpload: boolean;
  canEdit: boolean;
  /** YYYY-MM-DD o null */
  expiresOn: string | null;
  expiresLabel: string | null;
  state: GrantState;
};

export type Option = { value: string; label: string };

export type ArtistAssignment = {
  id: string;
  name: string;
  members: { memberId: string; userId: string; name: string }[];
};

export const RESOURCE_LABEL: Record<ResourceType, string> = {
  artist: "Artista",
  session: "Sesión",
  folder: "Carpeta",
  asset: "Archivo",
  beat: "Beat",
  vault: "Vault",
};

export const GRANT_STATE_LABEL: Record<GrantState, string> = {
  active: "Vigente",
  expired: "Caducado",
  revoked: "Revocado",
};
