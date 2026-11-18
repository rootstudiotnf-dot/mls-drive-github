/**
 * Localiza JPEG incrustados (la vista previa de un RAW: CR2, CR3, ARW, NEF, DNG, RAF) barriendo el archivo
 * POR TROZOS, sin cargarlo entero. Busca marcadores SOI (FF D8 FF) y, para cada candidato, recorre la
 * estructura del JPEG (segmentos con longitud, datos entrópicos de cada scan) hasta su EOI (FF D9). Así un
 * JPEG en miniatura anidado dentro del EXIF de otro no se confunde con una imagen independiente.
 *
 * Código puro: recibe una función de lectura (`File.slice` en el navegador, un Buffer en las pruebas).
 */

export type Reader = (start: number, end: number) => Promise<Uint8Array>;
export type JpegRange = { start: number; end: number; length: number };

const CHUNK = 4 * 1024 * 1024;
const MAX_CANDIDATES = 256;
const MAX_JPEG_BYTES = 80 * 1024 * 1024;

/** Offsets de todos los FF D8 FF del archivo (hasta un máximo). */
async function findSoi(read: Reader, size: number): Promise<number[]> {
  const found: number[] = [];
  for (let at = 0; at < size && found.length < MAX_CANDIDATES; at += CHUNK) {
    const end = Math.min(size, at + CHUNK + 2); // solape de 2 bytes para marcadores partidos entre trozos
    const data = await read(at, end);
    for (let i = 0; i + 2 < data.length && found.length < MAX_CANDIDATES; i++) {
      if (data[i] === 0xff && data[i + 1] === 0xd8 && data[i + 2] === 0xff && at + i < at + CHUNK) found.push(at + i);
    }
  }
  return found;
}

/**
 * Recorre un JPEG que empieza en `start`. Devuelve el offset SIGUIENTE al EOI o null si la estructura no es
 * válida (puede ser un falso positivo dentro de datos binarios).
 */
async function walkJpeg(read: Reader, size: number, start: number): Promise<number | null> {
  let pos = start + 2; // tras SOI
  let hadFrame = false;
  const limit = Math.min(size, start + MAX_JPEG_BYTES);
  for (let guard = 0; guard < 20_000; guard++) {
    if (pos + 4 > limit) return null;
    const head = await read(pos, pos + 4);
    if (head[0] !== 0xff) return null;
    let marker = head[1] as number;
    // bytes de relleno FF FF…
    if (marker === 0xff) {
      pos += 1;
      continue;
    }
    if (marker === 0xd9) return hadFrame ? pos + 2 : null; // EOI
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      pos += 2; // marcadores sin longitud
      continue;
    }
    const length = ((head[2] as number) << 8) | (head[3] as number);
    if (length < 2) return null;
    if ((marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)) hadFrame = true;
    pos += 2 + length;
    if (marker !== 0xda) continue;

    // SOS: datos entrópicos hasta el siguiente marcador real (FF xx con xx distinto de 00 y de RSTn)
    let scan = pos;
    let next = -1;
    while (scan < limit && next < 0) {
      const end = Math.min(limit, scan + 1024 * 1024);
      const data = await read(scan, end + 1);
      for (let i = 0; i + 1 < data.length; i++) {
        if (data[i] !== 0xff) continue;
        const b = data[i + 1] as number;
        if (b === 0x00 || (b >= 0xd0 && b <= 0xd7) || b === 0xff) continue;
        next = scan + i;
        break;
      }
      scan = end;
    }
    if (next < 0) return null;
    pos = next;
    marker = 0; // el bucle vuelve a leer el marcador que cierra el scan (DHT, SOS, EOI…)
  }
  return null;
}

/** Todos los JPEG válidos e independientes del archivo, del mayor al menor. */
export async function findEmbeddedJpegs(read: Reader, size: number, max = 8): Promise<JpegRange[]> {
  const candidates = await findSoi(read, size);
  const accepted: JpegRange[] = [];
  for (const start of candidates) {
    if (accepted.some((r) => start > r.start && start < r.end)) continue; // anidado en otro JPEG
    const end = await walkJpeg(read, size, start).catch(() => null);
    if (end === null || end - start < 2048) continue; // demasiado pequeño para ser una vista previa útil
    accepted.push({ start, end, length: end - start });
  }
  return accepted.sort((a, b) => b.length - a.length).slice(0, max);
}
