import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  variant?: "neutral" | "outline" | "solid";
};

const variants = {
  neutral: "bg-active text-text-2 border-transparent",
  outline: "bg-transparent text-text-2 border-line",
  solid: "bg-text text-bg border-transparent",
} as const;

export function Badge({ variant = "neutral", className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-pill border px-2 text-caption font-medium whitespace-nowrap",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
