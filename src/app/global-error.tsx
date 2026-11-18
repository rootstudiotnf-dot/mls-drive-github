"use client";

import { useEffect } from "react";
import { reportClientError } from "@/app/actions/report";
import { AuthShell } from "@/components/layout/AuthShell";
import { Button } from "@/components/ui/Button";
import "@/styles/globals.css";

/** Último recurso: falla el propio diseño raíz. Misma estética y mensaje neutro. */
export default function GlobalError({ error, unstable_retry }: { error: Error & { digest?: string }; unstable_retry: () => void }) {
  useEffect(() => {
    void reportClientError({ name: error.name, digest: error.digest });
  }, [error]);

  return (
    <html lang="es">
      <body>
        <AuthShell title="Algo no ha ido bien" description="Ha ocurrido un error inesperado. Ya queda registrado. Puedes volver a intentarlo.">
          <Button onClick={() => unstable_retry()}>Reintentar</Button>
        </AuthShell>
      </body>
    </html>
  );
}
