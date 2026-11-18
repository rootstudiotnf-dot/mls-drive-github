import type { ComponentProps } from "react";
import { useId } from "react";
import { cn } from "@/lib/cn";

export type TextareaProps = ComponentProps<"textarea"> & {
  label?: string;
};

export function Textarea({ label, id, className, ...props }: TextareaProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;

  return (
    <div className="flex flex-col gap-1.5">
      {label ? (
        <label htmlFor={fieldId} className="text-label font-medium text-text-2">
          {label}
        </label>
      ) : null}
      <textarea
        id={fieldId}
        className={cn(
          "min-h-20 w-full resize-y rounded-control border border-line bg-surface px-3 py-2.5 text-body text-text",
          "placeholder:text-text-3 transition-colors duration-150 ease-ui",
          "hover:border-line-hover focus-visible:border-line-hover disabled:opacity-50",
          className,
        )}
        {...props}
      />
    </div>
  );
}
