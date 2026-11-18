import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { listBeats } from "@/app/actions/beats";
import { BeatCatalog } from "@/components/beats/BeatCatalog";
import { PageHeader } from "@/components/ui/PageHeader";
import { loadGenres } from "@/lib/beats/data";
import { filtersFromParams } from "@/lib/beats/types";
import { getPortalContext } from "@/lib/artists/portal";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Beats" };
export const dynamic = "force-dynamic";

/**
 * Beats del artista: solo los PUBLICADOS y compartidos con él (lo decide la base de datos con `can_access`, no esta
 * página). Se puede escuchar siempre; el botón de descarga solo aparece si las tres capas lo permiten.
 */
export default async function PortalBeatsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const { artist, areas } = await getPortalContext(slug);
  if (!areas.beats) notFound();

  // En el portal el filtro de artista lo fija el espacio; el estado no se elige (solo hay publicados)
  const filters = { ...filtersFromParams(await searchParams), artist: artist.id, status: undefined };
  const supabase = await createClient();
  const [first, genres, tags] = await Promise.all([
    listBeats({ filters }),
    loadGenres(),
    supabase.from("tags").select("id, name").order("name").limit(300),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Beats" description="Los beats que se han compartido contigo. Pulsa para escuchar." />
      <BeatCatalog
        mode="portal"
        basePath={`/espacio/${encodeURIComponent(slug)}/beats`}
        initialFilters={filters}
        initialPage={first.ok && first.data ? first.data : { items: [], nextCursor: null }}
        genres={genres.map((g) => ({ id: g.id, name: g.name }))}
        tags={((tags.data ?? []) as { id: string; name: string }[]).map((t) => ({ id: t.id, name: t.name }))}
        artists={[]}
      />
    </div>
  );
}
