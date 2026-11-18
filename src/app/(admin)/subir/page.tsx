import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/PageHeader";
import { getMaxUploadBytes } from "@/lib/env";
import { getEffectiveRole, requirePagePermission } from "@/lib/permissions/server";
import { createClient } from "@/lib/supabase/server";
import { loadSession } from "@/lib/sessions/data";
import { isUuid } from "@/lib/storage/keys";
import type { UiType } from "@/lib/storage/validate";
import { RecentUploads } from "@/components/upload/RecentUploads";
import { UploadClient } from "./UploadClient";

export const metadata: Metadata = { title: "Subir archivos" };
export const dynamic = "force-dynamic";

const AREA_OF_UI: Record<UiType, string> = { photo: "photos", video: "videos", beat: "beats", file: "files" };

export default async function SubirPage({ searchParams }: { searchParams: Promise<{ artista?: string; sesion?: string }> }) {
  const { artista, sesion } = await searchParams;
  // Barrera de servidor: hace falta poder subir algún tipo de contenido (si no, 404).
  const actor = await requirePagePermission("photos.upload", "videos.upload", "files.upload", "beats.upload");
  const role = await getEffectiveRole();
  if (!role) return null;

  const has = (key: string) => role.permissions.has(key);
  const allowedTypes = Object.fromEntries(
    (Object.keys(AREA_OF_UI) as UiType[]).map((t) => [t, has(`${AREA_OF_UI[t]}.upload`)]),
  ) as Record<UiType, boolean>;
  const publishableTypes = Object.fromEntries(
    (Object.keys(AREA_OF_UI) as UiType[]).map((t) => [t, has(`${AREA_OF_UI[t]}.publish`)]),
  ) as Record<UiType, boolean>;

  // Lecturas con el cliente del usuario: RLS solo devuelve los artistas y carpetas a los que tiene acceso.
  const supabase = await createClient();
  const [artistsRes, foldersRes] = await Promise.all([
    supabase.from("artists").select("id, name").is("deleted_at", null).order("name").limit(300),
    supabase.from("folders").select("id, artist_id, name, kind, session_id").order("name").limit(1000),
  ]);

  // Subida desde una sesión: artista y sesión fijados (RLS: si no hay acceso a la sesión, se ignora)
  const session = isUuid(sesion) ? await loadSession(sesion) : null;

  const artists = ((artistsRes.data ?? []) as { id: string; name: string }[])
    .filter((a) => !session || a.id === session.artistId)
    .map((a) => ({ id: a.id, name: a.name }));
  const folders = ((foldersRes.data ?? []) as { id: string; artist_id: string; name: string; kind: string; session_id: string | null }[])
    // Las carpetas de una sesión solo valen para esa sesión; fuera de ella, solo las del artista
    .filter((f) => (session ? f.session_id === session.id : f.session_id === null))
    .map((f) => ({
    id: f.id,
    artistId: f.artist_id,
    name: f.name,
    kind: f.kind,
  }));

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title="Subir archivos"
        description={
          session
            ? `Fotos y material de «${session.name}». Las subidas grandes se pueden pausar y reanudar.`
            : "Suelta los archivos, clasifícalos y súbelos. Las subidas grandes se pueden pausar y reanudar."
        }
      />
      <UploadClient
        artists={artists}
        folders={folders}
        allowedTypes={allowedTypes}
        publishableTypes={publishableTypes}
        canUploadWithoutArtist={role.scope === "all" && allowedTypes.beat}
        maxBytes={getMaxUploadBytes()}
        preselectArtistId={session ? session.artistId : isUuid(artista) ? artista : null}
        session={session ? { id: session.id, name: session.name } : null}
      />
      <RecentUploads
        userId={actor.id}
        showPendingNote={!Object.values(publishableTypes).some(Boolean)}
      />
    </div>
  );
}
