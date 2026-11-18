import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type SectionHeaderProps = {
  title: string;
  /** Acción secundaria a la derecha (enlace o botón). */
  action?: ReactNode;
  className?: string;
};

export function SectionHeader({ title, action, className }: SectionHeaderProps) {
  return (
    <div className={cn("mb-5 flex items-center justify-between gap-4", className)}>
      <h2 className="text-heading text-text">{title}</h2>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
