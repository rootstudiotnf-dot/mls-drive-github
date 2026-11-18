"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import { unsubscribe } from "./actions";

export function UnsubscribeForm({ token }: { token: string }) {
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<"idle" | "done" | "error">("idle");
  if (state === "done") return <Notice variant="success">Listo: no recibirás más estos correos.</Notice>;
  return (
    <div className="flex flex-col gap-3">
      {state === "error" ? <Notice variant="error">No se pudo completar la baja. Inténtalo de nuevo.</Notice> : null}
      <Button
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const res = await unsubscribe(token);
            setState(res.ok ? "done" : "error");
          })
        }
      >
        Dejar de recibirlos
      </Button>
    </div>
  );
}
