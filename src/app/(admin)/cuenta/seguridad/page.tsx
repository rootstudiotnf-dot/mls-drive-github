import type { Metadata } from "next";
import { getMfaStatus } from "../actions";
import { PageHeader } from "@/components/ui/PageHeader";
import { TextLink } from "@/components/ui/TextLink";
import { SecurityPanel } from "@/components/vault/SecurityPanel";
import { requireActor } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Seguridad de la cuenta" };
export const dynamic = "force-dynamic";

export default async function SecurityPage() {
  await requireActor();
  const status = await getMfaStatus();
  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Seguridad de la cuenta" description="Verificación en dos pasos y códigos de recuperación." actions={<TextLink href="/">Volver</TextLink>} />
      <SecurityPanel initial={status.ok && status.data ? status.data : { enrolled: false, recoveryLeft: 0 }} />
    </div>
  );
}
