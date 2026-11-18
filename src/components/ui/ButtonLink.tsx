import Link from "next/link";
import type { ComponentProps } from "react";
import { buttonClasses } from "./Button";

type ButtonLinkProps = Omit<ComponentProps<typeof Link>, "className"> & {
  variant?: "primary" | "ghost";
  size?: "sm" | "md";
  className?: string;
};

/** Enlace con el aspecto de un Button (navegación, no acción). */
export function ButtonLink({ variant = "primary", size = "md", className, ...props }: ButtonLinkProps) {
  return <Link className={buttonClasses(variant, size, className)} {...props} />;
}
