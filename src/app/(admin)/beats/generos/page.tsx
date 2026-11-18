import type { Metadata } from "next";
import { GenreManager } from "@/components/beats/GenreManager";
import { PageHeader } from "@/components/ui/PageHeader";
import { TextLink } from "@/components/ui/TextLink";
import { loadGenres } from "@/lib/beats/data";
import { ADMIN_SHELL_PERMISSIONS } from "@/lib/permissions/portal";
import { requirePagePermission } from "@/lib/permissions/server";

export const metadata: Metadata = { title: "Géneros" };
export const dynamic = "force-dynamic";

export default async function GenresPage() {
  await requirePagePermission(...ADMIN_SHELL_PERMISSIONS);
  await requirePagePermission("beats.edit");
  const genres = await loadGenres();
  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Géneros" description="Crea, renombra y fusiona los géneros de la biblioteca." actions={<TextLink href="/beats">Volver a beats</TextLink>} />
      <GenreManager genres={genres} />
    </div>
  );
}
