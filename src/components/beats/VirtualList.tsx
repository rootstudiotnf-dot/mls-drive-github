"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/**
 * Lista/cuadrícula virtualizada de elementos de tamaño fijo (la ventana de scroll es la de la página). Solo se pinta
 * lo cercano a la pantalla (+ un margen), así que 5.000 beats no cuestan más que 50. `minColumnWidth` = 0 → lista.
 * Avisa con `onNearEnd` al acercarse al final para cargar la página siguiente.
 */
export function VirtualList<T>({
  items,
  rowHeight,
  gap = 0,
  minColumnWidth = 0,
  extraHeight = 0,
  render,
  getKey,
  onNearEnd,
  label,
}: {
  items: T[];
  /** Alto de cada fila; en cuadrícula puede ser una función del ancho de columna. */
  rowHeight: number | ((columnWidth: number) => number);
  gap?: number;
  minColumnWidth?: number;
  /** Alto que se añade al final (p. ej. el indicador «Cargando más…»). */
  extraHeight?: number;
  render: (item: T, index: number, box: { width: number; height: number }) => ReactNode;
  getKey: (item: T) => string;
  onNearEnd?: () => void;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [range, setRange] = useState({ from: 0, to: 3000 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const columns = minColumnWidth > 0 && width > 0 ? Math.max(1, Math.floor((width + gap) / (minColumnWidth + gap))) : 1;
  const columnWidth = width > 0 ? (width - gap * (columns - 1)) / columns : 0;
  const height = typeof rowHeight === "function" ? rowHeight(columnWidth) : rowHeight;
  const rows = Math.ceil(items.length / columns);
  const total = Math.max(0, rows * (height + gap) - gap) + extraHeight;

  const nearEnd = useRef(onNearEnd);
  useEffect(() => {
    nearEnd.current = onNearEnd;
  }, [onNearEnd]);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const el = ref.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      const vh = window.innerHeight;
      setRange((current) => {
        const from = Math.max(0, -top - vh);
        const to = -top + vh * 2;
        return Math.abs(current.from - from) < vh * 0.2 && Math.abs(current.to - to) < vh * 0.2 ? current : { from, to };
      });
      if (-top + vh * 2.5 >= el.offsetHeight) nearEnd.current?.();
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
  }, [total, items.length]);

  const firstRow = Math.max(0, Math.floor(range.from / (height + gap)));
  const lastRow = Math.min(rows - 1, Math.ceil(range.to / (height + gap)));
  const visible = useMemo(() => {
    const out: { item: T; index: number; row: number; col: number }[] = [];
    for (let row = firstRow; row <= lastRow; row++) {
      for (let col = 0; col < columns; col++) {
        const index = row * columns + col;
        const item = items[index];
        if (item !== undefined) out.push({ item, index, row, col });
      }
    }
    return out;
  }, [items, firstRow, lastRow, columns]);

  return (
    <div ref={ref} role="list" aria-label={label} className="relative w-full" style={{ height: total }}>
      {visible.map(({ item, index, row, col }) => (
        <div
          key={getKey(item)}
          role="listitem"
          className="absolute"
          style={{ top: row * (height + gap), left: col * (columnWidth + gap), width: columnWidth, height }}
        >
          {render(item, index, { width: columnWidth, height })}
        </div>
      ))}
    </div>
  );
}
