import { AuthShell } from "@/components/layout/AuthShell";
import { ButtonLink } from "@/components/ui/ButtonLink";

/** 404 único para todo: no existe, no tienes acceso o el enlace ya no vale (nunca se distingue). */
export default function NotFound() {
  return (
    <AuthShell title="No encontrado" description="Esta página no existe o no tienes acceso a ella.">
      <ButtonLink href="/" className="w-full">
        Ir al inicio
      </ButtonLink>
    </AuthShell>
  );
}
