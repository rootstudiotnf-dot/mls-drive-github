"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";

export type ToggleProps = {
  /** Texto accesible (obligatorio: el control no tiene texto visible). */
  label: string;
  /** Modo no controlado: estado inicial. */
  defaultChecked?: boolean;
  /** Modo controlado: si se pasa `checked`, el padre manda (usa también `onChange`). */
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
};

export function Toggle({
  label,
  defaultChecked = false,
  checked: controlled,
  onChange,
  disabled,
  className,
}: ToggleProps) {
  const [internal, setInternal] = useState(defaultChecked);
  const checked = controlled ?? internal;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => {
        const next = !checked;
        if (controlled === undefined) setInternal(next);
        onChange?.(next);
      }}
      className={cn(
        "relative inline-flex h-6 w-10 shrink-0 items-center rounded-pill border p-0.5",
        "transition-colors duration-200 ease-ui disabled:opacity-40",
        checked ? "border-transparent bg-text" : "border-line-hover bg-tone-4",
        className,
      )}
    >
      <span
        className={cn(
          "block size-[18px] rounded-pill transition-transform duration-200 ease-ui",
          checked ? "translate-x-4 bg-bg" : "translate-x-0 bg-text-2",
        )}
      />
    </button>
  );
}
