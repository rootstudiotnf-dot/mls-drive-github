import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { listMyFavorites } from "@/app/actions/sessions";
import { SessionGallery } from "@/components/gallery/SessionGallery";
import { getPortalContext } from "@/lib/artists/portal";
import { loadArtistNames, loadParticipants, loadSession, loadSessionPhotos } from "@/lib/sessions/data";
import { isUuid } from "@/lib/storage/keys";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Sesión" };

const dayFormat = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "long", year: "numeric", timeZone: "Atlantic/Canary" });

export default async function PortalSesionPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<{ foto?: string }>;
}) {
  const { slug, id } = await params;
  const query = await searchParams;
  const { actor, artist, areas } = await getPortalContext(slug);
  if (!areas.photos) notFound();

  // Sesión bajo RLS (incluye a los artistas participantes). Sin acceso, o de otro artista: 404.
  const session = await loadSession(id);
  if (!session) notFound();
  const participants = (await loadParticipants([session.id])).get(session.id) ?? [];
  if (session.artistId !== artist.id && !participants.includes(artist.id)) notFound();

  // Solo lo publicado (o lo que subió esta persona)
  const { photos, truncated } = await loadSessionPhotos(session.id, { portalFor: actor.id });
  const mine = await listMyFavorites(session.id);
  const names = await loadArtistNames([session.artistId, ...participants]);
  const others = [session.artistId, ...participants].filter((a) => a !== artist.id).map((a) => names.get(a)).filter(Boolean);
  const base = `/espacio/${artist.slug}/sesiones/${session.id}`;

  return (
    <div className="flex flex-col gap-8">
      <header>
        <p className="mb-1 text-label text-text-3">
          <Link href={`/espacio/${artist.slug}/sesiones`} className="rounded-control transition-colors duration-150 ease-ui hover:text-text">
            Sesiones
          </Link>
        </p>
        <h1 className="text-title text-text">{session.name}</h1>
        <p className="mt-2 text-body text-text-2">
          {[session.date ? dayFormat.format(new Date(`${session.date}T12:00:00`)) : null, others.length > 0 ? `con ${others.join(", ")}` : null, `${photos.length} ${photos.length === 1 ? "foto" : "fotos"}`]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {session.description ? <p className="mt-2 max-w-2xl text-body text-text-2">{session.description}</p> : null}
      </header>

      <SessionGallery
        mode="portal"
        session={{ id: session.id, name: session.name, downloadMode: session.downloadMode, coverAssetId: session.coverAssetId }}
        initialPhotos={photos}
        truncated={truncated}
        folders={[]}
        moveTargets={[]}
        can={{ edit: false, publish: false }}
        initialFavorites={mine.ok && mine.data ? mine.data : []}
        initialPhotoId={isUuid(query.foto) ? query.foto : null}
        pathname={base}
      />
    </div>
  );
}
