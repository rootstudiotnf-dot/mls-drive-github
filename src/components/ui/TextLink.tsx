import Link from "next/link";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

/** Enlace de texto discreto (acciones secundarias). */
export function TextLink({ className, ...props }: ComponentProps<typeof Link>) {
  return (
    <Link
      className={cn(
        "rounded-control text-label font-medium text-text-2 transition-colors duration-150 ease-ui hover:text-text",
        className,
      )}
      {...props}
    />
  );
}
