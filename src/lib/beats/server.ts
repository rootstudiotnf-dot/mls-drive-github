import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { suggestFromFilename } from "./types";

/**
 * Al terminar de subir un audio clasificado como «Beat» se crea su registro en `beats` en estado 'draft', con
 * título, BPM y tonalidad SUGERIDOS por el nombre del archivo (editables). Idempotente por asset.
 */
export async function createDraftBeatForAsset(input: { assetId: string; filename: string; actorId: string }): Promise<string | null> {
  const admin = createAdminClient();
  const { data: existing } = await admin.from("beats").select("id").eq("asset_id", input.assetId).is("deleted_at", null).maybeSingle();
  if (existing) return (existing as { id: string }).id;

  const suggestion = suggestFromFilename(input.filename);
  const { data: setting } = await admin.from("app_settings").select("value").eq("key", "beat_voice_tag_default").maybeSingle();
  const tagged = (setting as { value: unknown } | null)?.value === true;
  const { data, error } = await admin
    .from("beats")
    .insert({
      asset_id: input.assetId,
      title: suggestion.title,
      bpm: suggestion.bpm,
      musical_key: suggestion.key,
      status: "draft",
      downloadable: false,
      preview_tagged: tagged,
      created_by: input.actorId,
    })
    .select("id")
    .single();
  if (error || !data) {
    console.error("createDraftBeatForAsset failed:", error?.code ?? "");
    return null;
  }
  return (data as { id: string }).id;
}
