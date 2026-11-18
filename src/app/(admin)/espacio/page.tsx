import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ArtistsView, type ArtistCardData } from "@/components/artist/ArtistsView";
import { FolderIcon } from "@/components/icons";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireActor } from "@/lib/auth/session";
import { EMPTY_SUMMARY, loadSummaries, loadVisibleArtists } from "@/lib/artists/data";
import { hasAdminShell } from "@/lib/permissions/portal";
import { getEffectiveRole } from "@/lib/permissions/server";

export const metadata: Metadata = { title: "Mi espacio" };
export const dynamic = "force-dynamic";

export default async function EspacioPage() {
  await requireActor();
  const role = await getEffectiveRole();
  if (!role) notFound();
  // El personal de administración trabaja desde Proyectos
  if (hasAdminShell(role.permissions)) redirect("/artistas");

  // Solo los artistas que RLS deja ver a esta persona y que no están archivados
  const canView = ["photos.view", "videos.view", "files.view", "beats.view"].some((k) => role.permissions.has(k));
  const artists = canView ? (await loadVisibleArtists()).filter((a) => a.status === "active") : [];

  // Un solo espacio: se entra directamente
  if (artists.length === 1 && artists[0]) redirect(`/espacio/${artists[0].slug}`);

  const summaries = artists.length > 0 ? await loadSummaries() : new Map();
  const cards: ArtistCardData[] = artists.map((a) => ({
    id: a.id,
    name: a.name,
    slug: a.slug,
    status: a.status,
    avatarAssetId: a.avatarAssetId,
    summary: summaries.get(a.id) ?? EMPTY_SUMMARY,
  }));

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Mi espacio" description="Elige el espacio al que quieres entrar." />
      {cards.length === 0 ? (
        <EmptyState
          icon={<FolderIcon size={22} />}
          title="Todavía no tienes ningún espacio"
          description="Cuando te den acceso a un artista, aparecerá aquí."
        />
      ) : (
        <ArtistsView artists={cards} basePath="/espacio" showPending={false} />
      )}
    </div>
  );
}
