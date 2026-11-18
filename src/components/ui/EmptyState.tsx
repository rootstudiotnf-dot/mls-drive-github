import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type EmptyStateProps = {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
};

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-block border border-dashed border-line-hover px-6 py-16 text-center",
        className,
      )}
    >
      {icon ? (
        <span className="mb-5 flex size-12 items-center justify-center rounded-pill bg-tone-3 text-text-2">
          {icon}
        </span>
      ) : null}
      <h2 className="text-heading text-text">{title}</h2>
      {description ? (
        <p className="mt-2 max-w-sm text-body text-text-2">{description}</p>
      ) : null}
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}
