/**
 * Miniatura (400 px) y versión web (2048 px) en WebP, color medio y dimensiones, generados EN EL NAVEGADOR
 * dentro de Web Workers (máximo 3 imágenes a la vez, para no bloquear la interfaz).
 *
 *  - JPEG, PNG y WebP: siempre. HEIC/HEIF: solo si el navegador sabe decodificarlos.
 *  - RAW (CR2, CR3, ARW, NEF, DNG, RAF): se extrae la vista previa JPEG incrustada (mejor esfuerzo).
 *  - Si no se puede (formato no decodificable, WebP no soportado al codificar, sin vista previa…) se devuelve
 *    null: el asset queda sin derivados y la interfaz muestra un marcador de posición. El original no cambia.
 *  - Si el navegador no tiene Workers/OffscreenCanvas, se usa un camino alternativo en el hilo principal
 *    (solo para JPEG, PNG y WebP).
 */
import { extensionOf } from "@/lib/storage/validate";
import type { WorkerRequest, WorkerResponse } from "./image.worker";

export type GeneratedDerivatives = {
  width: number;
  height: number;
  avgColor: string | null;
  thumb: Blob;
  web: Blob;
  /** De dónde sale la imagen: el propio archivo o la vista previa incrustada de un RAW. */
  source: "direct" | "raw-preview";
};

export const MAX_PARALLEL_IMAGES = 3;
const JOB_TIMEOUT_MS = 90_000;

type Job = {
  file: File;
  resolve: (value: GeneratedDerivatives | null) => void;
};

class ImagePool {
  private idle: Worker[] = [];
  private busy = new Map<Worker, { id: number; job: Job; timer: ReturnType<typeof setTimeout> }>();
  private queue: Job[] = [];
  private nextId = 1;
  private broken = false;

  get unavailable(): boolean {
    return this.broken || typeof Worker === "undefined";
  }

  /** Trabajos activos ahora mismo (para comprobar el límite en las pruebas). */
  get active(): number {
    return this.busy.size;
  }

  run(file: File): Promise<GeneratedDerivatives | null> {
    return new Promise((resolve) => {
      this.queue.push({ file, resolve });
      this.pump();
    });
  }

  private spawn(): Worker | null {
    try {
      const worker = new Worker(new URL("./image.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.finish(worker, event.data);
      worker.onerror = () => this.fail(worker, true);
      return worker;
    } catch {
      this.broken = true;
      return null;
    }
  }

  private pump() {
    while (this.queue.length > 0 && this.busy.size < MAX_PARALLEL_IMAGES) {
      const worker = this.idle.pop() ?? this.spawn();
      if (!worker) {
        // Sin Workers: lo que quede se resuelve con el camino alternativo
        for (const job of this.queue.splice(0)) void fallback(job.file).then(job.resolve);
        return;
      }
      const job = this.queue.shift() as Job;
      const id = this.nextId++;
      const timer = setTimeout(() => this.fail(worker, true), JOB_TIMEOUT_MS);
      this.busy.set(worker, { id, job, timer });
      const request: WorkerRequest = { id, file: job.file, ext: extensionOf(job.file.name) };
      worker.postMessage(request);
    }
  }

  private finish(worker: Worker, response: WorkerResponse) {
    const entry = this.busy.get(worker);
    if (!entry || entry.id !== response.id) return;
    clearTimeout(entry.timer);
    this.busy.delete(worker);
    this.idle.push(worker);
    if (response.ok) {
      entry.job.resolve({
        width: response.width,
        height: response.height,
        avgColor: response.avgColor,
        thumb: response.thumb,
        web: response.web,
        source: response.source,
      });
    } else if (response.reason === "unsupported") {
      void fallback(entry.job.file).then(entry.job.resolve);
    } else {
      entry.job.resolve(null);
    }
    this.pump();
  }

  private fail(worker: Worker, recreate: boolean) {
    const entry = this.busy.get(worker);
    worker.terminate();
    this.idle = this.idle.filter((w) => w !== worker);
    if (entry) {
      clearTimeout(entry.timer);
      this.busy.delete(worker);
      entry.job.resolve(null);
    }
    if (!recreate) this.broken = true;
    this.pump();
  }
}

let pool: ImagePool | null = null;

// --- Camino alternativo en el hilo principal (solo JPEG, PNG, WebP) ---------------------------------------

function canvasToWebp(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
}

async function resize(source: ImageBitmap | HTMLCanvasElement, maxSide: number): Promise<HTMLCanvasElement | null> {
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function fallback(file: File): Promise<GeneratedDerivatives | null> {
  const ext = extensionOf(file.name);
  if (!["jpg", "jpeg", "png", "webp"].includes(ext) || typeof createImageBitmap !== "function") return null;
  const { averageColor } = await import("@/lib/images/color");
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const width = bitmap.width;
    const height = bitmap.height;
    const webCanvas = await resize(bitmap, 2048);
    bitmap.close();
    bitmap = null;
    const thumbCanvas = webCanvas ? await resize(webCanvas, 400) : null;
    if (!webCanvas || !thumbCanvas) return null;
    const [web, thumb] = [await canvasToWebp(webCanvas), await canvasToWebp(thumbCanvas)];
    if (!web || !thumb || web.type !== "image/webp" || thumb.type !== "image/webp") return null;
    const tiny = await resize(thumbCanvas, 16);
    const data = tiny?.getContext("2d")?.getImageData(0, 0, tiny.width, tiny.height).data;
    webCanvas.width = webCanvas.height = thumbCanvas.width = thumbCanvas.height = 0; // libera memoria
    return { width, height, avgColor: data ? averageColor(data) : null, thumb, web, source: "direct" };
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

/** Devuelve null si no se pueden generar derivados (la interfaz muestra un marcador de posición). */
export async function generateDerivatives(file: File): Promise<GeneratedDerivatives | null> {
  if (typeof window === "undefined") return null;
  pool ??= new ImagePool();
  if (pool.unavailable) return fallback(file);
  return pool.run(file);
}

/** Solo para depuración y pruebas manuales: trabajos de procesado activos ahora. */
export function activeImageJobs(): number {
  return pool?.active ?? 0;
}
