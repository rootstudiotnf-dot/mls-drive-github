"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ChevronIcon, LogoutIcon } from "@/components/icons";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { signOut } from "@/lib/auth/actions";
import { cn } from "@/lib/cn";
import { Brand } from "./Brand";
import { adminNav, mainNav, type NavItem } from "./nav-items";

function isActive(pathname: string, item: NavItem) {
  if (item.href === "/" || item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

function NavGroup({
  items,
  pathname,
  onNavigate,
  label,
}: {
  items: NavItem[];
  pathname: string;
  onNavigate?: () => void;
  label?: string;
}) {
  return (
    <div>
      {label ? (
        <p className="mb-1.5 px-3 text-caption font-medium text-text-3">{label}</p>
      ) : null}
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => {
          const { href, label: itemLabel, icon: Icon } = item;
          const active = isActive(pathname, item);
          return (
            <li key={href}>
              <Link
                href={href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-9 items-center gap-3 rounded-control px-3 text-body font-medium",
                  "transition-colors duration-150 ease-ui",
                  active
                    ? "bg-active text-text"
                    : "text-text-2 hover:bg-hover hover:text-text",
                )}
              >
                <Icon size={18} />
                {itemLabel}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function NavSections({
  pathname,
  allowedHrefs,
  onNavigate,
}: {
  pathname: string;
  allowedHrefs: string[];
  onNavigate?: () => void;
}) {
  const visible = (items: NavItem[]) => items.filter((item) => !item.anyOf || allowedHrefs.includes(item.href));
  const visibleAdmin = visible(adminNav);
  return (
    <nav aria-label="Principal" className="flex flex-col gap-7">
      <NavGroup items={visible(mainNav)} pathname={pathname} onNavigate={onNavigate} />
      {/* Cosmética: la protección real de estas rutas está en servidor y en RLS. */}
      {visibleAdmin.length > 0 ? (
        <NavGroup
          label="Administración"
          items={visibleAdmin}
          pathname={pathname}
          onNavigate={onNavigate}
        />
      ) : null}
    </nav>
  );
}

export type SidebarUser = { name: string; roleName: string };

function UserCard({ user }: { user: SidebarUser }) {
  return (
    <div className="flex items-center gap-3 px-1">
      <Avatar name={user.name} size="md" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-label font-medium text-text">{user.name}</p>
        <p className="truncate text-caption text-text-2">{user.roleName}</p>
      </div>
      <NotificationBell placement="sidebar" />
      <form action={signOut}>
        <Button
          type="submit"
          variant="ghost"
          size="icon"
          aria-label="Cerrar sesión"
          title="Cerrar sesión"
        >
          <LogoutIcon size={18} />
        </Button>
      </form>
    </div>
  );
}

export function Sidebar({ user, allowedHrefs }: { user: SidebarUser; allowedHrefs: string[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      {/* Escritorio: barra lateral fija de 240 px */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-line bg-bg px-3 py-5 nav:flex">
        <div className="px-3 pb-7">
          <Brand href="/" />
        </div>
        <div className="flex-1 overflow-y-auto">
          <NavSections pathname={pathname} allowedHrefs={allowedHrefs} />
        </div>
        <div className="border-t border-line pt-4">
          <UserCard user={user} />
        </div>
      </aside>

      {/* Móvil / tablet estrecha: menú desplegable superior */}
      <header className="sticky top-0 z-30 border-b border-line bg-bg nav:hidden">
        <div className="flex h-14 items-center justify-between px-5">
          <Brand href="/" />
          <button
            type="button"
            aria-label={open ? "Cerrar menú" : "Abrir menú"}
            aria-expanded={open}
            aria-controls="menu-movil"
            onClick={() => setOpen((value) => !value)}
            className="flex h-9 items-center gap-1.5 rounded-pill border border-line pr-3 pl-4 text-label font-medium text-text transition-colors duration-150 ease-ui hover:border-line-hover"
          >
            Menú
            <ChevronIcon
              size={16}
              className={cn(
                "transition-transform duration-200 ease-ui",
                open && "rotate-180",
              )}
            />
          </button>
        </div>
        {open ? (
          <div
            id="menu-movil"
            className="max-h-[calc(100dvh-3.5rem)] overflow-y-auto border-t border-line px-3 pt-4 pb-5"
          >
            <NavSections
              pathname={pathname}
              allowedHrefs={allowedHrefs}
              onNavigate={() => setOpen(false)}
            />
            <div className="mt-6 border-t border-line pt-4">
              <UserCard user={user} />
            </div>
          </div>
        ) : null}
      </header>
    </>
  );
}
