"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SessionPhoto } from "@/lib/sessions/types";
import { layoutRows, ratioOf, visibleRowRange } from "./layout";

export const GAP = 6;
/** A partir de aquí solo se pintan las filas cercanas a la pantalla (virtualización). */
export const VIRTUALIZE_AFTER = 200;

/**
 * Mosaico de fotos con filas justificadas. Las alturas se calculan con `width`/`height`, así que NO hay saltos
 * de layout al cargar las imágenes; con más de 200 fotos solo se pintan las filas visibles más un margen de
 * pantalla y media, lo que mantiene estable el uso de memoria aunque la sesión tenga miles de fotos.
 */
export function JustifiedGrid({
  photos,
  renderTile,
}: {
  photos: SessionPhoto[];
  renderTile: (photo: SessionPhoto, box: { width: number; height: number }, index: number) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [window_, setWindow] = useState({ from: 0, to: 2000 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)));
    observer.observe(el);
    setWidth(Math.floor(el.clientWidth));
    return () => observer.disconnect();
  }, []);

  const targetHeight = width < 520 ? 120 : width < 900 ? 170 : 230;
  const layout = useMemo(
    () => layoutRows(photos.map((p) => ({ id: p.id, ratio: ratioOf(p.width, p.height) })), width, targetHeight, GAP),
    [photos, width, targetHeight],
  );
  const byId = useMemo(() => new Map(photos.map((p, i) => [p.id, { photo: p, index: i }])), [photos]);
  const virtual = photos.length > VIRTUALIZE_AFTER;

  // Ventana visible relativa al contenedor (con un margen de pantalla y media)
  useEffect(() => {
    if (!virtual) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const el = ref.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      const vh = window.innerHeight;
      const from = Math.max(0, -top - vh * 1.5);
      const to = -top + vh * 2.5;
      setWindow((current) => (Math.abs(current.from - from) < vh * 0.25 && Math.abs(current.to - to) < vh * 0.25 ? current : { from, to }));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [virtual, layout.height]);

  const range = virtual ? visibleRowRange(layout.rows, window_.from, window_.to) : { first: 0, last: layout.rows.length - 1 };
  const shown = layout.rows.slice(range.first, range.last + 1);

  return (
    <div ref={ref} className="relative w-full" style={{ height: layout.height }}>
      {shown.map((row) => (
        <div key={row.items[0]?.id} className="absolute right-0 left-0 flex" style={{ top: row.top, height: row.height, gap: GAP }}>
          {row.items.map((item) => {
            const entry = byId.get(item.id);
            if (!entry) return null;
            return (
              <div key={item.id} className="relative flex-none" style={{ width: item.width, height: row.height }}>
                {renderTile(entry.photo, { width: item.width, height: row.height }, entry.index)}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
