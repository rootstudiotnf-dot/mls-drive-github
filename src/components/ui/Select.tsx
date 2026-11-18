import type { SelectHTMLAttributes } from "react";
import { useId } from "react";
import { ChevronIcon } from "@/components/icons";
import { cn } from "@/lib/cn";

export type SelectOption = { value: string; label: string };

export type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> & {
  label?: string;
  options: SelectOption[];
};

/** Select nativo con aspecto propio: conserva teclado y accesibilidad del navegador. */
export function Select({ label, options, id, className, ...props }: SelectProps) {
  const autoId = useId();
  const selectId = id ?? autoId;

  return (
    <div className="flex flex-col gap-1.5">
      {label ? (
        <label htmlFor={selectId} className="text-label font-medium text-text-2">
          {label}
        </label>
      ) : null}
      <div className="relative">
        <select
          id={selectId}
          className={cn(
            "h-10 w-full appearance-none rounded-control border border-line bg-surface pr-9 pl-3",
            "text-body text-text transition-colors duration-150 ease-ui",
            "hover:border-line-hover focus-visible:border-line-hover",
            className,
          )}
          {...props}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronIcon
          size={16}
          className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-text-3"
        />
      </div>
    </div>
  );
}
