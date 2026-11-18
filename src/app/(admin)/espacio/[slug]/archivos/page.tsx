import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PortalAssets } from "@/components/artist/PortalAssets";
import { getPortalContext } from "@/lib/artists/portal";

export const metadata: Metadata = { title: "Archivos" };
export const dynamic = "force-dynamic";

export default async function PortalArchivosPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { artist, areas } = await getPortalContext(slug);
  // Sin permiso para ver esta área, la ruta no existe (404)
  if (!areas.files) notFound();

  return (
    <PortalAssets
      artistId={artist.id}
      tab="files"
      title="Archivos"
      emptyTitle="Todavía no hay archivos"
      emptyHint="Cuando se publiquen archivos para ti, los verás aquí."
    />
  );
}
