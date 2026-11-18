import type { Metadata } from "next";
import { listBeats } from "@/app/actions/beats";
import { BeatCatalog } from "@/components/beats/BeatCatalog";
import { UploadIcon } from "@/components/icons";
import { ButtonLink } from "@/components/ui/ButtonLink";
import { PageHeader } from "@/components/ui/PageHeader";
import { loadGenres } from "@/lib/beats/data";
import { filtersFromParams } from "@/lib/beats/types";
import { ADMIN_SHELL_PERMISSIONS } from "@/lib/permissions/portal";
import { getEffectiveRole, requirePagePermission } from "@/lib/permissions/server";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Beats" };
export const dynamic = "force-dynamic";

export default async function BeatsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // Pantalla de administración: el portal (artistas y colaboradores) no la ve (404).
  const actor = await requirePagePermission(...ADMIN_SHELL_PERMISSIONS);
  await requirePagePermission("beats.view");
  const role = await getEffectiveRole();
  const can = (key: string) => role?.permissions.has(key) ?? false;

  const filters = filtersFromParams(await searchParams);
  const supabase = await createClient();
  const [first, genres, tags, artists] = await Promise.all([
    listBeats({ filters }),
    loadGenres(),
    supabase.from("tags").select("id, name").order("name").limit(300),
    supabase.from("artists").select("id, name").is("deleted_at", null).order("name").limit(300),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Beats"
        description="Biblioteca de instrumentales, independiente de los artistas. Escucha, filtra y comparte con quien corresponda."
        actions={
          <>
            {actor.roleKey === "owner" ? (
              <ButtonLink href="/ajustes/beats" variant="ghost" size="sm">
                Tag de voz
              </ButtonLink>
            ) : null}
            {can("beats.edit") ? (
              <ButtonLink href="/beats/generos" variant="ghost" size="sm">
                Géneros
              </ButtonLink>
            ) : null}
            {can("beats.upload") ? (
              <ButtonLink href="/beats/nuevo" size="sm">
                <UploadIcon size={16} />
                Subir beat
              </ButtonLink>
            ) : null}
          </>
        }
      />
      <BeatCatalog
        mode="admin"
        basePath="/beats"
        initialFilters={filters}
        initialPage={first.ok && first.data ? first.data : { items: [], nextCursor: null }}
        genres={genres.map((g) => ({ id: g.id, name: g.name }))}
        tags={((tags.data ?? []) as { id: string; name: string }[]).map((t) => ({ id: t.id, name: t.name }))}
        artists={((artists.data ?? []) as { id: string; name: string }[]).map((a) => ({ id: a.id, name: a.name }))}
      />
    </div>
  );
}
