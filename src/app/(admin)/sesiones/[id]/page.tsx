import { hasVaultEntitlement } from "@/lib/vault/access";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AccessPanel } from "@/components/artist/AccessPanel";
import { SessionGallery } from "@/components/gallery/SessionGallery";
import { ImageIcon } from "@/components/icons";
import { CopyLinkButton } from "@/components/session/CopyLinkButton";
import { FavoritesPanel } from "@/components/session/FavoritesPanel";
import { ShareButton } from "@/components/share/ShareButton";
import { SessionFolders } from "@/components/session/SessionFolders";
import { SessionFormDialog } from "@/components/session/SessionFormDialog";
import { Badge } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/ButtonLink";
import { DataList, DataRow } from "@/components/ui/DataRow";
import { EmptyState } from "@/components/ui/EmptyState";
import { TabNav } from "@/components/ui/TabNav";
import { listMyFavorites, listSessionFavorites } from "@/app/actions/sessions";
import { loadAccessPanelData } from "@/lib/access/panel-data";
import { DOWNLOAD_MODE_LABEL } from "@/lib/assets/variants";
import { loadVisibleArtists } from "@/lib/artists/data";
import { formatBytes } from "@/lib/format";
import { ADMIN_SHELL_PERMISSIONS } from "@/lib/permissions/portal";
import { getEffectiveRole, requirePagePermission } from "@/lib/permissions/server";
import {
  loadArtistNames,
  loadParticipants,
  loadSession,
  loadSessionFolders,
  loadSessionMaterial,
  loadSessionPhotos,
  loadSessions,
} from "@/lib/sessions/data";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/storage/keys";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const session = await loadSession(id).catch(() => null);
  return { title: session?.name ?? "Sesión" };
}

const TABS = ["fotos", "material", "favoritas", "accesos"] as const;
type Tab = (typeof TABS)[number];

const dayFormat = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "long", year: "numeric", timeZone: "Atlantic/Canary" });

export default async function SesionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; foto?: string }>;
}) {
  const actor = await requirePagePermission(...ADMIN_SHELL_PERMISSIONS);
  const role = await getEffectiveRole();
  if (!role?.permissions.has("photos.view")) notFound();

  const { id } = await params;
  const query = await searchParams;
  // Lectura bajo RLS: sin acceso a la sesión es como si no existiera (404, nunca 403)
  const session = await loadSession(id);
  if (!session) notFound();

  const has = (key: string) => role.permissions.has(key);
  const canEdit = has("photos.edit");
  const canVault = canEdit && has("vault.upload") && (await hasVaultEntitlement(actor));
  const canPublish = has("photos.publish");
  const canAccess = has("access.manage");

  const available: { key: Tab; label: string }[] = [
    { key: "fotos", label: "Fotos" },
    { key: "material", label: "Vídeos y material" },
    ...(canEdit || canPublish ? [{ key: "favoritas" as const, label: "Favoritas" }] : []),
    ...(canAccess ? [{ key: "accesos" as const, label: "Accesos" }] : []),
  ];
  const requested = TABS.find((t) => t === query.tab) ?? "fotos";
  const tab: Tab = available.some((t) => t.key === requested) ? requested : "fotos";

  const base = `/sesiones/${session.id}`;
  const href = (key: Tab) => (key === "fotos" ? base : `${base}?tab=${key}`);

  const [participants, artists, allSessions] = await Promise.all([loadParticipants([session.id]), loadVisibleArtists(), loadSessions()]);
  const participantIds = participants.get(session.id) ?? [];
  const names = await loadArtistNames([session.artistId, ...participantIds]);
  const mainArtist = artists.find((a) => a.id === session.artistId);

  // Cabecera: número de fotos y de otros archivos (bajo RLS)
  const supabase = await createClient();
  const { data: countRows } = await supabase.rpc("session_counts");
  const counts = ((countRows ?? []) as { session_id: string; photos: number; others: number }[]).find((r) => r.session_id === session.id);
  const photoCount = Number(counts?.photos ?? 0);
  const otherCount = Number(counts?.others ?? 0);

  let content: React.ReactNode;
  if (tab === "fotos") {
    const { photos, truncated } = await loadSessionPhotos(session.id);
    const folders = await loadSessionFolders(session.id, photos);
    const mine = await listMyFavorites(session.id);
    content = (
      <div className="flex flex-col gap-5">
        <SessionFolders sessionId={session.id} folders={folders} canEdit={canEdit} />
        <SessionGallery
          mode="admin"
          session={{ id: session.id, name: session.name, downloadMode: session.downloadMode, coverAssetId: session.coverAssetId }}
          initialPhotos={photos}
          truncated={truncated}
          folders={folders}
          moveTargets={allSessions.filter((s) => s.id !== session.id).map((s) => ({ id: s.id, name: s.name }))}
          can={{ edit: canEdit, publish: canPublish }}
          canVault={canVault}
          initialFavorites={mine.ok && mine.data ? mine.data : []}
          initialPhotoId={isUuid(query.foto) ? query.foto : null}
          pathname={base}
        />
      </div>
    );
  } else if (tab === "material") {
    const material = await loadSessionMaterial(session.id);
    content =
      material.length === 0 ? (
        <EmptyState icon={<ImageIcon size={22} />} title="Sin vídeos ni material" description="Los vídeos y documentos que subas a esta sesión aparecerán aquí. Pulsa un vídeo para abrir el reproductor." />
      ) : (
        <DataList>
          {material.map((item) => (
            <Link key={item.id} href={`/archivo/${item.id}`} className="block">
              <DataRow
                title={item.title}
                subtitle={`${item.kind === "video" ? "Vídeo" : item.kind === "audio" ? "Audio" : "Archivo"} · ${formatBytes(item.sizeBytes)}`}
                trailing={item.visibility === "published" ? <Badge variant="neutral">Visible para el artista</Badge> : <Badge variant="outline">Pendiente de publicar</Badge>}
              />
            </Link>
          ))}
        </DataList>
      );
  } else if (tab === "favoritas") {
    const res = await listSessionFavorites(session.id);
    content = <FavoritesPanel entries={res.ok && res.data ? res.data : []} sessionName={session.name} />;
  } else {
    const access = await loadAccessPanelData({ resourceType: "session", resourceId: session.id, actor, role });
    content = (
      <AccessPanel
        artistId={session.id}
        resourceType="session"
        showTeam={false}
        allowUpload={false}
        members={[]}
        grants={access.grants}
        recipients={access.recipients}
        roles={[]}
        canInvite={false}
      />
    );
  }

  const portalPath = mainArtist ? `/espacio/${mainArtist.slug}/sesiones/${session.id}` : null;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="mb-1 text-label text-text-3">
            <Link href="/sesiones" className="rounded-control transition-colors duration-150 ease-ui hover:text-text">
              Sesiones
            </Link>
          </p>
          <h1 className="text-title text-text">{session.name}</h1>
          <p className="mt-2 text-body text-text-2">
            {names.get(session.artistId) ?? "Artista"}
            {participantIds.length > 0 ? ` + ${participantIds.map((p) => names.get(p) ?? "").filter(Boolean).join(", ")}` : ""}
            {session.date ? ` · ${dayFormat.format(new Date(`${session.date}T12:00:00`))}` : ""} · {photoCount} {photoCount === 1 ? "foto" : "fotos"}
            {otherCount > 0 ? ` · ${otherCount} ${otherCount === 1 ? "archivo más" : "archivos más"}` : ""}
          </p>
          {session.description ? <p className="mt-2 max-w-2xl text-body text-text-2">{session.description}</p> : null}
          <p className="mt-3">
            <Badge variant={session.downloadMode === "off" ? "outline" : "neutral"}>Descarga: {DOWNLOAD_MODE_LABEL[session.downloadMode]}</Badge>
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {canEdit ? (
            <ButtonLink size="sm" href={`/subir?sesion=${session.id}`}>
              Subir
            </ButtonLink>
          ) : null}
          {portalPath ? <CopyLinkButton path={portalPath} label="Enlace del portal" /> : null}
          {canPublish ? <ShareButton target={{ kind: "session", id: session.id }} defaultTitle={session.name} /> : null}
          {canEdit ? (
            <SessionFormDialog
              trigger="edit"
              artists={artists.filter((a) => a.status === "active").map((a) => ({ id: a.id, name: a.name }))}
              canChangeMode={canPublish}
              initial={{
                id: session.id,
                name: session.name,
                date: session.date ?? "",
                description: session.description ?? "",
                artistId: session.artistId,
                participantIds,
                downloadMode: session.downloadMode,
              }}
            />
          ) : null}
        </div>
      </header>

      <TabNav label={`Secciones de ${session.name}`} items={available.map((t) => ({ href: href(t.key), label: t.label }))} current={href(tab)} className="overflow-x-auto overflow-y-hidden" />

      {content}
    </div>
  );
}
