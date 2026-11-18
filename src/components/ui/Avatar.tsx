import { cn } from "@/lib/cn";

export type AvatarProps = {
  name: string;
  /** Foto (URL firmada de la miniatura). Sin ella se muestran las iniciales. */
  imageUrl?: string;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
};

const sizes = {
  sm: "size-7 text-caption",
  md: "size-9 text-label",
  lg: "size-12 text-body",
  xl: "size-16 text-heading",
} as const;

// Tonos de placeholder (tokens) elegidos de forma estable a partir del nombre.
const tones = ["bg-tone-3", "bg-tone-4", "bg-tone-5"] as const;

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

function toneFor(name: string) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return tones[hash % tones.length] ?? tones[0];
}

export function Avatar({ name, imageUrl, size = "md", className }: AvatarProps) {
  return (
    <span
      role="img"
      aria-label={name}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-pill border border-line font-medium text-text-2 select-none",
        sizes[size],
        toneFor(name),
        className,
      )}
    >
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={imageUrl} alt="" className="absolute inset-0 size-full object-cover" />
      ) : (
        <span aria-hidden="true">{initials(name)}</span>
      )}
    </span>
  );
}
