import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BeatSettingsForm } from "@/components/beats/BeatSettingsForm";
import { PageHeader } from "@/components/ui/PageHeader";
import { TextLink } from "@/components/ui/TextLink";
import { requireActor } from "@/lib/auth/session";
import { getMaxUploadBytes } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata: Metadata = { title: "Ajustes de beats" };
export const dynamic = "force-dynamic";

/** Solo el propietario (rol único e inmutable): el tag de voz de los previews. Cualquier otra persona recibe un 404. */
export default async function BeatSettingsPage() {
  const actor = await requireActor();
  if (actor.roleKey !== "owner") notFound();

  const admin = createAdminClient();
  const { data } = await admin.from("app_settings").select("key, value").in("key", ["beat_voice_tag_asset_id", "beat_voice_tag_interval_s", "beat_voice_tag_default"]);
  const map = new Map(((data ?? []) as { key: string; value: unknown }[]).map((r) => [r.key, r.value]));
  const tagId = typeof map.get("beat_voice_tag_asset_id") === "string" ? (map.get("beat_voice_tag_asset_id") as string) : null;
  let tagName: string | null = null;
  if (tagId) {
    const { data: asset } = await admin.from("assets").select("original_filename").eq("id", tagId).is("deleted_at", null).maybeSingle();
    tagName = (asset as { original_filename: string } | null)?.original_filename ?? null;
  }
  const interval = Number(map.get("beat_voice_tag_interval_s"));

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Ajustes de beats" description="El tag de voz que se mezcla en los previews. Los originales nunca lo llevan." actions={<TextLink href="/beats">Volver a beats</TextLink>} />
      <BeatSettingsForm
        initial={{
          intervalS: Number.isFinite(interval) && interval >= 5 && interval <= 600 ? interval : 25,
          defaultTagged: map.get("beat_voice_tag_default") === true,
          tagAssetId: tagName ? tagId : null,
          tagName,
        }}
        maxBytes={getMaxUploadBytes()}
      />
    </div>
  );
}
