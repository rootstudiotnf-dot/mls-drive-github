import Link from "next/link";
import { cn } from "@/lib/cn";

export type TabNavItem = { href: string; label: string };

export type TabNavProps = {
  /** Texto accesible de la navegación. */
  label: string;
  items: TabNavItem[];
  /** href de la pestaña activa. */
  current: string;
  className?: string;
};

/** Pestañas de navegación entre pantallas hermanas (son enlaces, no paneles). */
export function TabNav({ label, items, current, className }: TabNavProps) {
  return (
    <nav aria-label={label} className={cn("border-b border-line", className)}>
      <ul className="-mb-px flex gap-6">
        {items.map((item) => {
          const active = item.href === current;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex h-11 items-center border-b-2 text-body font-medium",
                  "transition-colors duration-150 ease-ui",
                  active
                    ? "border-text text-text"
                    : "border-transparent text-text-2 hover:text-text",
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
