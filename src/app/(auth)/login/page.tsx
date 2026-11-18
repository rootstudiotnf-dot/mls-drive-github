import type { Metadata } from "next";
import { AuthShell } from "@/components/layout/AuthShell";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Entrar" };

const ERRORS: Record<string, string> = {
  link: "El enlace no es válido o ha caducado. Pide uno nuevo.",
  disabled: "No se pudo mantener tu sesión. Vuelve a entrar o contacta con el administrador.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const { error } = await searchParams;
  const key = Array.isArray(error) ? error[0] : error;

  return (
    <AuthShell
      title="Entrar"
      description="Accede con tu cuenta de MLS Drive."
      footer="Plataforma privada. El acceso es solo por invitación."
    >
      <LoginForm initialError={key ? ERRORS[key] : undefined} />
    </AuthShell>
  );
}
