import { getThumbUrls } from "@/app/actions/browse";
import { ImageIcon, MusicIcon, PlayIcon } from "@/components/icons";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { PhotoTile } from "@/components/ui/PhotoTile";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { createClient } from "@/lib/supabase/server";

type Row = { id: string; kind: string; title: string | null; original_filename: string; visibility: "private" | "published"; created_at: string; artist_id: string | null };

const day = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", timeZone: "Atlantic/Canary" });

/**
 * «Tus subidas recientes»: lo último que ha subido esta persona y si ya está publicado. Lectura bajo RLS
 * (cada persona ve sus propias subidas aunque aún sean privadas).
 */
export async function RecentUploads({ userId, showPendingNote }: { userId: string; showPendingNote: boolean }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("assets")
    .select("id, kind, title, original_filename, visibility, created_at, artist_id")
    .eq("uploaded_by", userId)
    .eq("status", "ready")
    .eq("space", "workspace")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(12);
  const rows = (data ?? []) as unknown as Row[];

  const artistIds = [...new Set(rows.map((r) => r.artist_id).filter((v): v is string => !!v))];
  const names = new Map<string, string>();
  if (artistIds.length > 0) {
    const { data: artists } = await supabase.from("artists").select("id, name").in("id", artistIds);
    for (const a of (artists ?? []) as { id: string; name: string }[]) names.set(a.id, a.name);
  }
  const thumbs = await getThumbUrls(rows.filter((r) => r.kind === "photo").map((r) => r.id));
  const urls = thumbs.ok && thumbs.data ? thumbs.data : {};

  return (
    <section aria-label="Tus subidas recientes">
      <SectionHeader title="Tus subidas recientes" />
      {showPendingNote ? (
        <p className="-mt-2 mb-5 max-w-2xl text-label text-text-2">Lo que subes queda pendiente hasta que se publique.</p>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState icon={<ImageIcon size={22} />} title="Aún no has subido nada" description="Lo que subas aparecerá aquí con su estado." />
      ) : (
        <ul className="grid grid-cols-2 gap-x-4 gap-y-8 md:grid-cols-3 wide:grid-cols-4">
          {rows.map((row) => {
            const Icon = row.kind === "video" ? PlayIcon : row.kind === "audio" ? MusicIcon : ImageIcon;
            return (
              <li key={row.id} className="min-w-0">
                <PhotoTile
                  ratio={row.kind === "photo" ? "4/5" : "16/9"}
                  tone={((row.id.charCodeAt(0) % 5) + 1) as 1 | 2 | 3 | 4 | 5}
                  imageUrl={urls[row.id]}
                  icon={<Icon size={26} className="text-text-3" />}
                  title={row.title ?? row.original_filename}
                  meta={`${row.artist_id ? (names.get(row.artist_id) ?? "") : ""}${row.artist_id ? " · " : ""}${day.format(new Date(row.created_at))}`}
                />
                <div className="mt-1.5">
                  {row.visibility === "published" ? <Badge variant="neutral">Publicado</Badge> : <Badge variant="outline">Pendiente de publicar</Badge>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
