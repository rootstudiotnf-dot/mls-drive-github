import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { VaultLogView } from "@/components/vault/VaultLogView";
import { PageHeader } from "@/components/ui/PageHeader";
import { TextLink } from "@/components/ui/TextLink";
import { ADMIN_SHELL_PERMISSIONS } from "@/lib/permissions/portal";
import { requirePagePermission } from "@/lib/permissions/server";
import { getVaultState } from "@/lib/vault/access";

export const metadata: Metadata = { title: "Registro del Vault" };
export const dynamic = "force-dynamic";

/** Registro completo del Vault: solo el owner (y con el Vault desbloqueado). Cualquier otra persona recibe un 404. */
export default async function VaultLogPage() {
  await requirePagePermission(...ADMIN_SHELL_PERMISSIONS);
  const state = await getVaultState();
  if (state.state === "no-access") notFound();
  if (state.state !== "open") redirect("/vault");
  if (state.actor.roleKey !== "owner") notFound();
  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Registro del Vault" description="Cada apertura, listado, vista previa, descarga, subida, movimiento y cambio de acceso. Solo se puede añadir: nunca editar ni borrar." actions={<TextLink href="/vault">Volver al Vault</TextLink>} />
      <VaultLogView />
    </div>
  );
}
