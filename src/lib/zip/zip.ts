/**
 * Escritor ZIP mínimo, SIN compresión («store») y sin dependencias. Funciona por streams: cada archivo se
 * abre con `begin`, se alimenta con `chunk` (CRC32 incremental) y se cierra con `end`; al final `finish`
 * devuelve el directorio central. Los tamaños y el CRC van en un «data descriptor» tras los datos (bit 3),
 * porque el CRC no se conoce hasta haber leído todo el archivo.
 *
 * Sin ZIP64: cada parte debe quedarse por debajo de 4 GiB (por eso se divide en partes de hasta 3,5 GB) y
 * con menos de 65 535 entradas. Los nombres se guardan en UTF-8 (bit 11).
 *
 * Código puro (sin DOM): lo usan el navegador y las pruebas de `node --test`.
 */

export const ZIP_MAX_PART_BYTES = 3_500_000_000; // 3,5 GB: margen bajo el límite de 4 GiB sin ZIP64
export const ZIP_MAX_FILES = 500;

// --- CRC32 incremental ---------------------------------------------------------------------------

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Actualiza un CRC32 (con valor inicial 0) con más datos. */
export function crc32(data: Uint8Array, previous = 0): number {
  let c = ~previous >>> 0;
  for (let i = 0; i < data.length; i++) c = (TABLE[(c ^ (data[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return ~c >>> 0;
}

// --- Fecha/hora MS-DOS -----------------------------------------------------------------------------

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

const encoder = new TextEncoder();

/** Nombre seguro dentro del ZIP: sin rutas, sin caracteres de control ni separadores. */
export function safeZipName(name: string): string {
  const base = String(name).split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").trim();
  return clean && clean !== "." && clean !== ".." ? clean.slice(0, 200) : "archivo";
}

/** Hace únicos los nombres añadiendo « (2)», « (3)»… antes de la extensión (sin distinguir mayúsculas). */
export function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.map((raw) => {
    const name = safeZipName(raw);
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let candidate = name;
    for (let n = 2; seen.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
    seen.add(candidate.toLowerCase());
    return candidate;
  });
}

// --- Escritor ----------------------------------------------------------------------------------------

type Entry = { name: Uint8Array; crc: number; size: number; offset: number; time: number; date: number };

function u16(view: DataView, at: number, value: number) {
  view.setUint16(at, value, true);
}
function u32(view: DataView, at: number, value: number) {
  view.setUint32(at, value >>> 0, true);
}

export class ZipWriter {
  private entries: Entry[] = [];
  private offset = 0;
  private current: (Entry & { crc: number }) | null = null;

  /** Bytes escritos hasta ahora (cabeceras y datos). */
  get bytesWritten(): number {
    return this.offset;
  }

  get fileCount(): number {
    return this.entries.length;
  }

  /** Abre un archivo y devuelve su cabecera local. */
  begin(name: string, modified: Date = new Date()): Uint8Array {
    if (this.current) throw new Error("Hay un archivo sin cerrar.");
    if (this.entries.length >= ZIP_MAX_FILES) throw new Error("Demasiados archivos en una parte.");
    const encoded = encoder.encode(safeZipName(name));
    const dos = dosDateTime(modified);
    const header = new Uint8Array(30 + encoded.length);
    const view = new DataView(header.buffer);
    u32(view, 0, 0x04034b50);
    u16(view, 4, 20); // versión necesaria
    u16(view, 6, 0x0808); // bit 3 (data descriptor) + bit 11 (UTF-8)
    u16(view, 8, 0); // método 0 = store
    u16(view, 10, dos.time);
    u16(view, 12, dos.date);
    // 14..25: CRC y tamaños a 0 (van en el data descriptor)
    u16(view, 26, encoded.length);
    u16(view, 28, 0);
    header.set(encoded, 30);
    this.current = { name: encoded, crc: 0, size: 0, offset: this.offset, time: dos.time, date: dos.date };
    this.offset += header.length;
    return header;
  }

  /** Registra datos del archivo abierto (el llamador los escribe tal cual). */
  chunk(data: Uint8Array): void {
    if (!this.current) throw new Error("No hay archivo abierto.");
    this.current.crc = crc32(data, this.current.crc);
    this.current.size += data.length;
    this.offset += data.length;
  }

  /** Cierra el archivo y devuelve su data descriptor. */
  end(): Uint8Array {
    if (!this.current) throw new Error("No hay archivo abierto.");
    const entry = this.current;
    this.current = null;
    if (entry.size >= 0xffffffff || this.offset >= 0xffffffff) throw new Error("La parte supera el límite de 4 GiB.");
    const descriptor = new Uint8Array(16);
    const view = new DataView(descriptor.buffer);
    u32(view, 0, 0x08074b50);
    u32(view, 4, entry.crc);
    u32(view, 8, entry.size);
    u32(view, 12, entry.size);
    this.offset += descriptor.length;
    this.entries.push(entry);
    return descriptor;
  }

  /** Directorio central + fin de directorio: el último bloque del archivo. */
  finish(): Uint8Array {
    if (this.current) throw new Error("Hay un archivo sin cerrar.");
    const centralStart = this.offset;
    const parts: Uint8Array[] = [];
    let centralSize = 0;
    for (const entry of this.entries) {
      const record = new Uint8Array(46 + entry.name.length);
      const view = new DataView(record.buffer);
      u32(view, 0, 0x02014b50);
      u16(view, 4, 20); // creado con
      u16(view, 6, 20); // versión necesaria
      u16(view, 8, 0x0808);
      u16(view, 10, 0);
      u16(view, 12, entry.time);
      u16(view, 14, entry.date);
      u32(view, 16, entry.crc);
      u32(view, 20, entry.size);
      u32(view, 24, entry.size);
      u16(view, 28, entry.name.length);
      u32(view, 42, entry.offset);
      record.set(entry.name, 46);
      parts.push(record);
      centralSize += record.length;
    }
    const end = new Uint8Array(22);
    const view = new DataView(end.buffer);
    u32(view, 0, 0x06054b50);
    u16(view, 8, this.entries.length);
    u16(view, 10, this.entries.length);
    u32(view, 12, centralSize);
    u32(view, 16, centralStart);
    parts.push(end);
    const out = new Uint8Array(centralSize + end.length);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    this.offset += out.length;
    return out;
  }
}

// --- Reparto en partes -------------------------------------------------------------------------------

export type ZipSource = { id: string; name: string; size: number };

/**
 * Divide una lista de archivos en partes que no superen `maxBytes` ni `maxFiles`. Un archivo que por sí solo
 * supera `maxBytes` queda en una parte propia (el llamador decide si puede escribirlo).
 */
export function planZipParts<T extends ZipSource>(
  files: T[],
  maxBytes = ZIP_MAX_PART_BYTES,
  maxFiles = ZIP_MAX_FILES,
): T[][] {
  const parts: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const file of files) {
    const overhead = 30 + 16 + 46 + file.name.length * 2 + 64; // cabeceras de este archivo (con margen)
    if (current.length > 0 && (current.length >= maxFiles || bytes + file.size + overhead > maxBytes)) {
      parts.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += file.size + overhead;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

/** Lee un ZIP completo en memoria y comprueba su estructura y CRC (solo para pruebas y verificación). */
export function inspectZip(bytes: Uint8Array): { name: string; size: number; crc: number; crcOk: boolean; data: Uint8Array }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Sin fin de directorio");
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("Directorio central corrupto");
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (view.getUint32(local, true) !== 0x04034b50) throw new Error("Cabecera local corrupta");
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(dataStart, dataStart + size);
    out.push({ name, size, crc, crcOk: crc32(data) === crc, data });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}
