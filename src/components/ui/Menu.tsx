"use client";

import { useEffect, useId, useRef, useState } from "react";
import { MoreIcon } from "@/components/icons";
import { cn } from "@/lib/cn";
import { Button } from "./Button";

export type MenuItem = {
  label: string;
  onSelect: () => void;
  destructive?: boolean;
};

export type MenuProps = {
  /** Texto accesible del botón (obligatorio: es solo-icono). */
  label: string;
  items: MenuItem[];
  className?: string;
};

/** Menú de acciones desplegable: Esc cierra, flechas navegan, clic fuera cierra. */
export function Menu({ label, items, className }: MenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (open) rootRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const nodes = Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    if (nodes.length === 0) return;
    event.preventDefault();
    const index = nodes.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    nodes[(index + step + nodes.length) % nodes.length]?.focus();
  };

  return (
    <div ref={rootRef} className={cn("relative", className)} onKeyDown={onKeyDown}>
      <Button
        ref={triggerRef}
        variant="ghost"
        size="icon"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreIcon size={18} />
      </Button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          className="absolute top-full right-0 z-20 mt-1.5 min-w-52 rounded-card border border-line-hover bg-surface p-1"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                close(false);
                item.onSelect();
              }}
              className={cn(
                "flex h-9 w-full items-center rounded-control px-3 text-left text-body",
                "transition-colors duration-150 ease-ui hover:bg-active",
                item.destructive ? "text-text" : "text-text-2 hover:text-text",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
