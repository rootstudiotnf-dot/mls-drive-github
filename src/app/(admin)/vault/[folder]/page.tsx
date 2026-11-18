import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { VaultFolderView } from "@/components/vault/VaultFolderView";
import { getMaxUploadBytes } from "@/lib/env";
import { ADMIN_SHELL_PERMISSIONS } from "@/lib/permissions/portal";
import { requirePagePermission } from "@/lib/permissions/server";
import { isUuid } from "@/lib/storage/keys";
import { createClient } from "@/lib/supabase/server";
import { getVaultState } from "@/lib/vault/access";

export const metadata: Metadata = { title: "Vault" };
export const dynamic = "force-dynamic";

export default async function VaultFolderPage({ params }: { params: Promise<{ folder: string }> }) {
  const { folder } = await params;
  await requirePagePermission(...ADMIN_SHELL_PERMISSIONS);
  if (!isUuid(folder)) notFound();
  const state = await getVaultState();
  if (state.state === "no-access") notFound();
  if (state.state !== "open") redirect("/vault"); // bloqueado, sin MFA o sin configurar: la pantalla del Vault lo explica

  // Artistas para el campo informativo «relacionado con» (lectura bajo RLS: solo los que esta persona puede ver)
  const supabase = await createClient();
  const { data } = await supabase.from("artists").select("id, name").is("deleted_at", null).order("name").limit(300);
  return <VaultFolderView folderId={folder} artists={((data ?? []) as { id: string; name: string }[]).map((a) => ({ id: a.id, name: a.name }))} maxBytes={getMaxUploadBytes()} isOwner={state.actor.roleKey === "owner"} />;
}
