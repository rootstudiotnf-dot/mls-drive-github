"use client";

import { useState, useTransition } from "react";
import { sendTestAlertEmail } from "@/app/(admin)/admin/estado/actions";
import { Button } from "@/components/ui/Button";

/** Envía un correo de prueba al owner para comprobar que las alertas llegan. */
export function TestAlertButton() {
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex items-center gap-3">
      {message ? (
        <span role="status" className="text-label text-text-2">
          {message}
        </span>
      ) : null}
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const res = await sendTestAlertEmail();
            setMessage(res.message ?? (res.ok ? "Enviado." : "No se pudo enviar."));
          })
        }
      >
        Enviar correo de prueba
      </Button>
    </div>
  );
}
