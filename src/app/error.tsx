"use client";

import { useEffect } from "react";
import { reportClientError } from "@/app/actions/report";
import { AuthShell } from "@/components/layout/AuthShell";
import { Button } from "@/components/ui/Button";
import { ButtonLink } from "@/components/ui/ButtonLink";

/** Error inesperado en una pantalla: mensaje neutro (sin detalles técnicos) y opción de reintentar. */
export default function ErrorPage({ error, unstable_retry }: { error: Error & { digest?: string }; unstable_retry: () => void }) {
  useEffect(() => {
    void reportClientError({ name: error.name, digest: error.digest });
  }, [error]);

  return (
    <AuthShell title="Algo no ha ido bien" description="Ha ocurrido un error inesperado. Ya queda registrado. Puedes volver a intentarlo.">
      <div className="flex flex-col gap-3">
        <Button onClick={() => unstable_retry()}>Reintentar</Button>
        <ButtonLink href="/" variant="ghost">
          Ir al inicio
        </ButtonLink>
      </div>
    </AuthShell>
  );
}
