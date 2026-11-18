/**
 * Maquetación de la galería: filas «justificadas» (mosaico) calculadas a partir de `width` y `height` de cada
 * foto. Como la altura de cada fila se conoce ANTES de cargar ninguna imagen, no hay saltos de layout; y como
 * se conoce la altura total, se puede virtualizar (pintar solo las filas cercanas a la pantalla).
 * Código puro (sin DOM): lo usan el componente y las pruebas.
 */

export type LayoutItem = { id: string; ratio: number };
export type LayoutRow = { top: number; height: number; items: { id: string; width: number }[] };
export type GalleryLayout = { rows: LayoutRow[]; height: number };

/** Proporción (ancho/alto) con límites razonables; sin dimensiones conocidas, 3:2. */
export function ratioOf(width: number | null, height: number | null): number {
  if (!width || !height || width <= 0 || height <= 0) return 1.5;
  return Math.min(4, Math.max(0.25, width / height));
}

export function layoutRows(items: LayoutItem[], containerWidth: number, targetHeight: number, gap: number): GalleryLayout {
  const rows: LayoutRow[] = [];
  if (containerWidth <= 0 || items.length === 0) return { rows, height: 0 };
  let current: LayoutItem[] = [];
  let sum = 0;
  let top = 0;

  const close = (stretch: boolean) => {
    if (current.length === 0) return;
    const gaps = gap * (current.length - 1);
    // Fila completa: se ajusta la altura para ocupar todo el ancho. Última fila: nunca más alta que la objetivo.
    const ideal = (containerWidth - gaps) / sum;
    const height = stretch ? ideal : Math.min(ideal, targetHeight);
    let used = 0;
    const placed = current.map((item, index) => {
      // El último ocupa lo que quede para que la fila cuadre al píxel
      const width = stretch && index === current.length - 1 ? Math.max(1, containerWidth - gaps - used) : Math.floor(item.ratio * height);
      used += width;
      return { id: item.id, width };
    });
    rows.push({ top, height: Math.round(height), items: placed });
    top += Math.round(height) + gap;
    current = [];
    sum = 0;
  };

  for (const item of items) {
    current.push(item);
    sum += item.ratio;
    const projected = sum * targetHeight + gap * (current.length - 1);
    if (projected >= containerWidth) close(true);
  }
  close(false);
  return { rows, height: Math.max(0, top - gap) };
}

/** Índices (inclusive) de las filas que se cruzan con la ventana [from, to] en píxeles. */
export function visibleRowRange(rows: LayoutRow[], from: number, to: number): { first: number; last: number } {
  if (rows.length === 0) return { first: 0, last: -1 };
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const row = rows[mid] as LayoutRow;
    if (row.top + row.height < from) lo = mid + 1;
    else hi = mid;
  }
  const first = lo;
  let last = first;
  while (last + 1 < rows.length && (rows[last + 1] as LayoutRow).top <= to) last++;
  return { first, last };
}
