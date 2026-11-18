/**
 * Transferencia de bytes del navegador a R2 mediante URLs prefirmadas. Sin dependencias.
 *
 * - Siempre se envían `Blob`s obtenidos con `File.slice` (perezosos): el archivo NUNCA se carga entero en memoria.
 * - XMLHttpRequest en lugar de fetch porque solo XHR da progreso de subida.
 */

export class TransferError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = "TransferError";
    this.status = status;
    this.retryable = retryable;
  }
}

export class AbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortedError";
  }
}

export function putBlob(input: {
  url: string;
  body: Blob;
  headers?: Record<string, string>;
  signal: AbortSignal;
  onProgress?: (loaded: number) => void;
}): Promise<{ etag: string | null }> {
  return new Promise((resolve, reject) => {
    if (input.signal.aborted) return reject(new AbortedError());

    const xhr = new XMLHttpRequest();
    xhr.open("PUT", input.url);
    for (const [name, value] of Object.entries(input.headers ?? {})) xhr.setRequestHeader(name, value);

    const onAbort = () => {
      xhr.abort();
      reject(new AbortedError());
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => input.signal.removeEventListener("abort", onAbort);

    xhr.upload.onprogress = (event) => input.onProgress?.(event.loaded);
    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ etag: xhr.getResponseHeader("ETag") });
      } else {
        // 403/400: URL caducada o rechazada → se reintenta firmando otra. 5xx/429: transitorio.
        reject(new TransferError(`HTTP ${xhr.status}`, xhr.status, true));
      }
    };
    xhr.onerror = () => {
      cleanup();
      reject(new TransferError("network", 0, true));
    };
    xhr.ontimeout = () => {
      cleanup();
      reject(new TransferError("timeout", 0, true));
    };
    xhr.send(input.body);
  });
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new AbortedError());
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Si no hay red, espera a que vuelva (o a que se cancele). */
export function waitOnline(signal: AbortSignal): Promise<void> {
  if (typeof navigator === "undefined" || navigator.onLine) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onOnline = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      window.removeEventListener("online", onOnline);
      reject(new AbortedError());
    };
    window.addEventListener("online", onOnline, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Espera creciente con algo de azar: 1 s, 2 s, 4 s… hasta 30 s. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 400);
}

/**
 * Ejecuta `task` con reintentos y espera creciente. `task` recibe el nº de intento (0 = primero) para
 * poder pedir una URL firmada nueva en los reintentos. Se detiene al cancelar o con errores no reintentables.
 */
export async function withRetries<T>(
  task: (attempt: number) => Promise<T>,
  signal: AbortSignal,
  maxAttempts = 6,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await waitOnline(signal);
      return await task(attempt);
    } catch (error) {
      if (error instanceof AbortedError || signal.aborted) throw new AbortedError();
      lastError = error;
      if (error instanceof TransferError && !error.retryable) throw error;
      if (attempt < maxAttempts - 1) await sleep(backoffMs(attempt), signal);
    }
  }
  throw lastError;
}

/** Error definitivo (p. ej. el servidor rechazó la subida): no se reintenta. */
export class FatalError extends TransferError {
  constructor(message: string) {
    super(message, 0, false);
    this.name = "FatalError";
  }
}
