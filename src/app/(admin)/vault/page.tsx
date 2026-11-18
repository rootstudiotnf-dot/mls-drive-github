import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LockIcon } from "@/components/icons";
import { ButtonLink } from "@/components/ui/ButtonLink";
import { EmptyState } from "@/components/ui/EmptyState";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { UnlockForm } from "@/components/vault/UnlockForm";
import { VaultHome } from "@/components/vault/VaultHome";
import { ADMIN_SHELL_PERMISSIONS } from "@/lib/permissions/portal";
import { requirePagePermission } from "@/lib/permissions/server";
import { getVaultState } from "@/lib/vault/access";

export const metadata: Metadata = { title: "Vault" };
export const dynamic = "force-dynamic";

/**
 * El Vault no existe para quien no tiene acceso: sin permiso de administración, sin `vault.view` o sin un grant
 * vigente (el owner no lo necesita) la ruta responde 404. Con acceso, la pantalla depende de lo que falte:
 * configurar el almacenamiento, activar la verificación en dos pasos, desbloquear o ya abierto.
 */
export default async function VaultPage() {
  await requirePagePermission(...ADMIN_SHELL_PERMISSIONS);
  const state = await getVaultState();
  if (state.state === "no-access") notFound();

  return (
    <div className="flex flex-col gap-10">
      <PageHeader title="Vault" description="Material original o sin publicar, con el acceso más estricto de la plataforma." />
      {state.state === "unconfigured" ? (
        <Notice variant="info">
          El Vault todavía no está configurado en este servidor (bucket y token propios, y el secreto de desbloqueo). Sigue <span className="font-medium text-text">docs/SETUP-VAULT.md</span>.
        </Notice>
      ) : state.state === "mfa-required" ? (
        <EmptyState
          icon={<LockIcon size={22} />}
          title="Activa la verificación en dos pasos"
          description="Para abrir el Vault necesitas la verificación en dos pasos (TOTP). Actívala una vez y vuelve aquí."
          action={<ButtonLink href="/cuenta/seguridad">Activar verificación en dos pasos</ButtonLink>}
        />
      ) : state.state === "locked" ? (
        <UnlockForm needsCode={state.needsCode} />
      ) : (
        <VaultHome />
      )}
    </div>
  );
}
