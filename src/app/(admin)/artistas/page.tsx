import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArtistsView, type ArtistCardData } from "@/components/artist/ArtistsView";
import { NewArtistDialog } from "@/components/artist/NewArtistDialog";
import { FolderIcon, SearchIcon } from "@/components/icons";
import { Chip } from "@/components/ui/Chip";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { EMPTY_SUMMARY, loadSummaries, loadVisibleArtists } from "@/lib/artists/data";
import { ADMIN_SHELL_PERMISSIONS } from "@/lib/permissions/portal";
import { getEffectiveRole, requirePagePermission } from "@/lib/permissions/server";

export const metadata: Metadata = { title: "Proyectos" };
export const dynamic = "force-dynamic";

const FILTERS = [
  { value: "todos", label: "Todos" },
  { value: "activos", label: "Activos" },
  { value: "archivados", label: "Archivados" },
] as const;

type Filter = (typeof FILTERS)[number]["value"];

export default async function ArtistasPage({
  searchParams,
}: {
  searchParams: Promise<{ estado?: string; q?: string }>;
}) {
  // Barrera de servidor: shell de administración y permiso de ver artistas (si no, 404).
  await requirePagePermission(...ADMIN_SHELL_PERMISSIONS);
  const role = await getEffectiveRole();
  const canView = ["photos.view", "videos.view", "files.view"].some((k) => role?.permissions.has(k));
  if (!role || !canView) notFound();

  const params = await searchParams;
  const estado: Filter = FILTERS.some((f) => f.value === params.estado) ? (params.estado as Filter) : "todos";
  const q = (params.q ?? "").trim().slice(0, 60);

  // Lecturas bajo RLS: solo llegan los artistas (y sus resúmenes) que este usuario puede ver
  const [artists, summaries] = await Promise.all([loadVisibleArtists(), loadSummaries()]);

  const needle = q.toLocaleLowerCase("es");
  const cards: ArtistCardData[] = artists
    .filter((a) => (estado === "activos" ? a.status === "active" : estado === "archivados" ? a.status === "archived" : true))
    .filter((a) => !needle || a.name.toLocaleLowerCase("es").includes(needle))
    .map((a) => ({
      id: a.id,
      name: a.name,
      slug: a.slug,
      status: a.status,
      avatarAssetId: a.avatarAssetId,
      summary: summaries.get(a.id) ?? EMPTY_SUMMARY,
    }));

  const href = (value: Filter) => {
    const query = new URLSearchParams();
    if (value !== "todos") query.set("estado", value);
    if (q) query.set("q", q);
    const s = query.toString();
    return s ? `/artistas?${s}` : "/artistas";
  };

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Proyectos"
        description="Cada artista es un espacio con sus carpetas, su equipo y lo que se publica para él."
        actions={role.permissions.has("artists.manage") ? <NewArtistDialog /> : null}
      />

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrar por estado">
          {FILTERS.map((f) => (
            <Chip key={f.value} href={href(f.value)} selected={estado === f.value}>
              {f.label}
            </Chip>
          ))}
        </div>
        <form role="search" method="get" action="/artistas" className="relative w-full sm:w-72">
          {estado !== "todos" ? <input type="hidden" name="estado" value={estado} /> : null}
          <SearchIcon size={16} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-text-3" />
          <input
            type="search"
            name="q"
            defaultValue={q}
            aria-label="Buscar artistas"
            placeholder="Buscar artistas"
            className="h-10 w-full rounded-pill border border-line bg-surface pr-4 pl-10 text-body text-text placeholder:text-text-3 transition-colors duration-150 ease-ui hover:border-line-hover focus-visible:border-line-hover"
          />
        </form>
      </div>

      {cards.length === 0 ? (
        <EmptyState
          icon={<FolderIcon size={22} />}
          title={artists.length === 0 ? "Aún no hay artistas" : "No hay artistas con ese filtro"}
          description={
            artists.length === 0
              ? "Crea el primero y se generarán sus carpetas base."
              : "Prueba con otra búsqueda o cambia el filtro de estado."
          }
          action={artists.length === 0 && role.permissions.has("artists.manage") ? <NewArtistDialog /> : undefined}
        />
      ) : (
        <ArtistsView artists={cards} />
      )}
    </div>
  );
}
