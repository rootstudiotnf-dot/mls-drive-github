"use client";

import { usePathname } from "next/navigation";
import { TabNav, type TabNavItem } from "@/components/ui/TabNav";

/** TabNav cuya pestaña activa sale de la ruta actual (para pestañas que son páginas distintas). */
export function PathTabNav({ label, items, className }: { label: string; items: TabNavItem[]; className?: string }) {
  const pathname = usePathname();
  // La activa es la de href más largo que coincida con la ruta (la raíz solo con ruta exacta)
  const current =
    [...items]
      .sort((a, b) => b.href.length - a.href.length)
      .find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))?.href ?? items[0]?.href ?? "";
  return <TabNav label={label} items={items} current={current} className={className} />;
}
