import { VaultAccessPanel } from "@/components/vault/VaultAccessPanel";
import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/PageHeader";
import { TabNav } from "@/components/ui/TabNav";
import { getShareLinkDetail, listShareLinks } from "@/app/actions/share";
import { isUuid } from "@/lib/storage/keys";
import { RESOURCE_TYPES, type ResourceType } from "@/lib/permissions/keys";
import { requirePagePermission } from "@/lib/permissions/server";
import { createClient } from "@/lib/supabase/server";
import { isPast } from "@/lib/time";
import { ActivityPanel, type ActivityItem } from "./_components/ActivityPanel";
import { Assignments } from "./_components/Assignments";
import { GrantsManager } from "./_components/GrantsManager";
import { LinksPanel } from "./_components/LinksPanel";
import type { ArtistAssignment, GrantRow, GrantState, Option } from "./_components/types";

export const metadata: Metadata = { title: "Accesos" };
export const dynamic = "force-dynamic";

type GrantRecord = {
  id: string;
  user_id: string;
  resource_type: ResourceType;
  resource_id: string | null;
  can_view: boolean;
  can_download: boolean;
  can_upload: boolean;
  can_edit: boolean;
  expires_at: string | null;
  revoked_at: string | null;
};

type Named = { id: string; name?: string; title?: string; original_filename?: string };

const TIME_ZONE = "Atlantic/Canary";
const OPTION_LIMIT = 200;

const dayFormat = new Intl.DateTimeFormat("es-ES", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: TIME_ZONE,
});

export default async function AccesosPage({ searchParams }: { searchParams: Promise<{ tab?: string; enlace?: string }> }) {
  // Barrera de servidor: solo con access.manage (si no, 404).
  const actor = await requirePagePermission("access.manage");
  const query = await searchParams;
  const tab = query.tab === "enlaces" ? "enlaces" : "accesos";
  const tabs = (
    <TabNav label="Secciones de Accesos" items={[{ href: "/accesos", label: "Accesos" }, { href: "/accesos?tab=enlaces", label: "Enlaces" }]} current={tab === "enlaces" ? "/accesos?tab=enlaces" : "/accesos"} />
  );

  if (tab === "enlaces") {
    const list = await listShareLinks();
    const detail = isUuid(query.enlace) ? await getShareLinkDetail(query.enlace) : null;
    return (
      <div className="flex flex-col gap-8">
        <PageHeader title="Accesos" description="Enlaces externos: cada uno caduca y se puede revocar al instante. Nada del Vault se comparte." actions={null} />
        {tabs}
        <LinksPanel links={list.ok && list.data ? list.data : []} detail={detail && detail.ok && detail.data ? detail.data : null} />
      </div>
    );
  }

  // Lecturas con el cliente del usuario: RLS decide qué ve (access.manage ve grants y asignaciones).
  const supabase = await createClient();
  const [grantsRes, profilesRes, membersRes, artistsRes, sessionsRes, foldersRes, assetsRes, beatsRes, activityRes] =
    await Promise.all([
      supabase.from("grants").select("*").order("created_at", { ascending: false }).limit(300),
      supabase.from("profiles").select("id, email, full_name, status, roles(is_locked)"),
      supabase.from("artist_members").select("id, artist_id, user_id"),
      supabase.from("artists").select("id, name").order("name").limit(OPTION_LIMIT),
      supabase.from("sessions").select("id, name").order("name").limit(OPTION_LIMIT),
      supabase.from("folders").select("id, name").order("name").limit(OPTION_LIMIT),
      supabase
        .from("assets")
        .select("id, title, original_filename")
        .eq("space", "workspace")
        .order("created_at", { ascending: false })
        .limit(OPTION_LIMIT),
      supabase.from("beats").select("id, title").order("title").limit(OPTION_LIMIT),
      supabase
        .from("activity_log")
        .select("id, actor_id, action, metadata, created_at")
        .order("created_at", { ascending: false })
        .limit(12),
    ]);

  const profiles = (profilesRes.data ?? []) as unknown as {
    id: string;
    email: string;
    full_name: string | null;
    status: string;
    roles: { is_locked: boolean } | null;
  }[];
  const nameOf = (p: { full_name: string | null; email: string }) => p.full_name || p.email;
  const byUser = new Map(profiles.map((p) => [p.id, p]));

  // Opciones de recurso por tipo
  const label = (r: Named) => r.name ?? r.title ?? r.original_filename ?? "Sin nombre";
  const toOptions = (rows: unknown): Option[] =>
    ((rows ?? []) as Named[]).map((r) => ({ value: r.id, label: label(r) }));
  const resourceOptions: Record<Exclude<ResourceType, "vault">, Option[]> = {
    artist: toOptions(artistsRes.data),
    session: toOptions(sessionsRes.data),
    folder: toOptions(foldersRes.data),
    asset: toOptions(assetsRes.data),
    beat: toOptions(beatsRes.data),
  };
  const labelById = new Map<string, string>();
  for (const type of RESOURCE_TYPES) {
    if (type === "vault") continue;
    for (const o of resourceOptions[type]) labelById.set(`${type}:${o.value}`, o.label);
  }

  // Los accesos al Vault (y a sus carpetas) tienen su propio panel: caducidad obligatoria, registro y solo owner
  const grants: GrantRow[] = ((grantsRes.data ?? []) as GrantRecord[])
    .filter((g) => g.resource_type !== "vault" && (g.resource_type !== "folder" || labelById.has(`folder:${g.resource_id}`)))
    .map((g) => {
    const user = byUser.get(g.user_id);
    let state: GrantState = "active";
    if (g.revoked_at) state = "revoked";
    else if (g.expires_at && isPast(g.expires_at)) state = "expired";
    return {
      id: g.id,
      userId: g.user_id,
      userName: user ? nameOf(user) : "Usuario eliminado",
      userEmail: user?.email ?? "",
      resourceType: g.resource_type,
      resourceId: g.resource_id,
      resourceLabel:
        g.resource_type === "vault"
          ? "Vault"
          : (labelById.get(`${g.resource_type}:${g.resource_id}`) ?? "Recurso no disponible"),
      canView: g.can_view,
      canDownload: g.can_download,
      canUpload: g.can_upload,
      canEdit: g.can_edit,
      expiresOn: g.expires_at ? g.expires_at.slice(0, 10) : null,
      expiresLabel: g.expires_at ? dayFormat.format(new Date(g.expires_at)) : null,
      state,
    };
  });

  // Personas a las que se puede conceder acceso: activas, no owner (acceso total) y no uno mismo.
  const recipients: Option[] = profiles
    .filter((p) => p.status === "active" && !p.roles?.is_locked && p.id !== actor.id)
    .map((p) => ({ value: p.id, label: `${nameOf(p)} · ${p.email}` }));

  const members = (membersRes.data ?? []) as { id: string; artist_id: string; user_id: string }[];
  const assignments: ArtistAssignment[] = ((artistsRes.data ?? []) as { id: string; name: string }[]).map(
    (artist) => ({
      id: artist.id,
      name: artist.name,
      members: members
        .filter((m) => m.artist_id === artist.id)
        .map((m) => {
          const user = byUser.get(m.user_id);
          return { memberId: m.id, userId: m.user_id, name: user ? nameOf(user) : "Usuario eliminado" };
        }),
    }),
  );

  // Actividad reciente (RLS: solo access.manage la lee)
  const when = new Intl.DateTimeFormat("es-ES", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: TIME_ZONE,
  });
  const activity: ActivityItem[] = (
    (activityRes.data ?? []) as {
      id: string;
      actor_id: string | null;
      action: string;
      metadata: Record<string, unknown> | null;
      created_at: string;
    }[]
  ).map((entry) => {
    const actor = entry.actor_id ? byUser.get(entry.actor_id) : undefined;
    const meta = entry.metadata ?? {};
    const detail =
      typeof meta.name === "string" ? meta.name : typeof meta.email === "string" ? meta.email : null;
    return {
      id: entry.id,
      actorName: actor ? nameOf(actor) : "Sistema",
      action: entry.action,
      detail,
      whenLabel: when.format(new Date(entry.created_at)),
    };
  });

  return (
    <div className="flex flex-col gap-12">
      <PageHeader
        title="Accesos"
        description="Quién puede ver y hacer qué, y dónde. El rol fija el máximo; aquí eliges el artista o recurso concreto."
        actions={null}
      />
      {tabs}
      <Assignments assignments={assignments} recipients={recipients} />
      {actor.roleKey === "owner" ? <VaultAccessPanel recipients={recipients} /> : null}
      <GrantsManager grants={grants} recipients={recipients} resourceOptions={resourceOptions} />
      <ActivityPanel items={activity} />
    </div>
  );
}
