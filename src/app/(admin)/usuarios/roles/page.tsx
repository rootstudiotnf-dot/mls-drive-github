import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/PageHeader";
import { TabNav } from "@/components/ui/TabNav";
import { canDefineRole } from "@/lib/permissions/power";
import {
  getEffectiveRole,
  loadAllRoleDefs,
  requirePagePermission,
} from "@/lib/permissions/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { NewRoleButton } from "./_components/NewRoleButton";
import { RolesEditor } from "./_components/RolesEditor";
import type { RoleView } from "./_components/types";

export const metadata: Metadata = { title: "Roles" };
export const dynamic = "force-dynamic";

export default async function RolesPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string | string[] }>;
}) {
  // Barrera de servidor: solo con roles.manage (si no, 404).
  const actor = await requirePagePermission("roles.manage");
  const mine = await getEffectiveRole();
  if (!mine) return null;

  const roles = await loadAllRoleDefs();

  // Usuarios por rol (solo el número). Lectura de servidor tras comprobar el permiso.
  const { data: profiles } = await createAdminClient().from("profiles").select("role_id");
  const counts = new Map<string, number>();
  for (const p of (profiles ?? []) as { role_id: string }[]) {
    counts.set(p.role_id, (counts.get(p.role_id) ?? 0) + 1);
  }

  const { data: meta } = await createAdminClient().from("roles").select("id, description");
  const descriptions = new Map(
    ((meta ?? []) as { id: string; description: string }[]).map((r) => [r.id, r.description]),
  );

  const views: RoleView[] = roles.map((role) => {
    let editState: RoleView["editState"] = "editable";
    if (role.isLocked) editState = "locked";
    else if (role.id === actor.roleId) editState = "own";
    else if (!canDefineRole(mine, { permissions: role.permissions, scope: role.scope })) editState = "higher";

    return {
      id: role.id,
      key: role.key,
      name: role.name,
      description: descriptions.get(role.id) ?? "",
      scope: role.scope,
      isSystem: role.isSystem,
      isLocked: role.isLocked,
      userCount: counts.get(role.id) ?? 0,
      permissions: [...role.permissions].sort(),
      editState,
    };
  });

  const { role: requested } = await searchParams;
  const key = Array.isArray(requested) ? requested[0] : requested;
  const selected = views.find((r) => r.key === key) ?? views[0];

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title="Roles"
        description="Qué puede hacer cada rol en la plataforma. Nadie puede conceder permisos que no tiene."
        actions={<NewRoleButton />}
      />
      <TabNav
        label="Usuarios y roles"
        current="/usuarios/roles"
        items={[
          { href: "/usuarios", label: "Usuarios" },
          { href: "/usuarios/roles", label: "Roles" },
        ]}
        className="-mt-4"
      />
      {selected ? (
        <RolesEditor
          roles={views}
          selectedKey={selected.key}
          actorPermissions={[...mine.permissions]}
          actorScope={mine.scope}
        />
      ) : null}
    </div>
  );
}
