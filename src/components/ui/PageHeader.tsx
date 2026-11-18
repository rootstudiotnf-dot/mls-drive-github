import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type PageHeaderProps = {
  title: string;
  description?: string;
  /** Línea pequeña sobre el título (p. ej. la fecha). */
  eyebrow?: string;
  /** Acciones alineadas a la derecha (botones, buscador). */
  actions?: ReactNode;
  className?: string;
};

export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <header
      className={cn(
        "flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between",
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow ? (
          <p className="mb-2 text-label text-text-3 first-letter:uppercase">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-title text-text">{title}</h1>
        {description ? (
          <p className="mt-2 max-w-xl text-body text-text-2">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-3">{actions}</div>
      ) : null}
    </header>
  );
}
