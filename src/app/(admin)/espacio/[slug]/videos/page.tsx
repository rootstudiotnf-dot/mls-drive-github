import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PortalAssets } from "@/components/artist/PortalAssets";
import { getPortalContext } from "@/lib/artists/portal";

export const metadata: Metadata = { title: "Vídeos" };
export const dynamic = "force-dynamic";

export default async function PortalVideosPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { artist, areas } = await getPortalContext(slug);
  // Sin permiso para ver esta área, la ruta no existe (404)
  if (!areas.videos) notFound();

  return (
    <PortalAssets
      artistId={artist.id}
      tab="videos"
      title="Vídeos"
      emptyTitle="Todavía no hay vídeos"
      emptyHint="Cuando se publiquen vídeos para ti, los verás aquí."
      videoBasePath={`/espacio/${artist.slug}/videos`}
    />
  );
}
