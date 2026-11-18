/** Color medio de una imagen pequeña (RGBA) como «#rrggbb». Ignora los píxeles transparentes. */
export function averageColor(rgba: Uint8ClampedArray): string | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if ((rgba[i + 3] as number) === 0) continue;
    r += rgba[i] as number;
    g += rgba[i + 1] as number;
    b += rgba[i + 2] as number;
    n++;
  }
  if (n === 0) return null;
  const hex = (v: number) => Math.round(v / n).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}
