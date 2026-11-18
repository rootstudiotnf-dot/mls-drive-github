import type { ReactNode } from "react";
import { AlertIcon, CheckIcon } from "@/components/icons";
import { cn } from "@/lib/cn";

export type NoticeProps = {
  variant?: "error" | "success" | "info";
  children: ReactNode;
  className?: string;
};

/**
 * Mensaje de estado. Sin colores saturados: el significado lo dan el icono y el texto,
 * y el rol ARIA (`alert` para errores, `status` para el resto) lo anuncia a lectores de pantalla.
 */
export function Notice({ variant = "info", children, className }: NoticeProps) {
  const Icon = variant === "success" ? CheckIcon : AlertIcon;
  return (
    <div
      role={variant === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2.5 rounded-control border px-3.5 py-3 text-label",
        variant === "error"
          ? "border-line-hover bg-tone-2 text-text"
          : "border-line bg-tone-1 text-text-2",
        className,
      )}
    >
      <Icon size={16} className="mt-px shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
