import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getThumbUrls } from "@/app/actions/browse";
import { ImageIcon, SearchIcon } from "@/components/icons";
import { SessionFormDialog } from "@/components/session/SessionFormDialog";
import { SessionTiles, type SessionTileData } from "@/components/session/SessionTiles";
import { Chip } from "@/components/ui/Chip";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { loadVisibleArtists } from "@/lib/artists/data";
import { ADMIN_SHELL_PERMISSIONS } from "@/lib/permissions/portal";
import { getEffectiveRole, requirePagePermission } from "@/lib/permissions/server";
import { loadParticipants, loadSessionCounts, loadSessions } from "@/lib/sessions/data";
import { isUuid } from "@/lib/storage/keys";

export const metadata: Metadata = { title: "Sesiones" };
export const dynamic = "force-dynamic";

const dayFormat = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", year: "numeric", timeZone: "Atlantic/Canary" });

export default async function SesionesPage({ searchParams }: { searchParams: Promise<{ artista?: string; q?: string }> }) {
  // Pantalla de administración: el portal (artistas y colaboradores) no la ve (404).
  await requirePagePermission(...ADMIN_SHELL_PERMISSIONS);
  const role = await getEffectiveRole();
  if (!role?.permissions.has("photos.view")) notFound();

  const params = await searchParams;
  const artistFilter = isUuid(params.artista) ? params.artista : null;
  const q = (params.q ?? "").trim().slice(0, 60);
  const needle = q.toLocaleLowerCase("es");

  // Lecturas bajo RLS: solo las sesiones (y artistas) a los que esta persona tiene acceso
  const [sessions, counts, artists] = await Promise.all([loadSessions(), loadSessionCounts(), loadVisibleArtists()]);
  const participants = await loadParticipants(sessions.map((s) => s.id));
  const artistName = new Map(artists.map((a) => [a.id, a.name]));

  const visible = sessions
    .filter((s) => !artistFilter || s.artistId === artistFilter || (participants.get(s.id) ?? []).includes(artistFilter))
    .filter((s) => !needle || s.name.toLocaleLowerCase("es").includes(needle));

  const covers = await getThumbUrls(visible.map((s) => s.coverAssetId).filter((v): v is string => !!v).slice(0, 50));
  const coverUrls = covers.ok && covers.data ? covers.data : {};

  const tiles: SessionTileData[] = visible.map((s) => {
    const photos = counts.get(s.id)?.photos ?? 0;
    const parts = [artistName.get(s.artistId) ?? "Artista", `${photos} ${photos === 1 ? "foto" : "fotos"}`];
    if (s.date) parts.push(dayFormat.format(new Date(`${s.date}T12:00:00`)));
    return { id: s.id, name: s.name, href: `/sesiones/${s.id}`, meta: parts.join(" · "), coverUrl: s.coverAssetId ? coverUrls[s.coverAssetId] : undefined };
  });

  const href = (artistId: string | null) => {
    const query = new URLSearchParams();
    if (artistId) query.set("artista", artistId);
    if (q) query.set("q", q);
    const s = query.toString();
    return s ? `/sesiones?${s}` : "/sesiones";
  };

  const canCreate = role.permissions.has("photos.edit");
  const activeArtists = artists.filter((a) => a.status === "active").map((a) => ({ id: a.id, name: a.name }));

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Sesiones"
        description="Las sesiones de fotos de todos los artistas: galerías, favoritas y descargas."
        actions={
          canCreate ? (
            <SessionFormDialog
              artists={activeArtists}
              canChangeMode={role.permissions.has("photos.publish")}
              initial={{ name: "", date: "", description: "", artistId: artistFilter ?? "", participantIds: [], downloadMode: "off" }}
            />
          ) : null
        }
      />

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 py-1" role="group" aria-label="Filtrar por artista">
          <Chip href={href(null)} selected={!artistFilter}>
            Todos
          </Chip>
          {artists.map((artist) => (
            <Chip key={artist.id} href={href(artist.id)} selected={artistFilter === artist.id}>
              {artist.name}
            </Chip>
          ))}
        </div>
        <form role="search" method="get" action="/sesiones" className="relative w-full shrink-0 sm:w-72">
          {artistFilter ? <input type="hidden" name="artista" value={artistFilter} /> : null}
          <SearchIcon size={16} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-text-3" />
          <input
            type="search"
            name="q"
            defaultValue={q}
            aria-label="Buscar sesiones"
            placeholder="Buscar sesiones"
            className="h-10 w-full rounded-pill border border-line bg-surface pr-4 pl-10 text-body text-text placeholder:text-text-3 transition-colors duration-150 ease-ui hover:border-line-hover focus-visible:border-line-hover"
          />
        </form>
      </div>

      {tiles.length === 0 ? (
        <EmptyState
          icon={<ImageIcon size={22} />}
          title={sessions.length === 0 ? "Aún no hay sesiones" : "No hay sesiones con ese filtro"}
          description={sessions.length === 0 ? "Crea la primera y sube las fotos desde su página." : "Prueba con otro artista o con otra búsqueda."}
        />
      ) : (
        <SessionTiles sessions={tiles} />
      )}
    </div>
  );
}
