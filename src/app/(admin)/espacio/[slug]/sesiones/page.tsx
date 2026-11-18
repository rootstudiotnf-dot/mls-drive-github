import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getThumbUrls } from "@/app/actions/browse";
import { ImageIcon } from "@/components/icons";
import { SessionTiles, type SessionTileData } from "@/components/session/SessionTiles";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { getPortalContext } from "@/lib/artists/portal";
import { loadArtistNames, loadParticipants, loadSessionCounts, loadSessions } from "@/lib/sessions/data";

export const metadata: Metadata = { title: "Sesiones" };
export const dynamic = "force-dynamic";

const dayFormat = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", year: "numeric", timeZone: "Atlantic/Canary" });

export default async function PortalSesionesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { artist, areas } = await getPortalContext(slug);
  if (!areas.photos) notFound();

  // Bajo RLS: las sesiones de este artista y aquellas en las que participa
  const all = await loadSessions();
  const participants = await loadParticipants(all.map((s) => s.id));
  const sessions = all.filter((s) => s.artistId === artist.id || (participants.get(s.id) ?? []).includes(artist.id));
  const [counts, names] = await Promise.all([loadSessionCounts(), loadArtistNames(sessions.map((s) => s.artistId))]);
  const covers = await getThumbUrls(sessions.map((s) => s.coverAssetId).filter((v): v is string => !!v).slice(0, 50));
  const coverUrls = covers.ok && covers.data ? covers.data : {};

  const tiles: SessionTileData[] = sessions.map((s) => {
    const photos = counts.get(s.id)?.photos ?? 0;
    const meta = [
      s.artistId === artist.id ? null : `con ${names.get(s.artistId) ?? "otro artista"}`,
      `${photos} ${photos === 1 ? "foto" : "fotos"}`,
      s.date ? dayFormat.format(new Date(`${s.date}T12:00:00`)) : null,
    ].filter(Boolean);
    return {
      id: s.id,
      name: s.name,
      href: `/espacio/${artist.slug}/sesiones/${s.id}`,
      meta: meta.join(" · "),
      coverUrl: s.coverAssetId ? coverUrls[s.coverAssetId] : undefined,
    };
  });

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Sesiones" description="Tus sesiones de fotos: míralas, marca tus favoritas y descárgalas." />
      {tiles.length === 0 ? (
        <EmptyState icon={<ImageIcon size={22} />} title="Todavía no hay sesiones" description="Cuando se publique una sesión para ti, aparecerá aquí." />
      ) : (
        <SessionTiles sessions={tiles} />
      )}
    </div>
  );
}
