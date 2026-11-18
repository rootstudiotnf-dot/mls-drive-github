import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getThumbUrls } from "@/app/actions/browse";
import { ArtistSettings } from "@/components/artist/ArtistSettings";
import { PageHeader } from "@/components/ui/PageHeader";
import { loadArtistBySlug } from "@/lib/artists/data";
import { requirePagePermission } from "@/lib/permissions/server";

export const metadata: Metadata = { title: "Ajustes del artista" };
export const dynamic = "force-dynamic";

export default async function AjustesArtistaPage({ params }: { params: Promise<{ slug: string }> }) {
  // Solo con artists.manage (si no, 404). Los slugs son presentación: todo lo demás va por id.
  await requirePagePermission("artists.manage");
  const { slug } = await params;
  const artist = await loadArtistBySlug(slug);
  if (!artist) notFound();

  const thumb = artist.avatarAssetId ? await getThumbUrls([artist.avatarAssetId]) : null;
  const avatarUrl = thumb?.ok && thumb.data ? thumb.data[artist.avatarAssetId ?? ""] : undefined;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow={artist.name}
        title="Ajustes del artista"
        actions={
          <Link href={`/artistas/${artist.slug}`} className="rounded-control text-label font-medium text-text-2 transition-colors duration-150 ease-ui hover:text-text">
            Volver al espacio
          </Link>
        }
      />
      <ArtistSettings
        artistId={artist.id}
        name={artist.name}
        bio={artist.bio ?? ""}
        archived={artist.status === "archived"}
        avatarUrl={avatarUrl}
        hasAvatar={artist.avatarAssetId !== null}
      />
    </div>
  );
}
