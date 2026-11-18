"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";

/** Copia al portapapeles el enlace (relativo al sitio) a la sesión en el portal del artista. */
export function CopyLinkButton({ path, label = "Compartir" }: { path: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(`${window.location.origin}${path}`);
          setState("copied");
        } catch {
          setState("failed");
        }
        setTimeout(() => setState("idle"), 2500);
      }}
    >
      {state === "copied" ? "Enlace copiado" : state === "failed" ? "No se pudo copiar" : label}
    </Button>
  );
}
