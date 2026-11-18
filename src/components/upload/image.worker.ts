/**
 * Web Worker de procesado de imágenes: genera la miniatura (400 px) y la versión web (2048 px, WebP) y
 * calcula `width`, `height` y el color medio, sin bloquear la interfaz.
 *
 *  - JPEG, PNG, WebP y HEIC/HEIF (este último solo si el navegador sabe decodificarlo).
 *  - RAW (CR2, CR3, ARW, NEF, DNG, RAF): se barre el archivo por trozos (`File.slice`) en busca del JPEG
 *    incrustado de mayor tamaño que se pueda decodificar y se usa como origen. Es un procesado de MEJOR
 *    ESFUERZO: si no se encuentra o no se decodifica, se responde «sin derivados». El RAW original NO se
 *    modifica nunca (solo se lee).
 *  - Nunca se carga un archivo entero en memoria como ArrayBuffer: se decodifica desde el File/Blob.
 */
import { averageColor } from "@/lib/images/color";
import { findEmbeddedJpegs } from "@/lib/images/embedded-jpeg";

export type WorkerRequest = { id: number; file: File; ext: string };
export type WorkerResponse =
  | { id: number; ok: true; width: number; height: number; avgColor: string | null; thumb: Blob; web: Blob; source: "direct" | "raw-preview" }
  | { id: number; ok: false; reason: "unsupported" | "decode" | "encode" | "no-preview" };

const THUMB_MAX = 400;
const WEB_MAX = 2048;
const RAW = new Set(["cr2", "cr3", "arw", "nef", "dng", "raf"]);

const scope = self as unknown as {
  postMessage(message: WorkerResponse): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

async function decodeRawPreview(file: File): Promise<ImageBitmap | null> {
  const ranges = await findEmbeddedJpegs((start, end) => file.slice(start, end).arrayBuffer().then((b) => new Uint8Array(b)), file.size);
  // Del mayor al menor: se usa el primero que el navegador sepa decodificar (los lossless/tiles de un DNG fallan)
  for (const range of ranges.slice(0, 4)) {
    try {
      return await createImageBitmap(file.slice(range.start, range.end, "image/jpeg"), { imageOrientation: "from-image" });
    } catch {
      /* probar el siguiente */
    }
  }
  return null;
}

async function toWebp(canvas: OffscreenCanvas): Promise<Blob | null> {
  const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.82 });
  return blob.type === "image/webp" ? blob : null; // si el navegador no codifica WebP devuelve PNG: se descarta
}

function drawScaled(source: ImageBitmap | OffscreenCanvas, maxSide: number): OffscreenCanvas | null {
  const w = source.width;
  const h = source.height;
  const scale = Math.min(1, maxSide / Math.max(w, h)); // sin ampliar
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function process(request: WorkerRequest): Promise<WorkerResponse> {
  const { id, file, ext } = request;
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") {
    return { id, ok: false, reason: "unsupported" };
  }
  let bitmap: ImageBitmap | null = null;
  try {
    const isRaw = RAW.has(ext);
    if (isRaw) {
      bitmap = await decodeRawPreview(file);
      if (!bitmap) return { id, ok: false, reason: "no-preview" };
    } else {
      try {
        bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      } catch {
        return { id, ok: false, reason: "decode" }; // p. ej. HEIC en un navegador que no lo decodifica
      }
    }
    const width = bitmap.width;
    const height = bitmap.height;

    const webCanvas = drawScaled(bitmap, WEB_MAX);
    bitmap.close();
    bitmap = null;
    if (!webCanvas) return { id, ok: false, reason: "encode" };
    const thumbCanvas = drawScaled(webCanvas, THUMB_MAX); // la miniatura sale de la versión web (menos memoria)
    if (!thumbCanvas) return { id, ok: false, reason: "encode" };

    const [web, thumb] = [await toWebp(webCanvas), await toWebp(thumbCanvas)];
    if (!web || !thumb) return { id, ok: false, reason: "encode" };

    let avgColor: string | null = null;
    const tiny = drawScaled(thumbCanvas, 16);
    const context = tiny?.getContext("2d");
    if (tiny && context) avgColor = averageColor(context.getImageData(0, 0, tiny.width, tiny.height).data);

    return { id, ok: true, width, height, avgColor, thumb, web, source: isRaw ? "raw-preview" : "direct" };
  } catch {
    return { id, ok: false, reason: "decode" };
  } finally {
    bitmap?.close();
  }
}

scope.onmessage = (event) => {
  void process(event.data).then((response) => scope.postMessage(response));
};
