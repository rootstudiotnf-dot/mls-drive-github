import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { listBeatActivity } from "@/app/actions/beats";
import { BeatEditor } from "@/components/beats/BeatEditor";
import { ShareButton } from "@/components/share/ShareButton";
import { TextLink } from "@/components/ui/TextLink";
import { requireActor } from "@/lib/auth/session";
import { loadBeat, loadGenres } from "@/lib/beats/data";
import { getMaxUploadBytes } from "@/lib/env";
import { ADMIN_SHELL_PERMISSIONS } from "@/lib/permissions/portal";
import { can, requirePagePermission, userHasPermission } from "@/lib/permissions/server";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Beat" };
export const dynamic = "force-dynamic";

export default async function BeatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePagePermission(...ADMIN_SHELL_PERMISSIONS);
  await requirePagePermission("beats.view");
  const actor = await requireActor();
  // Lectura bajo RLS: sin acceso (o inexistente) es un 404 idéntico
  const beat = await loadBeat(id);
  if (!beat) notFound();

  const [edit, publish, download, grantDownload] = await Promise.all([
    can(actor.id, "edit", { type: "beat", id }),
    can(actor.id, "publish", { type: "beat", id }),
    can(actor.id, "download", { type: "beat", id }),
    userHasPermission(actor.id, "beats.download"),
  ]);
  const supabase = await createClient();
  const [genres, artists, activity] = await Promise.all([
    loadGenres(),
    edit ? supabase.from("artists").select("id, name").is("deleted_at", null).order("name").limit(300) : Promise.resolve({ data: [] }),
    edit ? listBeatActivity(id) : Promise.resolve(null),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TextLink href="/beats">← Beats</TextLink>
        {publish && beat.status === "published" ? <ShareButton target={{ kind: "beats", ids: [beat.id] }} defaultTitle={beat.title} /> : null}
      </div>
      <BeatEditor
        beat={beat}
        genres={genres.map((g) => ({ id: g.id, name: g.name }))}
        artists={((artists.data ?? []) as { id: string; name: string }[]).map((a) => ({ id: a.id, name: a.name }))}
        caps={{ edit, publish, download, grantDownload }}
        maxBytes={getMaxUploadBytes()}
        activity={activity && activity.ok && activity.data ? activity.data : null}
      />
    </div>
  );
}
