"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogoutIcon } from "@/components/icons";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { signOut } from "@/lib/auth/actions";
import { cn } from "@/lib/cn";
import { Brand } from "./Brand";

export type PortalLink = { href: string; label: string };

/**
 * Cabecera del portal (artistas y colaboradores): sin barra lateral, solo marca, un par de enlaces y la
 * persona. Es cosmética: lo que cada persona ve lo decide el servidor y RLS.
 */
export function PortalShell({
  user,
  links,
  children,
}: {
  user: { name: string; roleName: string };
  links: PortalLink[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <>
      <a
        href="#contenido"
        className="fixed top-3 left-3 z-50 -translate-y-20 rounded-pill bg-text px-4 py-2 text-label font-medium text-bg transition-transform duration-150 ease-ui focus-visible:translate-y-0"
      >
        Saltar al contenido
      </a>
      <header className="sticky top-0 z-30 border-b border-line bg-bg">
        <div className="mx-auto flex h-14 w-full max-w-[1400px] items-center justify-between gap-4 px-5 sm:px-8 xl:px-12">
          <div className="flex min-w-0 items-center gap-6 sm:gap-8">
            <Brand href="/espacio" />
            <nav aria-label="Principal">
              <ul className="flex items-center gap-1">
                {links.map((link) => {
                  const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
                  return (
                    <li key={link.href}>
                      <Link
                        href={link.href}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "inline-flex h-9 items-center rounded-pill px-3.5 text-label font-medium transition-colors duration-150 ease-ui",
                          active ? "bg-active text-text" : "text-text-2 hover:bg-hover hover:text-text",
                        )}
                      >
                        {link.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <div className="hidden min-w-0 text-right sm:block">
              <p className="truncate text-label font-medium text-text">{user.name}</p>
              <p className="truncate text-caption text-text-2">{user.roleName}</p>
            </div>
            <NotificationBell placement="header" />
            <Avatar name={user.name} size="sm" />
            <form action={signOut}>
              <Button type="submit" variant="ghost" size="icon" aria-label="Cerrar sesión" title="Cerrar sesión">
                <LogoutIcon size={18} />
              </Button>
            </form>
          </div>
        </div>
      </header>
      <main id="contenido">
        <div className="mx-auto w-full max-w-[1400px] px-5 py-8 sm:px-8 sm:py-10 xl:px-12">{children}</div>
      </main>
    </>
  );
}
