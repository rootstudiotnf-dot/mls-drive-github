import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { notify } from "@/lib/notifications/notify";
import { clientInfo, hasPasswordAccess, IP_REQUESTS_PER_MINUTE, listShareItems, loadShare, rateLimit, recordEvent, signThumbs } from "@/lib/share/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PasswordGate } from "./PasswordGate";
import { PublicShare } from "./PublicShare";

export const dynamic = "force-dynamic";
// Nada indexable ni cacheable (también por cabeceras en next.config.ts) y sin título que descubra el contenido
export const metadata: Metadata = { title: "Enlace compartido", robots: { index: false, follow: false, nocache: true }, referrer: "no-referrer" };

/**
 * Página PÚBLICA de un enlace externo. Token inexistente, caducado, revocado o cuyo creador ya no tiene acceso:
 * el mismo 404 neutro. Con contraseña, solo se muestra la pantalla de contraseña (sin título ni contenido).
 */
export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const client = await clientInfo();
  if (!client || !(await rateLimit(`ip:${client.ipHash}`, 60, IP_REQUESTS_PER_MINUTE))) notFound();
  const link = await loadShare(token);
  if (!link) notFound();
  if (!(await hasPasswordAccess(link))) return <PasswordGate token={token} />;

  // Apertura: contador atómico y, la PRIMERA vez, aviso a quien creó el enlace
  const { data: first } = await createAdminClient().rpc("share_register_open", { p_link: link.id });
  await recordEvent(link.id, "open", client);
  if (first === true && link.created_by) {
    await notify("link_opened", { recipients: [link.created_by], groupKey: `link-opened:${link.id}`, payload: { title: link.title, path: `/accesos?tab=enlaces&enlace=${link.id}` } });
  }

  const page = await listShareItems(link, null);
  return (
    <PublicShare
      token={token}
      title={link.title}
      message={link.message}
      type={link.resource_type}
      canDownload={link.can_download}
      canComment={link.can_comment}
      expiresAt={link.expires_at}
      initial={{ ...page, thumbs: await signThumbs(page.items) }}
    />
  );
}
