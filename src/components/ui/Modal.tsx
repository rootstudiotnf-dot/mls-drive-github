"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
};

/**
 * Diálogo modal sobre <dialog> nativo: atrapa el foco, cierra con Esc y devuelve el foco
 * al elemento que lo abrió. El contenido solo se monta mientras está abierto (los formularios
 * se reinician al cerrar).
 */
export function Modal({ open, onClose, title, description, children, className }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(event) => {
        // Clic en el velo (el propio <dialog>, no su contenido) → cerrar.
        if (event.target === ref.current) onClose();
      }}
      aria-labelledby="modal-title"
      className={cn(
        "m-auto w-[calc(100%-2.5rem)] max-w-md rounded-block border border-line bg-surface p-0 text-text",
        className,
      )}
    >
      {open ? (
        <div className="p-6">
          <h2 id="modal-title" className="text-heading text-text">
            {title}
          </h2>
          {description ? (
            <p className="mt-1.5 text-body text-text-2">{description}</p>
          ) : null}
          <div className="mt-5">{children}</div>
        </div>
      ) : null}
    </dialog>
  );
}
