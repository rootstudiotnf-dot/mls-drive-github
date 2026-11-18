import { SearchIcon } from "@/components/icons";
import { cn } from "@/lib/cn";

export type SearchFieldProps = {
  placeholder?: string;
  className?: string;
};

/** Buscador visual: la búsqueda real llega en una fase posterior. */
export function SearchField({
  placeholder = "Buscar sesiones, artistas, beats",
  className,
}: SearchFieldProps) {
  return (
    <div role="search" className={cn("relative w-full sm:w-80", className)}>
      <SearchIcon
        size={16}
        className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-text-3"
      />
      <input
        type="search"
        aria-label="Buscar"
        placeholder={placeholder}
        className={cn(
          "h-10 w-full rounded-pill border border-line bg-surface pr-14 pl-10 text-body text-text",
          "placeholder:text-text-3 transition-colors duration-150 ease-ui",
          "hover:border-line-hover focus-visible:border-line-hover",
        )}
      />
      <kbd
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 rounded-control border border-line px-1.5 py-0.5 font-sans text-caption text-text-3 sm:block"
      >
        ⌘K
      </kbd>
    </div>
  );
}
