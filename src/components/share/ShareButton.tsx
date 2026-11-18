"use client";

import { useState } from "react";
import type { ShareTarget } from "@/app/actions/share";
import { ShareIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { ShareDialog } from "./ShareDialog";

/** Botón «Compartir» + el modal único. Cosmética: lo que se comparte lo vuelve a comprobar el servidor. */
export function ShareButton({ target, defaultTitle, label = "Compartir", variant = "ghost", size = "sm" }: { target: ShareTarget; defaultTitle: string; label?: string; variant?: "primary" | "ghost"; size?: "sm" | "md" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)}>
        <ShareIcon size={16} />
        {label}
      </Button>
      <ShareDialog open={open} onClose={() => setOpen(false)} target={target} defaultTitle={defaultTitle} />
    </>
  );
}
