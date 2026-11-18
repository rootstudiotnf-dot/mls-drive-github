import type { Metadata } from "next";
import Link from "next/link";
import { getThumbUrls, listArtistAssets } from "@/app/actions/browse";
import { ImageIcon, PlayIcon } from "@/components/icons";
import { EmptyState } from "@/components/ui/EmptyState";
import { FolderCard } from "@/components/ui/FolderCard";
import { PageHeader } from "@/components/ui/PageHeader";
import { PhotoTile } from "@/components/ui/PhotoTile";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { TextLink } from "@/components/ui/TextLink";
import { getPortalContext } from "@/lib/artists/portal";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Mi espacio" };
export const dynamic = "force-dynamic";

const TIME_ZONE = "Atlantic/Canary";

function greeting(now: Date) {
  const hour =
    Number(new Intl.DateTimeFormat("es-ES", { hour: "numeric", hourCycle: "h23", timeZone: TIME_ZONE }).format(now)) % 24;
  if (hour < 6) return "Buenas noches";
  if (hour < 13) return "Buenos días";
  if (hour < 21) return "Buenas tardes";
  return "Buenas noches";
}

const dayFormat = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "long", year: "numeric", timeZone: TIME_ZONE });

type SessionRow = { id: string; name: string; date: string | null; description: string | null };

export default async function PortalHomePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { actor, artist, areas } = await getPortalContext(slug);
  const base = `/espacio/${artist.slug}`;
  const firstName = actor.displayName.split(" ")[0] ?? actor.displayName;
  const now = new Date();

  // Todo bajo RLS: solo llega lo publicado (o lo propio) y a lo que esta persona puede acceder
  const supabase = await createClient();
  const [photosRes, videosRes, sessionsRes] = await Promise.all([
    areas.photos ? listArtistAssets({ artistId: artist.id, tab: "photos", portal: true }) : null,
    areas.videos ? listArtistAssets({ artistId: artist.id, tab: "videos", portal: true }) : null,
    supabase
      .from("sessions")
      .select("id, name, date, description")
      .eq("artist_id", artist.id)
      .is("deleted_at", null)
      .order("date", { ascending: false, nullsFirst: false })
      .limit(12),
  ]);
  const photos = (photosRes?.ok && photosRes.data ? photosRes.data.items : []).slice(0, 8);
  const videos = (videosRes?.ok && videosRes.data ? videosRes.data.items : []).slice(0, 4);
  const sessions = (sessionsRes.data ?? []) as unknown as SessionRow[];
  const featured = sessions[0];

  const thumbs = await getThumbUrls(photos.map((p) => p.id));
  const urls = thumbs.ok && thumbs.data ? thumbs.data : {};

  return (
    <div className="flex flex-col gap-12">
      <PageHeader
        eyebrow={new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", month: "long", timeZone: TIME_ZONE }).format(now)}
        title={`${greeting(now)}, ${firstName}`}
        description={artist.bio ?? undefined}
      />

      {featured ? (
        <section aria-label="Sesión destacada">
          <SectionHeader title="Sesión destacada" />
          <div className="rounded-card border border-line bg-surface p-6">
            <p className="text-subtitle text-text">{featured.name}</p>
            {featured.date ? <p className="mt-1 text-label text-text-2">{dayFormat.format(new Date(`${featured.date}T12:00:00`))}</p> : null}
            {featured.description ? <p className="mt-3 max-w-2xl text-body text-text-2">{featured.description}</p> : null}
          </div>
        </section>
      ) : null}

      {areas.photos ? (
        <section aria-label="Últimas fotos">
          <SectionHeader title="Últimas fotos" action={<TextLink href={`${base}/fotos`}>Ver todas</TextLink>} />
          {photos.length === 0 ? (
            <EmptyState icon={<ImageIcon size={22} />} title="Todavía no hay fotos" description="Cuando se publiquen fotos para ti, las verás aquí." />
          ) : (
            <ul className="grid grid-cols-2 gap-x-4 gap-y-8 md:grid-cols-3 wide:grid-cols-4">
              {photos.map((photo) => (
                <li key={photo.id}>
                  <Link href={`${base}/fotos`} className="block rounded-card">
                    <PhotoTile tone={((photo.id.charCodeAt(0) % 5) + 1) as 1 | 2 | 3 | 4 | 5} imageUrl={urls[photo.id]} title={photo.title} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {sessions.length > 0 ? (
        <section aria-label="Tus sesiones">
          <SectionHeader title="Tus sesiones" action={areas.photos ? <TextLink href={`${base}/sesiones`}>Ver todas</TextLink> : undefined} />
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 wide:grid-cols-3">
            {sessions.map((session) => (
              <li key={session.id}>
                <FolderCard
                  href={areas.photos ? `${base}/sesiones/${session.id}` : undefined}
                  name={session.name}
                  meta={session.date ? dayFormat.format(new Date(`${session.date}T12:00:00`)) : "Sin fecha"}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {areas.videos && videos.length > 0 ? (
        <section aria-label="Vídeos recientes">
          <SectionHeader title="Vídeos" action={<TextLink href={`${base}/videos`}>Ver todos</TextLink>} />
          <ul className="grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 wide:grid-cols-3">
            {videos.map((video) => (
              <li key={video.id}>
                <PhotoTile
                  ratio="16/9"
                  tone={((video.id.charCodeAt(0) % 5) + 1) as 1 | 2 | 3 | 4 | 5}
                  icon={<PlayIcon size={26} className="text-text-3" />}
                  title={video.title}
                  href={`${base}/videos`}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
