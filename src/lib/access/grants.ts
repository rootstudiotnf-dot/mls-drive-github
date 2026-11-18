import "server-only";

import { type Action, type ResourceType } from "@/lib/permissions/keys";
import type { RoleDef } from "@/lib/permissions/power";
import { ForbiddenError, getEffectiveRole } from "@/lib/permissions/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Utilidades comunes de accesos (grants): validación de flags y caducidad, anti-escalada y comprobación
 * del destinatario. Las usan /accesos y el panel de accesos del espacio de cada artista.
 */

export type GrantFlags = { canView: boolean; canDownload: boolean; canUpload: boolean; canEdit: boolean };


export const FLAG_ACTION: [keyof GrantFlags, Action][] = [
  ["canView", "view"],
  ["canDownload", "download"],
  ["canUpload", "upload"],
  ["canEdit", "edit"],
];

export const RESOURCE_TABLE: Record<Exclude<ResourceType, "vault">, string> = {
  artist: "artists",
  session: "sessions",
  folder: "folders",
  asset: "assets",
  beat: "beats",
};

export const AREAS_FOR: Record<ResourceType, string[]> = {
  vault: ["vault"],
  beat: ["beats"],
  artist: ["photos", "videos", "files"],
  session: ["photos", "videos", "files"],
  folder: ["photos", "videos", "files"],
  asset: ["photos", "videos", "files"],
};

export function parseFlags(raw: Record<string, unknown>): GrantFlags {
  return {
    canView: raw.canView === true,
    canDownload: raw.canDownload === true,
    canUpload: raw.canUpload === true,
    canEdit: raw.canEdit === true,
  };
}

export function parseExpiry(value: unknown): { ok: true; iso: string | null } | { ok: false } {
  if (value === null || value === undefined || value === "") return { ok: true, iso: null };
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return { ok: false };
  const end = new Date(`${value}T23:59:59.000Z`);
  if (Number.isNaN(end.getTime()) || end.getTime() <= Date.now()) return { ok: false };
  return { ok: true, iso: end.toISOString() };
}

/** Anti-escalada: cada flag exige que el rol del actor tenga esa acción en el área del recurso. */
export function ceilingError(actor: RoleDef, type: ResourceType, flags: GrantFlags): string | null {
  for (const [flag, action] of FLAG_ACTION) {
    if (!flags[flag]) continue;
    const allowed = AREAS_FOR[type].some((area) => actor.permissions.has(`${area}.${action}`));
    if (!allowed) return "No puedes conceder un acceso que tu propio rol no tiene.";
  }
  return null;
}

export async function actorRole(): Promise<RoleDef> {
  const role = await getEffectiveRole();
  if (!role) throw new ForbiddenError();
  return role;
}

type Target = { id: string; status: string; roles: { is_locked: boolean } | null };

/** Usuario destinatario: existe, activo, no es el actor y no es un rol bloqueado (owner). */
export async function checkRecipient(actorId: string, userId: string): Promise<string | null> {
  if (userId === actorId) return "No puedes concederte accesos a ti mismo.";
  const { data } = await createAdminClient()
    .from("profiles")
    .select("id, status, roles(is_locked)")
    .eq("id", userId)
    .maybeSingle();
  const target = data as unknown as Target | null;
  if (!target || target.status !== "active") return "Esa persona no está activa.";
  if (target.roles?.is_locked) return "El owner ya tiene acceso total.";
  return null;
}

export async function resourceExists(type: ResourceType, id: string | null): Promise<boolean> {
  if (type === "vault") return id === null;
  if (!id) return false;
  const admin = createAdminClient();
  const table = RESOURCE_TABLE[type];
  let query = admin.from(table).select("id").eq("id", id);
  if (type !== "folder") query = query.is("deleted_at", null);
  else query = query.eq("space", "workspace"); // las carpetas del Vault se conceden solo desde el Vault
  if (type === "asset") query = query.eq("space", "workspace"); // el Vault no se concede por asset
  const { data } = await query.limit(1);
  return (data?.length ?? 0) > 0;
}

