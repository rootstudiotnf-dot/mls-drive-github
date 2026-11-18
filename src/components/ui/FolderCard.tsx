import Link from "next/link";
import type { ReactNode } from "react";
import { FolderIcon } from "@/components/icons";
import { cn } from "@/lib/cn";

export type FolderCardProps = {
  name: string;
  meta?: string;
  href?: string;
  /** Icono propio (p. ej. un candado en el Vault); por defecto, una carpeta. */
  icon?: ReactNode;
  className?: string;
};

export function FolderCard({ name, meta, href, icon, className }: FolderCardProps) {
  const classes = cn(
    "group flex min-w-0 items-center gap-3.5 rounded-card border border-line bg-surface p-4",
    "transition-colors duration-150 ease-ui",
    href && "hover:border-line-hover",
    className,
  );

  const content = (
    <>
      <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-tone-3 text-text-2">
        {icon ?? <FolderIcon size={20} />}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-body font-medium text-text">
          {name}
        </span>
        {meta ? (
          <span className="block truncate text-label text-text-2">{meta}</span>
        ) : null}
      </span>
    </>
  );

  return href ? (
    <Link href={href} className={classes}>
      {content}
    </Link>
  ) : (
    <div className={classes}>{content}</div>
  );
}
