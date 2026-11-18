import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { VideoReview } from "@/components/video/VideoReview";
import { getPortalContext } from "@/lib/artists/portal";
import { can } from "@/lib/permissions/server";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/storage/keys";
import { loadVideoStates } from "@/lib/video/jobs";

export const metadata: Metadata = { title: "Vídeo" };
export const dynamic = "force-dynamic";

export default async function PortalVideoPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const { actor, artist, areas } = await getPortalContext(slug);
  if (!areas.videos || !isUuid(id)) notFound();

  // Lectura bajo RLS: solo lo publicado (o propio) de este artista; sin acceso, 404 (nunca 403)
  const supabase = await createClient();
  const { data } = await supabase
    .from("assets")
    .select("id, title, original_filename, artist_id, meta, status")
    .eq("id", id)
    .eq("kind", "video")
    .eq("artist_id", artist.id)
    .eq("status", "ready")
    .is("deleted_at", null)
    .maybeSingle();
  const asset = data as { id: string; title: string | null; original_filename: string; meta: { fps?: number | null } | null } | null;
  if (!asset) notFound();

  const [states, canDownload] = await Promise.all([loadVideoStates([asset.id]), can(actor.id, "download", { type: "asset", id: asset.id })]);
  const title = asset.title ?? asset.original_filename;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="mb-1 text-label text-text-3">
          <Link href={`/espacio/${artist.slug}/videos`} className="rounded-control transition-colors duration-150 ease-ui hover:text-text">
            Vídeos
          </Link>
        </p>
        <h1 className="text-title text-text">{title}</h1>
      </header>
      <VideoReview
        assetId={asset.id}
        title={title}
        initialState={states.get(asset.id) ?? { status: "none", error: null }}
        fps={asset.meta?.fps ?? null}
        canOriginal={canDownload}
        canReprocess={false}
      />
    </div>
  );
}
