import Link from "next/link";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

type ButtonChip = ComponentProps<"button"> & { selected?: boolean; href?: undefined };
type LinkChip = Omit<ComponentProps<typeof Link>, "className"> & { selected?: boolean; className?: string };
export type ChipProps = ButtonChip | LinkChip;

const base =
  "inline-flex h-8 items-center rounded-pill border px-3.5 text-label font-medium whitespace-nowrap transition-[background-color,border-color,color] duration-150 ease-ui";
const look = (selected: boolean) =>
  selected
    ? "border-line-hover bg-active text-text"
    : "border-line bg-transparent text-text-2 hover:border-line-hover hover:text-text";

/** Chip de filtro: botón, o enlace si se indica `href` (filtros que viven en la URL). */
export function Chip(props: ChipProps) {
  if (props.href !== undefined) {
    const { selected = false, className, ...rest } = props as LinkChip;
    return <Link aria-current={selected ? "true" : undefined} className={cn(base, look(selected), className)} {...rest} />;
  }
  const { selected = false, className, type = "button", ...rest } = props as ButtonChip;
  return (
    <button type={type} aria-pressed={selected} className={cn(base, look(selected), className)} {...rest} />
  );
}
