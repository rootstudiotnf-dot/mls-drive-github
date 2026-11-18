import { hasVaultEntitlement } from "@/lib/vault/access";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { listArtistActivity, listArtistAssets, listTrash, getThumbUrls, type AssetTab } from "@/app/actions/browse";
import { AccessPanel } from "@/components/artist/AccessPanel";
import { ActivityFeed } from "@/components/artist/ActivityFeed";
import { AssetBrowser, type FolderOption } from "@/components/artist/AssetBrowser";
import { FolderPanel } from "@/components/artist/FolderPanel";
import { TrashPanel } from "@/components/artist/TrashPanel";
import { MusicIcon } from "@/components/icons";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/ButtonLink";
import { Chip } from "@/components/ui/Chip";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { TabNav } from "@/components/ui/TabNav";
import { loadAccessPanelData } from "@/lib/access/panel-data";
import { loadArtistBySlug, loadFolderTree, loadSummary, loadVisibleArtists } from "@/lib/artists/data";
import { ADMIN_SHELL_PERMISSIONS } from "@/lib/permissions/portal";
import { getEffectiveRole, requirePagePermission } from "@/lib/permissions/server";
import { isUuid } from "@/lib/storage/keys";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const artist = await loadArtistBySlug(slug).catch(() => null);
  return { title: artist?.name ?? "Artista" };
}

const TAB_KEYS = ["todo", "fotos", "videos", "archivos", "beats", "accesos", "actividad", "papelera"] as const;
type TabKey = (typeof TAB_KEYS)[number];

const BROWSE_TAB: Partial<Record<TabKey, AssetTab>> = { todo: "todo", fotos: "photos", videos: "videos", archivos: "files" };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export default async function ArtistaPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ tab?: string; carpeta?: string }>;
}) {
  // Primera barrera: shell de administración. Quien no la tenga ve un 404 (el portal tiene su propia ruta).
  const actor = await requirePagePermission(...ADMIN_SHELL_PERMISSIONS);
  const role = await getEffectiveRole();
  if (!role) notFound();

  const { slug } = await params;
  const query = await searchParams;

  // Lectura bajo RLS: si no hay acceso al artista, es como si no existiera (404, nunca 403)
  const artist = await loadArtistBySlug(slug);
  if (!artist) notFound();

  const has = (key: string) => role.permissions.has(key);
  const canView = ["photos", "videos", "files"].some((a) => has(`${a}.view`));
  if (!canView) notFound();

  const canPublish = ["photos", "videos", "files"].some((a) => has(`${a}.publish`));
  const canEdit = ["photos", "videos", "files"].some((a) => has(`${a}.edit`));
  // Cosmética: «Mover al Vault» solo para quien tiene acceso real al Vault y puede subir a él
  const canVault = canEdit && has("vault.upload") && (await hasVaultEntitlement(actor));
  const canAccess = has("access.manage");
  const canManageArtist = has("artists.manage");

  const available: { key: TabKey; label: string }[] = [
    { key: "todo", label: "Todo" },
    ...(has("photos.view") ? [{ key: "fotos" as const, label: "Fotos" }] : []),
    ...(has("videos.view") ? [{ key: "videos" as const, label: "Vídeos" }] : []),
    ...(has("files.view") ? [{ key: "archivos" as const, label: "Archivos" }] : []),
    ...(has("beats.view") ? [{ key: "beats" as const, label: "Beats" }] : []),
    ...(canAccess ? [{ key: "accesos" as const, label: "Accesos" }, { key: "actividad" as const, label: "Actividad" }] : []),
    ...(canEdit ? [{ key: "papelera" as const, label: "Papelera" }] : []),
  ];
  const requested = TAB_KEYS.find((t) => t === query.tab) ?? "todo";
  const tab: TabKey = available.some((t) => t.key === requested) ? requested : "todo";
  const folderId = isUuid(query.carpeta) ? query.carpeta : null;

  const base = `/artistas/${artist.slug}`;
  const href = (key: TabKey) => (key === "todo" ? base : `${base}?tab=${key}`);

  const [summary, folderTree, avatarThumb] = await Promise.all([
    loadSummary(artist.id),
    loadFolderTree(artist.id),
    artist.avatarAssetId ? getThumbUrls([artist.avatarAssetId]) : Promise.resolve(null),
  ]);
  const avatarUrl = avatarThumb?.ok && avatarThumb.data ? avatarThumb.data[artist.avatarAssetId ?? ""] : undefined;

  const summaryParts = [
    plural(summary.photos, "foto", "fotos"),
    plural(summary.videos, "vídeo", "vídeos"),
    ...(summary.files > 0 ? [plural(summary.files, "archivo", "archivos")] : []),
    plural(summary.members, "persona en el equipo", "personas en el equipo"),
  ];

  // --- Contenido de la pestaña ------------------------------------------------------------------
  let content: React.ReactNode;
  const browseTab = BROWSE_TAB[tab];

  if (browseTab) {
    const [first, artists] = await Promise.all([
      listArtistAssets({ artistId: artist.id, tab: browseTab, folderId }),
      canEdit ? loadVisibleArtists() : Promise.resolve([]),
    ]);
    const initial = first.ok && first.data ? first.data : { items: [], nextCursor: null };
    const folderOptions: FolderOption[] = folderTree.map((f) => ({ id: f.id, label: `${"— ".repeat(f.depth)}${f.name}`, kind: f.kind }));
    const kindOfTab = tab === "fotos" ? "photos" : tab === "videos" ? "videos" : tab === "archivos" ? "files" : null;
    const filterFolders = kindOfTab ? folderTree.filter((f) => f.kind === kindOfTab || f.kind === "general") : [];
    const current = folderTree.find((f) => f.id === folderId);

    content = (
      <div className="flex flex-col gap-10">
        {tab === "todo" ? <FolderPanel slug={artist.slug} folders={folderTree} canManage={canEdit} /> : null}

        {kindOfTab && filterFolders.length > 0 ? (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrar por carpeta">
            <Chip href={href(tab)} selected={!folderId}>
              Todas
            </Chip>
            {filterFolders.map((f) => (
              <Chip key={f.id} href={`${href(tab)}&carpeta=${f.id}`} selected={folderId === f.id}>
                {f.name}
              </Chip>
            ))}
          </div>
        ) : null}

        <div>
          {tab === "todo" ? <SectionHeader title="Subido recientemente" /> : null}
          <AssetBrowser
            // Al cambiar de pestaña o carpeta se recrea el estado (lista, cursor, selección)
            key={`${tab}:${folderId ?? ""}`}
            mode="admin"
            artistId={artist.id}
            tab={browseTab}
            folderId={folderId}
            initial={initial}
            folders={folderOptions}
            artists={artists.filter((a) => a.status === "active").map((a) => ({ id: a.id, name: a.name }))}
            can={{ publish: canPublish, edit: canEdit }}
            canVault={canVault}
            title={current ? current.name : tab === "todo" ? undefined : available.find((t) => t.key === tab)?.label}
            emptyTitle={tab === "todo" ? "Este espacio aún está vacío" : "Aún no hay nada aquí"}
            emptyHint="Sube archivos desde «Subir» y aparecerán aquí, pendientes de publicar."
          />
        </div>
      </div>
    );
  } else if (tab === "beats") {
    content = (
      <EmptyState
        icon={<MusicIcon size={22} />}
        title="Los beats llegan más adelante"
        description={
          summary.beatsShared > 0
            ? `Hay ${plural(summary.beatsShared, "beat compartido", "beats compartidos")} con este artista. Su ficha completa se añadirá en una próxima fase.`
            : "Aquí aparecerán los beats compartidos con este artista."
        }
      />
    );
  } else if (tab === "accesos") {
    const access = await loadAccessPanelData({ resourceType: "artist", resourceId: artist.id, artistIdForTeam: artist.id, actor, role });
    const { members, grants, recipients, roles } = access;

    content = (
      <AccessPanel
        artistId={artist.id}
        members={members}
        grants={grants}
        recipients={recipients}
        roles={roles}
        canInvite={has("users.invite")}
      />
    );
  } else if (tab === "actividad") {
    const res = await listArtistActivity({ artistId: artist.id });
    const page = res.ok && res.data ? res.data : { items: [], nextCursor: null };
    content = <ActivityFeed artistId={artist.id} initial={page.items} initialCursor={page.nextCursor} />;
  } else {
    const res = await listTrash(artist.id);
    content = <TrashPanel items={res.ok && res.data ? res.data : []} />;
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <Avatar name={artist.name} imageUrl={avatarUrl} size="xl" />
          <div className="min-w-0">
            <p className="mb-1 text-label text-text-3">
              <Link href="/artistas" className="rounded-control transition-colors duration-150 ease-ui hover:text-text">
                Proyectos
              </Link>
            </p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="text-title text-text">{artist.name}</h1>
              {artist.status === "archived" ? <Badge variant="outline">Archivado</Badge> : null}
              {summary.pending > 0 ? <Badge variant="solid">{plural(summary.pending, "pendiente", "pendientes")}</Badge> : null}
            </div>
            <p className="mt-1.5 text-body text-text-2">{summaryParts.join(" · ")}</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          {canManageArtist ? (
            <ButtonLink variant="ghost" size="sm" href={`${base}/ajustes`}>
              Ajustes
            </ButtonLink>
          ) : null}
          {["photos", "videos", "files"].some((a) => has(`${a}.upload`)) ? (
            <ButtonLink size="sm" href={`/subir?artista=${artist.id}`}>
              Subir archivos
            </ButtonLink>
          ) : null}
        </div>
      </header>

      {artist.bio ? <p className="max-w-2xl text-body text-text-2">{artist.bio}</p> : null}

      <TabNav
        label={`Secciones de ${artist.name}`}
        items={available.map((t) => ({ href: href(t.key), label: t.label }))}
        current={href(tab)}
        className="overflow-x-auto overflow-y-hidden"
      />

      {content}
    </div>
  );
}
