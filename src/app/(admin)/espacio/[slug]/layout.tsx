import { notFound } from "next/navigation";
import { getThumbUrls } from "@/app/actions/browse";
import { PathTabNav } from "@/components/layout/PathTabNav";
import { Avatar } from "@/components/ui/Avatar";
import { getPortalContext } from "@/lib/artists/portal";

export default async function EspacioArtistaLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { artist, areas } = await getPortalContext(slug);
  if (!Object.values(areas).some(Boolean)) notFound();

  const thumb = artist.avatarAssetId ? await getThumbUrls([artist.avatarAssetId]) : null;
  const avatarUrl = thumb?.ok && thumb.data ? thumb.data[artist.avatarAssetId ?? ""] : undefined;

  const base = `/espacio/${artist.slug}`;
  const items = [
    { href: base, label: "Resumen" },
    ...(areas.photos ? [{ href: `${base}/sesiones`, label: "Sesiones" }, { href: `${base}/fotos`, label: "Fotos" }] : []),
    ...(areas.videos ? [{ href: `${base}/videos`, label: "Vídeos" }] : []),
    ...(areas.files ? [{ href: `${base}/archivos`, label: "Archivos" }] : []),
    ...(areas.beats ? [{ href: `${base}/beats`, label: "Beats" }] : []),
  ];

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center gap-4">
        <Avatar name={artist.name} imageUrl={avatarUrl} size="xl" />
        <div className="min-w-0">
          <p className="text-label text-text-3">Tu espacio</p>
          <p className="truncate text-subtitle text-text">{artist.name}</p>
        </div>
      </div>
      <PathTabNav label={`Secciones de ${artist.name}`} items={items} className="overflow-x-auto overflow-y-hidden" />
      {children}
    </div>
  );
}
