"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { listNotifications, markAllNotificationsRead, markNotificationRead, type Inbox } from "@/app/actions/notifications";
import { BellIcon } from "@/components/icons";
import { cn } from "@/lib/cn";

const POLL_MS = 60_000;
const EMPTY: Inbox = { items: [], unread: 0 };
const when = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Atlantic/Canary" });

/**
 * Campana de avisos: bandeja interna con contador. Cada persona solo ve lo suyo (RLS + filtro por usuario en servidor);
 * el texto nunca incluye datos del Vault. Se refresca cada minuto (solo con la pestaña visible) y al abrirla.
 */
export function NotificationBell({ placement }: { placement: "sidebar" | "header" }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [inbox, setInbox] = useState<Inbox>(EMPTY);
  const root = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const res = await listNotifications();
    if (res.ok && res.data) setInbox(res.data);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      void listNotifications().then((res) => {
        if (!cancelled && res.ok && res.data) setInbox(res.data);
      });
    };
    load();
    const timer = window.setInterval(load, POLL_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onDown = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  const toggle = () => {
    setOpen((v) => !v);
    if (!open) void refresh();
  };

  const openItem = async (id: string, path: string, read: boolean) => {
    setOpen(false);
    if (!read) {
      setInbox((cur) => ({ unread: Math.max(0, cur.unread - 1), items: cur.items.map((i) => (i.id === id ? { ...i, read: true } : i)) }));
      await markNotificationRead(id);
    }
    router.push(path);
  };

  const markAll = async () => {
    setInbox((cur) => ({ unread: 0, items: cur.items.map((i) => ({ ...i, read: true })) }));
    await markAllNotificationsRead();
  };

  const label = inbox.unread > 0 ? `Avisos, ${inbox.unread} sin leer` : "Avisos";

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-label={label}
        title="Avisos"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={toggle}
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-pill text-text-2 transition-colors duration-150 ease-ui hover:bg-hover hover:text-text"
      >
        <BellIcon size={18} />
        {inbox.unread > 0 ? (
          <span aria-hidden="true" className="absolute top-0.5 right-0 min-w-4 rounded-pill bg-text px-1 text-center text-caption leading-4 font-medium text-bg">
            {inbox.unread > 9 ? "9+" : inbox.unread}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          role="region"
          aria-label="Avisos"
          className={cn(
            "z-50 flex max-h-[70dvh] flex-col overflow-hidden rounded-card border border-line-hover bg-surface",
            placement === "sidebar" ? "fixed inset-x-3 bottom-3 nav:absolute nav:inset-x-auto nav:bottom-full nav:left-0 nav:mb-2 nav:w-80" : "fixed inset-x-3 top-16 sm:absolute sm:inset-x-auto sm:top-full sm:right-0 sm:mt-2 sm:w-96",
          )}
        >
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
            <p className="text-label font-medium text-text">Avisos</p>
            {inbox.unread > 0 ? (
              <button type="button" onClick={() => void markAll()} className="rounded-control text-caption text-text-2 hover:text-text">
                Marcar todo como leído
              </button>
            ) : null}
          </div>
          {inbox.items.length === 0 ? (
            <p className="px-4 py-8 text-center text-label text-text-3">No tienes avisos.</p>
          ) : (
            <ul className="divide-y divide-line overflow-y-auto">
              {inbox.items.map((item) => (
                <li key={item.id}>
                  <button type="button" onClick={() => void openItem(item.id, item.path, item.read)} className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors duration-150 ease-ui hover:bg-hover">
                    <span aria-hidden="true" className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-pill", item.read ? "bg-transparent" : "bg-text")} />
                    <span className="min-w-0 flex-1">
                      <span className={cn("block text-label break-words", item.read ? "text-text-2" : "text-text")}>{item.text}</span>
                      <time className="text-caption text-text-3">{when.format(new Date(item.createdAt))}</time>
                    </span>
                    {item.read ? null : <span className="sr-only">Sin leer</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="border-t border-line px-4 py-2.5">
            <Link href="/cuenta/notificaciones" onClick={() => setOpen(false)} className="rounded-control text-caption text-text-2 hover:text-text">
              Preferencias de avisos
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
