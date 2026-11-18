import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Contenedor para varias DataRow: borde exterior y separadores internos. */
export function DataList({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "divide-y divide-line overflow-hidden rounded-card border border-line bg-surface",
        className,
      )}
      {...props}
    />
  );
}

export type DataRowProps = {
  leading?: ReactNode;
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
  className?: string;
};

export function DataRow({
  leading,
  title,
  subtitle,
  trailing,
  className,
}: DataRowProps) {
  return (
    <div
      className={cn(
        "flex min-h-16 items-center gap-4 px-4 py-3 transition-colors duration-150 ease-ui hover:bg-hover",
        className,
      )}
    >
      {leading ? <div className="shrink-0">{leading}</div> : null}
      <div className="min-w-0 flex-1">
        <p className="truncate text-body font-medium text-text">{title}</p>
        {subtitle ? (
          <p className="truncate text-label text-text-2">{subtitle}</p>
        ) : null}
      </div>
      {trailing ? (
        <div className="flex shrink-0 items-center gap-3">{trailing}</div>
      ) : null}
    </div>
  );
}
