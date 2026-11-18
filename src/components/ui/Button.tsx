import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

type CommonProps = {
  variant?: "primary" | "ghost";
};

type TextButtonProps = CommonProps & {
  size?: "sm" | "md";
};

/** Un botón solo-icono exige aria-label (se comprueba en compilación). */
type IconButtonProps = CommonProps & {
  size: "icon";
  "aria-label": string;
};

export type ButtonProps = ComponentProps<"button"> & (TextButtonProps | IconButtonProps);

const variants = {
  primary: "bg-text text-bg border border-transparent hover:bg-text-2",
  ghost:
    "bg-transparent text-text border border-line hover:border-line-hover hover:bg-hover",
} as const;

const sizes = {
  sm: "h-8 px-3.5 text-label gap-1.5",
  md: "h-10 px-5 text-body gap-2",
  icon: "size-9 justify-center",
} as const;

/** Clases del botón (también las usa ButtonLink para los enlaces con aspecto de botón). */
export function buttonClasses(variant: "primary" | "ghost" = "primary", size: "sm" | "md" | "icon" = "md", className?: string) {
  return cn(
    "inline-flex shrink-0 items-center justify-center rounded-pill font-medium whitespace-nowrap",
    "transition-[background-color,border-color,transform] duration-150 ease-ui",
    "active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40",
    variants[variant],
    sizes[size],
    className,
  );
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  type = "button",
  ...props
}: ButtonProps) {
  return <button type={type} className={buttonClasses(variant, size, className)} {...props} />;
}
