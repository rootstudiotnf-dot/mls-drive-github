import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/PageHeader";
import { TabNav } from "@/components/ui/TabNav";
import { isStrictlyBelow } from "@/lib/permissions/power";
import {
  getEffectiveRole,
  loadAllRoleDefs,
  userHasPermission,
  requirePagePermission,
} from "@/lib/permissions/server";
import { createClient } from "@/lib/supabase/server";
import { isPast } from "@/lib/time";
import { InviteDialog } from "./_components/InviteDialog";
import { UsersTable } from "./_components/UsersTable";
import type { RoleOption, UserRow, UserState } from "./_components/types";

export const metadata: Metadata = { title: "Usuarios" };
export const dynamic = "force-dynamic";

type ProfileRecord = {
  id: string;
  email: string;
  full_name: string | null;
  status: "active" | "disabled";
  last_seen_at: string | null;
  created_at: string;
  roles: { key: string; name: string } | null;
};

type InvitationRecord = {
  id: string;
  email: string;
  expires_at: string;
};

const TIME_ZONE = "Atlantic/Canary";

function formatDate(iso: string | null): string {
  if (!iso) return "Nunca";
  return new Intl.DateTimeFormat("es-ES", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: TIME_ZONE,
  }).format(new Date(iso));
}

export default async function UsuariosPage() {
  // Barrera de servidor: sin sesión activa y sin permiso de usuarios, esta página no se renderiza (404).
  const actor = await requirePagePermission("users.manage", "users.invite");
  const mine = await getEffectiveRole();

  // Lecturas con el cliente del usuario: RLS decide qué filas ve.
  const supabase = await createClient();
  const [profilesRes, invitationsRes, roleDefs, canManageRoles] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, email, full_name, status, last_seen_at, created_at, roles(key, name)")
      .order("created_at", { ascending: true }),
    supabase.from("invitations").select("id, email, expires_at").eq("status", "pending"),
    loadAllRoleDefs(),
    userHasPermission(actor.id, "roles.manage"),
  ]);

  const profiles = (profilesRes.data ?? []) as unknown as ProfileRecord[];
  const pending = new Map(
    ((invitationsRes.data ?? []) as unknown as InvitationRecord[]).map((i) => [
      i.email.toLowerCase(),
      i,
    ]),
  );

  // Roles que este usuario puede asignar/gestionar: los de rango estrictamente menor.
  const manageable = mine ? roleDefs.filter((r) => isStrictlyBelow(mine, r)) : [];
  const manageableKeys = manageable.map((r) => r.key);
  const roleOptions: RoleOption[] = manageable.map((r) => ({ value: r.key, label: r.name }));

  const rows: UserRow[] = profiles
    .filter((p) => p.roles)
    .map((p) => {
      const invitation = pending.get(p.email.toLowerCase());
      let state: UserState;
      if (p.status === "active") state = "active";
      else if (invitation) {
        state = isPast(invitation.expires_at) ? "expired" : "invited";
      } else state = "disabled";

      return {
        id: p.id,
        email: p.email,
        name: p.full_name,
        roleKey: p.roles!.key,
        roleName: p.roles!.name,
        state,
        lastSeenLabel: state === "invited" || state === "expired" ? "—" : formatDate(p.last_seen_at),
        invitationId: invitation?.id ?? null,
      };
    })
    .sort((a, b) => (a.roleKey === "owner" ? -1 : b.roleKey === "owner" ? 1 : 0));

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title="Usuarios"
        description="Personas con acceso a la plataforma y su rol. Las cuentas se crean solo por invitación."
        actions={<InviteDialog roles={roleOptions} />}
      />
      {canManageRoles ? (
        <TabNav
          label="Usuarios y roles"
          current="/usuarios"
          items={[
            { href: "/usuarios", label: "Usuarios" },
            { href: "/usuarios/roles", label: "Roles" },
          ]}
          className="-mt-4"
        />
      ) : null}
      <UsersTable
        rows={rows}
        actorId={actor.id}
        manageableRoleKeys={manageableKeys}
        roleOptions={roleOptions}
      />
    </div>
  );
}
