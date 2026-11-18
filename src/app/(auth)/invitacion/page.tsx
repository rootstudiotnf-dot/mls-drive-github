import type { Metadata } from "next";
import { AuthShell } from "@/components/layout/AuthShell";
import { TextLink } from "@/components/ui/TextLink";
import { createClient } from "@/lib/supabase/server";
import { isPast } from "@/lib/time";
import { InvitationForm } from "./InvitationForm";

export const metadata: Metadata = { title: "Invitación" };

type PendingInvitation = {
  id: string;
  email: string;
  role_key: string;
  role_name: string;
  inviter_name: string | null;
  expires_at: string;
};

function InvalidInvitation({ expired }: { expired: boolean }) {
  return (
    <AuthShell
      title={expired ? "Invitación caducada" : "Enlace no válido"}
      description={
        expired
          ? "Esta invitación ha caducado. Pide al administrador que te envíe una nueva."
          : "Este enlace ya se usó, fue revocado o ha caducado. Si necesitas acceso, pide una nueva invitación al administrador."
      }
    >
      <TextLink href="/login">Ir a iniciar sesión</TextLink>
    </AuthShell>
  );
}

export default async function InvitacionPage() {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return <InvalidInvitation expired={false} />;

  const { data } = await supabase.rpc("my_pending_invitation");
  const invitation = Array.isArray(data) ? (data[0] as PendingInvitation | undefined) : undefined;
  if (!invitation) return <InvalidInvitation expired={false} />;
  if (isPast(invitation.expires_at)) return <InvalidInvitation expired />;

  const inviter = invitation.inviter_name ?? "El administrador";

  return (
    <AuthShell
      title="Te han invitado"
      description={`${inviter} te invita a MLS Drive con el rol ${invitation.role_name}. Crea tu cuenta para entrar.`}
    >
      <InvitationForm email={invitation.email} />
    </AuthShell>
  );
}
