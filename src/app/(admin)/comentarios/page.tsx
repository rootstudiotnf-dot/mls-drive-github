import type { Metadata } from "next";
import Link from "next/link";
import { MessageIcon } from "@/components/icons";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { DataList, DataRow } from "@/components/ui/DataRow";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Select } from "@/components/ui/Select";
import { TabNav } from "@/components/ui/TabNav";
import { formatTimecode } from "@/lib/comments/types";
import { COMMENT_PERMISSIONS } from "@/lib/permissions/keys";
import { hasAdminShell } from "@/lib/permissions/portal";
import { getEffectiveRole, requirePagePermission } from "@/lib/permissions/server";
import { isUuid } from "@/lib/storage/keys";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Comentarios" };
export const dynamic = "force-dynamic";

const PAGE = 100;
const when = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Atlantic/Canary" });

type CommentRow = { id: string; asset_id: string; user_id: string | null; body: string; timecode_ms: number | null; created_at: string; external_name: string | null };
type AssetRow = { id: string; kind: string; title: string | null; original_filename: string; artist_id: string | null; session_id: string | null };

/**
 * Bandeja de comentarios: todo lo comentado en lo que esta persona puede ver (RLS decide). Abiertos o resueltos,
 * con filtro por artista y sesión. El Vault no entra: sus assets quedan fuera de las políticas normales.
 */
export default async function CommentsPage({ searchParams }: { searchParams: Promise<{ estado?: string; artista?: string; sesion?: string }> }) {
  await requirePagePermission(...COMMENT_PERMISSIONS, "photos.view", "videos.view", "beats.view");
  const role = await getEffectiveRole();
  const admin = role ? hasAdminShell(role.permissions) : false;
  const query = await searchParams;
  const resolved = query.estado === "resueltos";
  const artistFilter = isUuid(query.artista) ? query.artista : null;
  const sessionFilter = isUuid(query.sesion) ? query.sesion : null;

  const supabase = await createClient();
  const [artistsRes, sessionsRes] = await Promise.all([
    supabase.from("artists").select("id, name, slug").is("deleted_at", null).order("name").limit(200),
    admin ? supabase.from("sessions").select("id, name").is("deleted_at", null).order("name").limit(200) : Promise.resolve({ data: [] }),
  ]);
  const artists = (artistsRes.data ?? []) as { id: string; name: string; slug: string }[];
  const sessions = (sessionsRes.data ?? []) as { id: string; name: string }[];

  // Con filtro, primero se resuelven los assets que encajan (bajo RLS) y luego sus comentarios
  let restrictTo: string[] | null = null;
  if (artistFilter || sessionFilter) {
    let q = supabase.from("assets").select("id").is("deleted_at", null).eq("status", "ready").neq("space", "vault");
    if (artistFilter) q = q.eq("artist_id", artistFilter);
    if (sessionFilter) q = q.eq("session_id", sessionFilter);
    const { data } = await q.limit(1000);
    restrictTo = ((data ?? []) as { id: string }[]).map((r) => r.id);
  }

  let comments: CommentRow[] = [];
  if (restrictTo === null || restrictTo.length > 0) {
    let q = supabase.from("comments").select("id, asset_id, user_id, body, timecode_ms, created_at, external_name").is("parent_id", null).is("deleted_at", null).eq("resolved", resolved);
    if (restrictTo) q = q.in("asset_id", restrictTo);
    const { data } = await q.order("created_at", { ascending: false }).limit(PAGE);
    comments = (data ?? []) as CommentRow[];
  }

  const assetIds = [...new Set(comments.map((c) => c.asset_id))];
  const authorIds = [...new Set(comments.map((c) => c.user_id).filter((v): v is string => !!v))];
  const [assetsRes, beatsRes, peopleRes] = await Promise.all([
    assetIds.length ? supabase.from("assets").select("id, kind, title, original_filename, artist_id, session_id").in("id", assetIds) : Promise.resolve({ data: [] }),
    assetIds.length ? supabase.from("beats").select("id, asset_id, title").in("asset_id", assetIds) : Promise.resolve({ data: [] }),
    authorIds.length ? createAdminClient().from("profiles").select("id, full_name, email").in("id", authorIds) : Promise.resolve({ data: [] }),
  ]);
  const assets = new Map(((assetsRes.data ?? []) as AssetRow[]).map((a) => [a.id, a]));
  const beats = new Map(((beatsRes.data ?? []) as { id: string; asset_id: string; title: string }[]).map((b) => [b.asset_id, b]));
  const people = new Map(((peopleRes.data ?? []) as { id: string; full_name: string | null; email: string }[]).map((p) => [p.id, p.full_name || p.email]));
  const artistById = new Map(artists.map((a) => [a.id, a]));

  const pathFor = (asset: AssetRow): string => {
    const beat = beats.get(asset.id);
    if (beat) return admin ? `/beats/${beat.id}` : `/archivo/${asset.id}`;
    if (asset.kind === "photo" && asset.session_id) {
      if (admin) return `/sesiones/${asset.session_id}?foto=${asset.id}`;
      const slug = asset.artist_id ? artistById.get(asset.artist_id)?.slug : null;
      if (slug) return `/espacio/${slug}/sesiones/${asset.session_id}?foto=${asset.id}`;
    }
    return `/archivo/${asset.id}`;
  };

  const keep = (extra: Record<string, string | null>) => {
    const params = new URLSearchParams();
    const merged: Record<string, string | null> = { estado: resolved ? "resueltos" : null, artista: artistFilter, sesion: sessionFilter, ...extra };
    for (const [k, v] of Object.entries(merged)) if (v) params.set(k, v);
    const text = params.toString();
    return text ? `/comentarios?${text}` : "/comentarios";
  };

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Comentarios" description="Todo lo comentado en lo que puedes ver, en un solo sitio." actions={null} />
      <TabNav
        label="Estado de los comentarios"
        items={[{ href: keep({ estado: null }), label: "Abiertos" }, { href: keep({ estado: "resueltos" }), label: "Resueltos" }]}
        current={keep({ estado: resolved ? "resueltos" : null })}
      />
      <form method="get" action="/comentarios" className="flex flex-wrap items-end gap-3">
        {resolved ? <input type="hidden" name="estado" value="resueltos" /> : null}
        <Select label="Artista" name="artista" defaultValue={artistFilter ?? ""} options={[{ value: "", label: "Todos" }, ...artists.map((a) => ({ value: a.id, label: a.name }))]} />
        {admin ? <Select label="Sesión" name="sesion" defaultValue={sessionFilter ?? ""} options={[{ value: "", label: "Todas" }, ...sessions.map((s) => ({ value: s.id, label: s.name }))]} /> : null}
        <Button type="submit" size="sm" variant="ghost">
          Filtrar
        </Button>
      </form>

      {comments.length === 0 ? (
        <EmptyState icon={<MessageIcon size={22} />} title={resolved ? "Nada resuelto todavía" : "Sin comentarios abiertos"} description="Los comentarios de fotos, vídeos y beats aparecerán aquí." />
      ) : (
        <DataList>
          {comments.map((c) => {
            const asset = assets.get(c.asset_id);
            if (!asset) return null;
            const author = c.external_name ? `${c.external_name} (externo)` : c.user_id ? (people.get(c.user_id) ?? "Alguien") : "Cuenta eliminada";
            const where = beats.get(asset.id)?.title ?? asset.title ?? asset.original_filename;
            const artist = asset.artist_id ? artistById.get(asset.artist_id)?.name : null;
            return (
              <Link key={c.id} href={pathFor(asset)} className="block">
                <DataRow
                  title={c.body.length > 140 ? `${c.body.slice(0, 140)}…` : c.body}
                  subtitle={`${author} · ${where}${artist ? ` · ${artist}` : ""} · ${when.format(new Date(c.created_at))}`}
                  trailing={c.timecode_ms !== null ? <Badge variant="outline">{formatTimecode(c.timecode_ms)}</Badge> : undefined}
                />
              </Link>
            );
          })}
        </DataList>
      )}
      {comments.length === PAGE ? <p className="text-center text-caption text-text-3">Se muestran los {PAGE} más recientes. Usa los filtros para acotar.</p> : null}
    </div>
  );
}
