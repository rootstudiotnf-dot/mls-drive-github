import Link from "next/link";
import type { ReactNode } from "react";
import { ImageIcon } from "@/components/icons";
import { cn } from "@/lib/cn";

export type PhotoTileProps = {
  ratio?: "4/5" | "16/9";
  /** Tono de placeholder (1–5) hasta que haya fotos reales. */
  tone?: 1 | 2 | 3 | 4 | 5;
  title?: string;
  meta?: string;
  href?: string;
  /** Miniatura real (URL firmada). Sin ella se muestra el marcador de posición. */
  imageUrl?: string;
  /** Icono del marcador de posición (por defecto, imagen). */
  icon?: ReactNode;
  className?: string;
};

const ratios = {
  "4/5": "aspect-[4/5]",
  "16/9": "aspect-video",
} as const;

const toneClass = {
  1: "bg-tone-1",
  2: "bg-tone-2",
  3: "bg-tone-3",
  4: "bg-tone-4",
  5: "bg-tone-5",
} as const;

export function PhotoTile({
  ratio = "4/5",
  tone = 1,
  title,
  meta,
  href,
  imageUrl,
  icon,
  className,
}: PhotoTileProps) {
  const content = (
    <>
      <div
        className={cn(
          "relative flex w-full items-center justify-center overflow-hidden rounded-card border border-line",
          "transition-colors duration-150 ease-ui group-hover:border-line-hover",
          ratios[ratio],
          toneClass[tone],
        )}
      >
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageUrl} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />
        ) : (
          (icon ?? <ImageIcon size={24} className="text-text-3" />)
        )}
      </div>
      {title || meta ? (
        <div className="mt-3 min-w-0">
          {title ? (
            <p className="truncate text-body font-medium text-text">{title}</p>
          ) : null}
          {meta ? (
            <p className="truncate text-label text-text-2">{meta}</p>
          ) : null}
        </div>
      ) : null}
    </>
  );

  const base = cn("group block min-w-0", className);

  return href ? (
    <Link href={href} className={cn(base, "rounded-card")}>
      {content}
    </Link>
  ) : (
    <div className={base}>{content}</div>
  );
}
