import type { Metadata } from "next";
import { NewBeatUpload } from "@/components/beats/NewBeatUpload";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { TextLink } from "@/components/ui/TextLink";
import { getMaxUploadBytes } from "@/lib/env";
import { ADMIN_SHELL_PERMISSIONS } from "@/lib/permissions/portal";
import { getEffectiveRole, requirePagePermission } from "@/lib/permissions/server";

export const metadata: Metadata = { title: "Subir beat" };
export const dynamic = "force-dynamic";

export default async function NewBeatPage() {
  await requirePagePermission(...ADMIN_SHELL_PERMISSIONS);
  await requirePagePermission("beats.upload");
  const role = await getEffectiveRole();
  // Un beat sin artista (biblioteca aparte) solo lo sube un rol con alcance «todos»; el servidor lo vuelve a comprobar
  const allowed = role?.scope === "all";

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Subir beat"
        description="Sube el audio y completa sus datos. El beat queda como borrador hasta que lo publiques."
        actions={<TextLink href="/beats">Volver a beats</TextLink>}
      />
      {allowed ? (
        <NewBeatUpload maxBytes={getMaxUploadBytes()} />
      ) : (
        <Notice variant="error">Tu rol no puede subir beats a la biblioteca general.</Notice>
      )}
    </div>
  );
}
