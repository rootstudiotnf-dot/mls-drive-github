import Link from "next/link";
import { cn } from "@/lib/cn";

export type BrandProps = {
  /** Si se indica, el logotipo es un enlace. */
  href?: string;
  className?: string;
};

export function Brand({ href, className }: BrandProps) {
  const content = (
    <>
      <span
        aria-hidden="true"
        className="flex size-7 items-center justify-center rounded-control bg-text text-caption font-semibold text-bg"
      >
        M
      </span>
      <span className="text-body font-semibold tracking-[-0.01em] text-text">MLS Drive</span>
    </>
  );
  const classes = cn("flex items-center gap-2.5 rounded-control", className);

  return href ? (
    <Link href={href} className={classes}>
      {content}
    </Link>
  ) : (
    <div className={classes}>{content}</div>
  );
}
