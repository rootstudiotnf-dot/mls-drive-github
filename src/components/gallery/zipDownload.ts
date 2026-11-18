"use client";

import { safeZipName, planZipParts, uniqueNames, ZIP_MAX_FILES, ZIP_MAX_PART_BYTES, ZipWriter, type ZipSource } from "@/lib/zip/zip";

/**
 * ZIP generado EN EL NAVEGADOR, sin pasar por el servidor: cada foto se descarga con su URL firmada (pedida
 * justo antes de empezar ese archivo, porque valen 2 minutos) y sus bytes se van escribiendo al ZIP «store»
 * con CRC32 incremental. Nada se carga entero en memoria salvo en el camino alternativo.
 *
 *  · Con File System Access API (Chrome, Edge…): se escribe directo a disco; partes de hasta 3,5 GB.
 *  · Sin ella (Safari, Firefox): el ZIP se arma en memoria por partes de hasta 1 GB y se ofrecen numeradas.
 *  · Máximo 500 archivos por parte; por encima, se divide en varias descargas.
 */

export const MEMORY_PART_BYTES = 1_000_000_000;
export { ZIP_MAX_FILES, ZIP_MAX_PART_BYTES };

export type ZipFile = ZipSource;
export type ZipPart = { index: number; total: number; files: ZipFile[]; fileName: string; bytes: number };

type SaveFilePicker = (options: {
  suggestedName: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<{ createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }> }>;

function savePicker(): SaveFilePicker | null {
  const fn = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  return typeof fn === "function" ? fn.bind(window) : null;
}

export const supportsDirectWrite = () => typeof window !== "undefined" && savePicker() !== null;

export function planParts(files: ZipFile[], baseName: string, direct: boolean): ZipPart[] {
  const names = uniqueNames(files.map((f) => f.name));
  const named = files.map((f, i) => ({ ...f, name: names[i] as string }));
  const groups = planZipParts(named, direct ? ZIP_MAX_PART_BYTES : MEMORY_PART_BYTES, ZIP_MAX_FILES);
  const stem = safeZipName(baseName).replace(/\.[^.]*$/, "") || "sesion";
  return groups.map((group, i) => ({
    index: i + 1,
    total: groups.length,
    files: group,
    fileName: groups.length === 1 ? `${stem}.zip` : `${stem}-parte-${i + 1}-de-${groups.length}.zip`,
    bytes: group.reduce((n, f) => n + f.size, 0),
  }));
}

// --- Destinos ------------------------------------------------------------------------------------------

export interface Sink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

/** Escribe a disco. Debe llamarse DENTRO del gesto del usuario (clic), antes de cualquier `await` largo. */
export async function openFileSink(fileName: string): Promise<Sink> {
  const picker = savePicker();
  if (!picker) throw new Error("Sin acceso a disco");
  const handle = await picker({ suggestedName: fileName, types: [{ description: "Archivo ZIP", accept: { "application/zip": [".zip"] } }] });
  const writable = await handle.createWritable();
  return { write: (chunk) => writable.write(chunk), close: () => writable.close(), abort: () => writable.abort().catch(() => undefined) };
}

/** Arma el ZIP en memoria (en bloques de ~32 MB que el navegador puede volcar a disco) y lo entrega como descarga. */
export function openMemorySink(fileName: string): Sink {
  const blocks: Blob[] = [];
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  const flush = () => {
    if (pending.length > 0) blocks.push(new Blob(pending as BlobPart[]));
    pending = [];
    pendingBytes = 0;
  };
  return {
    async write(chunk) {
      pending.push(chunk.slice()); // el lector reutiliza su búfer: se copia
      pendingBytes += chunk.length;
      if (pendingBytes >= 32 * 1024 * 1024) flush();
    },
    async close() {
      flush();
      const url = URL.createObjectURL(new Blob(blocks, { type: "application/zip" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    async abort() {
      blocks.length = 0;
      pending = [];
    },
  };
}

// --- Escritura de una parte -------------------------------------------------------------------------------

export class ZipCancelled extends Error {
  constructor() {
    super("Descarga cancelada");
    this.name = "ZipCancelled";
  }
}

export class ZipFileError extends Error {
  readonly fileName: string;
  constructor(fileName: string, message: string) {
    super(message);
    this.name = "ZipFileError";
    this.fileName = fileName;
  }
}

async function fetchWithRetry(
  getUrl: (id: string) => Promise<string>,
  id: string,
  signal: AbortSignal,
  /** URL pedida de antemano (mientras se descargaba el archivo anterior). Solo se usa en el primer intento. */
  early?: Promise<string>,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal.aborted) throw new ZipCancelled();
    try {
      // Si la URL adelantada falla o caducó (valen 2 minutos), el segundo intento pide una nueva
      const url = attempt === 0 && early ? await early : await getUrl(id);
      const response = await fetch(url, { signal, credentials: "omit", referrerPolicy: "no-referrer" });
      if (response.ok && response.body) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      if (signal.aborted) throw new ZipCancelled();
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Error de red");
}

export async function writeZipPart(input: {
  part: ZipPart;
  sink: Sink;
  getUrl: (id: string) => Promise<string>;
  signal: AbortSignal;
  onBytes: (delta: number) => void;
  onFile: (done: number) => void;
}): Promise<{ bytes: number }> {
  const { part, sink, getUrl, signal } = input;
  const zip = new ZipWriter();
  const modified = new Date();
  let done = 0;
  try {
    // Mientras se descarga cada archivo se pide ya la URL firmada del siguiente (solo uno por delante)
    let early: Promise<string> | undefined = part.files[0] ? getUrl(part.files[0].id) : undefined;
    early?.catch(() => undefined);
    for (let index = 0; index < part.files.length; index++) {
      const file = part.files[index] as ZipFile;
      if (signal.aborted) throw new ZipCancelled();
      let response: Response;
      try {
        response = await fetchWithRetry(getUrl, file.id, signal, early);
        const following = part.files[index + 1];
        early = following ? getUrl(following.id) : undefined;
        early?.catch(() => undefined);
      } catch (error) {
        if (error instanceof ZipCancelled) throw error;
        throw new ZipFileError(file.name, "No se pudo descargar una foto");
      }
      await sink.write(zip.begin(file.name, modified));
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      try {
        for (;;) {
          const { value, done: finished } = await reader.read();
          if (finished) break;
          zip.chunk(value);
          await sink.write(value);
          input.onBytes(value.length);
        }
      } catch {
        if (signal.aborted) throw new ZipCancelled();
        throw new ZipFileError(file.name, "Se cortó la descarga de una foto");
      }
      await sink.write(zip.end());
      input.onFile(++done);
    }
    await sink.write(zip.finish());
    await sink.close();
    return { bytes: zip.bytesWritten };
  } catch (error) {
    await sink.abort();
    throw error;
  }
}
