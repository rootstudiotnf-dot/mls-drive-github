import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type Actor = {
  id: string;
  email: string;
  fullName: string | null;
  /** Nombre para mostrar: nombre completo o, si no hay, la parte local del correo. */
  displayName: string;
  roleId: string;
  roleKey: string;
  roleName: string;
};

type ProfileWithRole = {
  id: string;
  email: string;
  full_name: string | null;
  status: "active" | "disabled";
  last_seen_at: string | null;
  role_id: string;
  roles: { key: string; name: string } | null;
};

const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Usuario que actúa en esta petición, o null si no hay sesión válida O su cuenta no está activa.
 *
 * - `auth.getUser()` valida el token contra Supabase Auth (no se fía del JWT de la cookie).
 * - El perfil se lee con el cliente del usuario (RLS) y debe estar 'active'.
 * Las decisiones de permisos van DESPUÉS, en lib/permissions (requirePermission / requirePagePermission).
 */
export const getActor = cache(async (): Promise<Actor | null> => {
  const supabase = await createClient();

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) return null;
  const user = userData.user;

  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, full_name, status, last_seen_at, role_id, roles(key, name)")
    .eq("id", user.id)
    .maybeSingle();
  if (error || !data) return null;

  const profile = data as unknown as ProfileWithRole;
  if (profile.status !== "active" || !profile.roles) return null;

  // Último acceso: como mucho una escritura cada 5 minutos, fuera del camino de la respuesta.
  const last = profile.last_seen_at ? new Date(profile.last_seen_at).getTime() : 0;
  if (Date.now() - last > LAST_SEEN_THROTTLE_MS) {
    after(async () => {
      await createAdminClient()
        .from("profiles")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("id", profile.id);
    });
  }

  return {
    id: profile.id,
    email: profile.email,
    fullName: profile.full_name,
    displayName: profile.full_name?.trim() || profile.email.split("@")[0] || profile.email,
    roleId: profile.role_id,
    roleKey: profile.roles.key,
    roleName: profile.roles.name,
  };
});

/** Para páginas: exige cuenta activa; si no, al login (el proxy decide el destino final). */
export async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) redirect("/login");
  return actor;
}
