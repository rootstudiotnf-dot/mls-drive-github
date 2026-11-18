import type { InputHTMLAttributes, ReactNode } from "react";
import { useId } from "react";
import { cn } from "@/lib/cn";

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  hint?: string;
  /** Icono decorativo a la izquierda. */
  icon?: ReactNode;
};

export function Input({
  label,
  hint,
  icon,
  id,
  className,
  ...props
}: InputProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hintId = hint ? `${inputId}-hint` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      {label ? (
        <label htmlFor={inputId} className="text-label font-medium text-text-2">
          {label}
        </label>
      ) : null}
      <div className="relative">
        {icon ? (
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-text-3">
            {icon}
          </span>
        ) : null}
        <input
          id={inputId}
          aria-describedby={hintId}
          className={cn(
            "h-10 w-full rounded-control border border-line bg-surface text-body text-text",
            "placeholder:text-text-3 transition-colors duration-150 ease-ui",
            "hover:border-line-hover focus-visible:border-line-hover",
            icon ? "pl-9 pr-3" : "px-3",
            className,
          )}
          {...props}
        />
      </div>
      {hint ? (
        <p id={hintId} className="text-caption text-text-3">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
