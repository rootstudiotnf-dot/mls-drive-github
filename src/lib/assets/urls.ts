import "server-only";

import { fail, ok, type ActionResult } from "@/lib/action-result";
import type { Actor } from "@/lib/auth/session";
import { logActivity } from "@/lib/permissions/audit";
import { can } from "@/lib/permissions/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/storage/keys";
import { signGetUrl } from "@/lib/storage/urls";
import { classifyFilename } from "@/lib/storage/validate";
import { variantAllowed, type AssetVariant, type DownloadMode } from "./variants";

/**
 * ÚNICO camino para firmar URLs de ver y descargar un asset (`getAssetUrl`, descargas de sesión, ZIP).
 * Comprueba, en este orden: valores válidos · can_access('view' | 'download') (rol, alcance, visibilidad,
 * Vault, `downloadable` y —dentro de una sesión— que la sesión permita descargar) · asset 'ready' · y, al
 * descargar, el MODO DE DESCARGA de la sesión para la variante pedida:
 *   off      → nada
 *   web      → solo la versión web
 *   original → la original (y también la web)
 * Fuera de una sesión solo se descarga el original. Cada descarga queda en activity_log.
 */

const VARIANTS: readonly AssetVariant[] = ["original", "thumb", "web", "proxy", "poster", "audio_preview"];

/** Vida de la URL de un preview de audio (15 min: suficiente para escuchar y con soporte Range). */
const PREVIEW_TTL_SECONDS = 15 * 60;

/** Content-Type con el que se sirve cada derivado. */
const DERIVATIVE_TYPE: Record<string, string> = { thumb: "image/webp", web: "image/webp", proxy: "video/mp4", poster: "image/jpeg", audio_preview: "audio/mpeg" };
const NOT_AVAILABLE = "Archivo no disponible.";

type ReadableAsset = {
  id: string;
  kind: string;
  status: string;
  storage_key: string;
  original_filename: string;
  downloadable: boolean;
  session_id: string | null;
  space: string;
};

function webFilename(original: string): string {
  const dot = original.lastIndexOf(".");
  return `${dot > 0 ? original.slice(0, dot) : original}.webp`;
}

export async function signAssetUrl(
  actor: Actor,
  assetId: unknown,
  variant: unknown,
  mode: unknown,
): Promise<ActionResult<{ url: string; expiresIn: number }>> {
  if (!isUuid(assetId) || !VARIANTS.includes(variant as AssetVariant) || (mode !== "view" && mode !== "download")) {
    return fail(NOT_AVAILABLE);
  }
  const v = variant as AssetVariant;
  // Descargar: el original o (dentro de una sesión) la versión web; el resto son solo para ver.
  if (mode === "download" && v !== "original" && v !== "web") return fail(NOT_AVAILABLE);

  if (!(await can(actor.id, mode, { type: "asset", id: assetId }))) return fail(NOT_AVAILABLE);

  const admin = createAdminClient();
  const { data } = await admin
    .from("assets")
    .select("id, kind, status, storage_key, original_filename, downloadable, session_id, space")
    .eq("id", assetId)
    .is("deleted_at", null)
    .maybeSingle();
  const asset = data as unknown as ReadableAsset | null;
  if (!asset || asset.status !== "ready") return fail(NOT_AVAILABLE);
  // Fase 8: el Vault nunca se firma por este camino (otro bucket, otro desbloqueo): solo desde sus acciones
  if (asset.space !== "workspace") return fail(NOT_AVAILABLE);
  // El audio de un beat se autoriza a través del beat (can_access ya comprobó su `downloadable` y las tres capas);
  // la columna `downloadable` del propio asset solo manda en el resto de archivos.
  if (mode === "download" && !asset.downloadable) {
    const { data: ownBeat } = asset.kind === "audio" ? await admin.from("beats").select("id").eq("asset_id", asset.id).is("deleted_at", null).maybeSingle() : { data: null };
    if (!ownBeat) return fail("Este archivo no se puede descargar.");
  }

  // Fase 6: ver el ORIGINAL de un vídeo (puede ser ProRes/HEVC) solo lo hace quien puede editar (para revisarlo);
  // el resto ve el proxy. Descargarlo sigue las reglas de descarga de siempre.
  // Fase 7: el ORIGINAL de un audio nunca se reproduce (solo el preview); el original solo sale en descargas autorizadas
  if (mode === "view" && v === "original" && asset.kind === "audio") return fail(NOT_AVAILABLE);

  if (mode === "view" && v === "original" && asset.kind === "video" && !(await can(actor.id, "edit", { type: "asset", id: asset.id }))) {
    return fail(NOT_AVAILABLE);
  }

  if (mode === "download") {
    if (asset.session_id) {
      const { data: session } = await admin
        .from("sessions")
        .select("download_mode")
        .eq("id", asset.session_id)
        .maybeSingle();
      const downloadMode = ((session as { download_mode: DownloadMode } | null)?.download_mode ?? "off") as DownloadMode;
      if (!variantAllowed(downloadMode, v)) return fail("Esta sesión no permite esa descarga.");
    } else if (v !== "original") {
      return fail(NOT_AVAILABLE);
    }
  }

  let key = asset.storage_key;
  let contentType = classifyFilename(asset.original_filename)?.mime ?? "application/octet-stream";
  let filename = asset.original_filename;
  if (v !== "original") {
    const { data: derivative } = await admin
      .from("asset_derivatives")
      .select("storage_key, status")
      .eq("asset_id", asset.id)
      .eq("type", v)
      .maybeSingle();
    const d = derivative as { storage_key: string; status: string } | null;
    if (!d || d.status !== "ready") return fail("No hay versión disponible.");
    key = d.storage_key;
    contentType = DERIVATIVE_TYPE[v] ?? "application/octet-stream";
    filename = webFilename(asset.original_filename);
  }

  // Beats: la descarga lleva el título del beat como nombre de archivo
  if (mode === "download" && v === "original" && asset.kind === "audio") {
    const { data: beat } = await admin.from("beats").select("title").eq("asset_id", asset.id).is("deleted_at", null).maybeSingle();
    const title = (beat as { title: string } | null)?.title;
    const ext = asset.original_filename.includes(".") ? asset.original_filename.slice(asset.original_filename.lastIndexOf(".")) : "";
    if (title) filename = `${title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").trim().slice(0, 120) || "beat"}${ext}`;
  }

  const signed = await signGetUrl({ key, mode, contentType, filename, ttlSeconds: v === "audio_preview" ? PREVIEW_TTL_SECONDS : undefined });
  if (mode === "download") {
    await logActivity({
      actorId: actor.id,
      action: "asset.downloaded",
      resourceType: "asset",
      resourceId: asset.id,
      metadata: { variant: v },
    });
  }
  return ok(undefined, signed);
}
