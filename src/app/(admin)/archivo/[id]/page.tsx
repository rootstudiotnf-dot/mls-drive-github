import { hasVaultEntitlement } from "@/lib/vault/access";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireActor } from "@/lib/auth/session";
import { can, userHasPermission } from "@/lib/permissions/server";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/storage/keys";
import { loadVideoStates } from "@/lib/video/jobs";
import { extensionOf } from "@/lib/storage/validate";
import { AssetDetail, type AssetDetailProps } from "./AssetDetail";

export const metadata: Metadata = { title: "Archivo" };
export const dynamic = "force-dynamic";

type AssetRecord = {
  id: string;
  kind: AssetDetailProps["asset"]["kind"];
  space: string;
  artist_id: string | null;
  folder_id: string | null;
  title: string | null;
  original_filename: string;
  size_bytes: number | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  status: string;
  visibility: "private" | "published";
  downloadable: boolean;
  uploaded_by: string | null;
  created_at: string;
  meta: { fps?: number | null } | null;
};

export default async function ArchivoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const actor = await requireActor();

  // Lectura con el cliente del usuario: RLS (can_access 'view' + estado) decide. Sin acceso → 404, igual
  // que si no existiera. NO se pide la clave del objeto: no hace falta para pintar la ficha.
  const supabase = await createClient();
  const { data } = await supabase
    .from("assets")
    .select(
      "id, kind, space, artist_id, folder_id, title, original_filename, size_bytes, width, height, duration_seconds, status, visibility, downloadable, uploaded_by, created_at, meta",
    )
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  const asset = data as unknown as AssetRecord | null;
  if (!asset) notFound();

  const [canEdit, canPublish, canDownload] = await Promise.all([
    can(actor.id, "edit", { type: "asset", id }),
    can(actor.id, "publish", { type: "asset", id }),
    can(actor.id, "download", { type: "asset", id }),
  ]);

  const [artistRes, folderRes, uploaderRes, taggingsRes] = await Promise.all([
    asset.artist_id
      ? supabase.from("artists").select("id, name").eq("id", asset.artist_id).maybeSingle()
      : Promise.resolve({ data: null }),
    asset.folder_id
      ? supabase.from("folders").select("id, name").eq("id", asset.folder_id).maybeSingle()
      : Promise.resolve({ data: null }),
    asset.uploaded_by
      ? supabase.from("profiles").select("full_name, email").eq("id", asset.uploaded_by).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from("taggings").select("tag_id").eq("resource_type", "asset").eq("resource_id", id),
  ]);
  const tagIds = ((taggingsRes.data ?? []) as { tag_id: string }[]).map((t) => t.tag_id);
  const tagsRes = tagIds.length > 0 ? await supabase.from("tags").select("name").in("id", tagIds) : { data: [] };

  // Destinos posibles para mover (solo si puede editar): artistas y carpetas visibles para él (RLS)
  let artists: { id: string; name: string }[] = [];
  let folders: { id: string; artistId: string; name: string; kind: string }[] = [];
  if (canEdit) {
    const [artistsRes, foldersRes] = await Promise.all([
      supabase.from("artists").select("id, name").is("deleted_at", null).order("name").limit(300),
      supabase.from("folders").select("id, artist_id, name, kind").order("name").limit(1000),
    ]);
    artists = ((artistsRes.data ?? []) as { id: string; name: string }[]).map((a) => ({ id: a.id, name: a.name }));
    folders = ((foldersRes.data ?? []) as { id: string; artist_id: string; name: string; kind: string }[]).map((f) => ({
      id: f.id,
      artistId: f.artist_id,
      name: f.name,
      kind: f.kind,
    }));
  }

  const uploader = uploaderRes.data as { full_name: string | null; email: string } | null;
  // Vídeo: estado de procesado (lectura de servidor, tras comprobar que el usuario lo ve)
  const videoState = asset.kind === "video" && asset.status === "ready" ? ((await loadVideoStates([asset.id])).get(asset.id) ?? { status: "none" as const, error: null }) : null;

  return (
    <AssetDetail
      asset={{
        id: asset.id,
        kind: asset.kind,
        title: asset.title ?? asset.original_filename,
        filename: asset.original_filename,
        ext: extensionOf(asset.original_filename),
        sizeBytes: asset.size_bytes ?? 0,
        width: asset.width,
        height: asset.height,
        durationSeconds: asset.duration_seconds,
        status: asset.status,
        visibility: asset.visibility,
        downloadable: asset.downloadable,
        artistId: asset.artist_id,
        folderId: asset.folder_id,
        vault: asset.space === "vault",
        createdAt: asset.created_at,
      }}
      artistName={(artistRes.data as { name: string } | null)?.name ?? null}
      folderName={(folderRes.data as { name: string } | null)?.name ?? null}
      uploaderName={uploader ? uploader.full_name || uploader.email : null}
      tags={((tagsRes.data ?? []) as { name: string }[]).map((t) => t.name).sort()}
      permissions={{ edit: canEdit, publish: canPublish, download: canDownload }}
      canVault={canEdit && asset.space === "workspace" && (await hasVaultEntitlement(actor)) && (await userHasPermission(actor.id, "vault.upload"))}
      video={videoState ? { state: videoState, fps: asset.meta?.fps ?? null } : undefined}
      artists={artists}
      folders={folders}
    />
  );
}
