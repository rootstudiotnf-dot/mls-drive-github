import "server-only";

import type { AccessGrant, AccessMember } from "@/components/artist/AccessPanel";
import type { Actor } from "@/lib/auth/session";
import { isStrictlyBelow, type RoleDef } from "@/lib/permissions/power";
import { loadAllRoleDefs } from "@/lib/permissions/server";
import { createClient } from "@/lib/supabase/server";
import { isPast } from "@/lib/time";

/**
 * Datos del panel de accesos de un recurso (artista o sesión): equipo asignado, accesos concedidos,
 * personas a las que se puede dar acceso y roles que se pueden invitar. Todo con el cliente del usuario
 * (RLS: solo quien gestiona accesos lee grants y asignaciones).
 */

const dayFormat = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", year: "numeric", timeZone: "Atlantic/Canary" });

type P = { id: string; email: string; full_name: string | null; status: string; roles: { name: string; is_locked: boolean } | null };

export async function loadAccessPanelData(input: {
  resourceType: "artist" | "session";
  resourceId: string;
  /** Con equipo (asignaciones persona ↔ artista): solo para artistas. */
  artistIdForTeam?: string;
  actor: Actor;
  role: RoleDef;
}): Promise<{ members: AccessMember[]; grants: AccessGrant[]; recipients: { value: string; label: string }[]; roles: { value: string; label: string }[] }> {
  const supabase = await createClient();
  const [membersRes, grantsRes, profilesRes, defs] = await Promise.all([
    input.artistIdForTeam
      ? supabase.from("artist_members").select("id, user_id").eq("artist_id", input.artistIdForTeam)
      : Promise.resolve({ data: [] as { id: string; user_id: string }[] }),
    supabase
      .from("grants")
      .select("id, user_id, can_view, can_download, can_upload, can_edit, expires_at")
      .eq("resource_type", input.resourceType)
      .eq("resource_id", input.resourceId)
      .is("revoked_at", null)
      .order("created_at", { ascending: false }),
    supabase.from("profiles").select("id, email, full_name, status, roles(name, is_locked)"),
    loadAllRoleDefs(),
  ]);
  const profiles = (profilesRes.data ?? []) as unknown as P[];
  const byUser = new Map(profiles.map((p) => [p.id, p]));
  const nameOf = (id: string) => {
    const p = byUser.get(id);
    return p ? p.full_name || p.email : "Usuario eliminado";
  };

  const members: AccessMember[] = ((membersRes.data ?? []) as { id: string; user_id: string }[]).map((m) => ({
    memberId: m.id,
    userId: m.user_id,
    name: nameOf(m.user_id),
    roleName: byUser.get(m.user_id)?.roles?.name ?? "",
  }));
  const grants: AccessGrant[] = (
    (grantsRes.data ?? []) as {
      id: string;
      user_id: string;
      can_view: boolean;
      can_download: boolean;
      can_upload: boolean;
      can_edit: boolean;
      expires_at: string | null;
    }[]
  ).map((g) => ({
    id: g.id,
    userId: g.user_id,
    name: nameOf(g.user_id),
    email: byUser.get(g.user_id)?.email ?? "",
    roleName: byUser.get(g.user_id)?.roles?.name ?? "",
    canView: g.can_view,
    canDownload: g.can_download,
    canUpload: g.can_upload,
    canEdit: g.can_edit,
    expiresOn: g.expires_at ? g.expires_at.slice(0, 10) : null,
    expiresLabel: g.expires_at ? dayFormat.format(new Date(g.expires_at)) : null,
    state: g.expires_at && isPast(g.expires_at) ? "expired" : "active",
  }));
  const recipients = profiles
    .filter((p) => p.status === "active" && !p.roles?.is_locked && p.id !== input.actor.id)
    .map((p) => ({ value: p.id, label: `${p.full_name || p.email} · ${p.email}` }));
  const roles = defs.filter((r) => isStrictlyBelow(input.role, r)).map((r) => ({ value: r.key, label: r.name }));
  return { members, grants, recipients, roles };
}
