import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PortalAssets } from "@/components/artist/PortalAssets";
import { getPortalContext } from "@/lib/artists/portal";

export const metadata: Metadata = { title: "Fotos" };
export const dynamic = "force-dynamic";

export default async function PortalFotosPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { artist, areas } = await getPortalContext(slug);
  // Sin permiso para ver esta área, la ruta no existe (404)
  if (!areas.photos) notFound();

  return (
    <PortalAssets
      artistId={artist.id}
      tab="photos"
      title="Fotos"
      emptyTitle="Todavía no hay fotos"
      emptyHint="Cuando se publiquen fotos para ti, las verás aquí."
    />
  );
}
