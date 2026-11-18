"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  abortUpload,
  completeDerivative,
  completeUpload,
  initDerivative,
  initUpload,
  listUploadedParts,
  signPart,
  signSingleUpload,
  type InitUploadData,
} from "@/app/actions/uploads";
import type { ActionResult } from "@/lib/action-result";
import {
  canGenerateDerivatives,
  CLASS_TO_UI,
  classifyFilename,
  extensionOf,
  type UiType,
} from "@/lib/storage/validate";
import { generateDerivatives, type GeneratedDerivatives } from "./derivatives";
import { AbortedError, FatalError, putBlob, withRetries } from "./transfer";

/**
 * Motor de subida del navegador.
 *
 *  - Subida simple (<50 MB): un PUT. Multipart: partes de `partSize` en paralelo (4 a la vez) con reintentos y
 *    espera creciente. Cada parte es un `File.slice` (perezoso): el archivo nunca se carga entero en memoria.
 *  - Reanudable: guarda en localStorage el `uploadId` y la huella del archivo (nombre + tamaño + fecha).
 *    Tras cerrar la pestaña o perder la conexión, al volver a elegir el mismo archivo consulta a R2 qué
 *    partes ya tiene (`listUploadedParts`) y sube solo las que faltan.
 *  - Como máximo 3 archivos a la vez (3 × 4 partes = 12 conexiones); el procesado de imágenes tiene su
 *    propio límite de 3 a la vez (Web Workers, ver derivatives.ts).
 */

const PART_CONCURRENCY = 4;
const FILE_CONCURRENCY = 3;
const STORAGE_PREFIX = "mls-upload:";
const STORED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type UploadStatus =
  | "staged" // elegido, pendiente de clasificar
  | "queued"
  | "uploading"
  | "paused"
  | "finishing"
  | "done"
  | "error"
  | "canceled";

export type UploadItem = {
  id: string;
  file: File;
  type: UiType;
  artistId: string | null;
  folderId: string | null;
  /** Sesión de destino (subida desde una sesión): artista y sesión van fijados. */
  sessionId?: string | null;
  /** Uso especial: portada de un beat o tag de voz (el servidor lo vuelve a validar). */
  purpose?: "beat-cover" | "voice-tag";
  visibility: "private" | "published";
  status: UploadStatus;
  /** 0..1 */
  progress: number;
  error?: string;
  /** Error de red/transitorio: se reintenta solo al volver la conexión. */
  netError?: boolean;
  assetId?: string;
  mode?: "single" | "multipart";
  uploadId?: string;
  partSize?: number;
  totalParts?: number;
  /** Se reanuda una subida previa (no es nueva). */
  resumed?: boolean;
  /** Validación local (extensión/tamaño). */
  invalidReason?: string;
};

export type StoredUpload = {
  assetId: string;
  mode: "single" | "multipart";
  uploadId?: string;
  partSize?: number;
  totalParts?: number;
  name: string;
  size: number;
  savedAt: number;
};

// --- localStorage (siempre con try/catch: puede no estar disponible) -----------------------------------

export function fingerprint(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

function readStored(fp: string): StoredUpload | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + fp);
    if (!raw) return null;
    const value = JSON.parse(raw) as StoredUpload;
    if (Date.now() - value.savedAt > STORED_MAX_AGE_MS) {
      localStorage.removeItem(STORAGE_PREFIX + fp);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function writeStored(fp: string, value: StoredUpload) {
  try {
    localStorage.setItem(STORAGE_PREFIX + fp, JSON.stringify(value));
  } catch {
    /* sin persistencia: la subida funciona, pero no se podrá reanudar tras cerrar la pestaña */
  }
}

function clearStored(fp: string) {
  try {
    localStorage.removeItem(STORAGE_PREFIX + fp);
  } catch {
    /* nada */
  }
}

function listStored(): { fp: string; value: StoredUpload }[] {
  const out: { fp: string; value: StoredUpload }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(STORAGE_PREFIX)) continue;
      const fp = key.slice(STORAGE_PREFIX.length);
      const value = readStored(fp);
      if (value) out.push({ fp, value });
    }
  } catch {
    /* nada */
  }
  return out;
}

// --- Hook -------------------------------------------------------------------------------------------

/** Las seis llamadas al servidor del motor de subida. Por defecto el espacio normal; el Vault aporta las suyas (bucket propio). */
export type UploaderApi = {
  initUpload: (input: { filename: string; size: number; type: UiType; artistId: string | null; folderId: string | null; sessionId: string | null; purpose?: "beat-cover" | "voice-tag"; visibility: "private" | "published" }) => Promise<ActionResult<InitUploadData>>;
  signSingleUpload: (input: { assetId: string }) => Promise<ActionResult<{ url: string; headers: Record<string, string> }>>;
  signPart: (input: { assetId: string; uploadId: string; partNumber: number }) => Promise<ActionResult<{ url: string }>>;
  listUploadedParts: (input: { assetId: string; uploadId: string }) => Promise<ActionResult<{ partSize: number; totalParts: number; parts: { partNumber: number; size: number }[] }>>;
  completeUpload: (input: { assetId: string; width?: number; height?: number; avgColor?: string }) => Promise<ActionResult<{ assetId: string }>>;
  abortUpload: (input: { assetId: string }) => Promise<ActionResult>;
};

const DEFAULT_API: UploaderApi = { initUpload, signSingleUpload, signPart, listUploadedParts, completeUpload, abortUpload };

export type UploaderOptions = {
  maxBytes: number;
  defaultArtistId?: string | null;
  /** Sesión a la que se sube (opcional). */
  sessionId?: string | null;
  /** Tipo preseleccionado para lo que se añada (p. ej. «photo» al subir a una sesión de fotos). */
  defaultType?: UiType | null;
  /** Uso especial de todo lo que se suba con este motor (portada de beat, tag de voz). */
  purpose?: "beat-cover" | "voice-tag";
  /** Llamadas al servidor alternativas (Vault). */
  api?: UploaderApi;
  /** Carpeta de destino fijada para todo lo que se añada (Vault). */
  defaultFolderId?: string | null;
  /** false = no generar ni subir miniaturas (el Vault no deja derivados fuera de su bucket). */
  derivatives?: boolean;
};

export function useUploader({ maxBytes, defaultArtistId = null, sessionId = null, defaultType = null, purpose, api = DEFAULT_API, defaultFolderId = null, derivatives: makeDerivatives = true }: UploaderOptions) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [pending, setPending] = useState<{ fp: string; value: StoredUpload }[]>([]);
  const itemsRef = useRef<UploadItem[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const running = useRef(new Set<string>());

  const refreshPending = useCallback(() => {
    const inUse = new Set(itemsRef.current.filter((i) => i.assetId).map((i) => fingerprint(i.file)));
    setPending(listStored().filter((s) => !inUse.has(s.fp)));
  }, []);

  useEffect(() => {
    refreshPending();
    const onStorage = () => refreshPending();
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [refreshPending]);

  const patch = useCallback((id: string, changes: Partial<UploadItem>) => {
    itemsRef.current = itemsRef.current.map((item) => (item.id === id ? { ...item, ...changes } : item));
    setItems(itemsRef.current);
  }, []);

  const find = (id: string) => itemsRef.current.find((i) => i.id === id);

  // --- Una subida ------------------------------------------------------------------------------------

  const transferParts = async (
    id: string,
    signal: AbortSignal,
    verifyFirst: boolean,
  ): Promise<void> => {
    const item = find(id);
    if (!item?.assetId || !item.uploadId || !item.partSize || !item.totalParts) {
      throw new FatalError("Datos de subida incompletos.");
    }
    const { assetId, uploadId, partSize, totalParts, file } = item;

    // Qué partes ya tiene R2 (reanudar / reintentar / verificar antes de cerrar)
    const done = new Map<number, number>();
    if (verifyFirst) {
      const listed = await withRetries(async () => {
        const res = await api.listUploadedParts({ assetId, uploadId });
        if (!res.ok || !res.data) throw new FatalError(res.ok ? "Respuesta vacía" : res.message);
        return res.data;
      }, signal);
      for (const p of listed.parts) done.set(p.partNumber, p.size);
    }

    const inflight = new Map<number, number>();
    let lastPaint = 0;
    const paint = (force = false) => {
      const now = performance.now();
      if (!force && now - lastPaint < 150) return;
      lastPaint = now;
      let bytes = 0;
      for (const size of done.values()) bytes += size;
      for (const loaded of inflight.values()) bytes += loaded;
      patch(id, { progress: Math.min(1, bytes / file.size) });
    };
    paint(true);

    const queue: number[] = [];
    for (let n = 1; n <= totalParts; n++) if (!done.has(n)) queue.push(n);

    // Un fallo definitivo en una parte detiene a las demás
    const group = new AbortController();
    const onOuterAbort = () => group.abort(signal.reason);
    signal.addEventListener("abort", onOuterAbort, { once: true });

    const uploadPart = async (n: number) => {
      const start = (n - 1) * partSize;
      const end = Math.min(file.size, start + partSize);
      await withRetries(async () => {
        const signed = await api.signPart({ assetId, uploadId, partNumber: n });
        if (!signed.ok || !signed.data) throw new FatalError(signed.ok ? "Respuesta vacía" : signed.message);
        await putBlob({
          url: signed.data.url,
          body: file.slice(start, end), // perezoso: no carga el archivo en memoria
          signal: group.signal,
          onProgress: (loaded) => {
            inflight.set(n, loaded);
            paint();
          },
        });
      }, group.signal);
      inflight.delete(n);
      done.set(n, end - start);
      paint();
    };

    try {
      const workers = Array.from({ length: Math.min(PART_CONCURRENCY, queue.length) }, async () => {
        for (let n = queue.shift(); n !== undefined; n = queue.shift()) await uploadPart(n);
      });
      const results = await Promise.allSettled(workers);
      const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
      if (failed) {
        group.abort("part-failed");
        throw failed.reason;
      }
      paint(true);
    } finally {
      signal.removeEventListener("abort", onOuterAbort);
    }
  };

  const transferSingle = async (
    id: string,
    signal: AbortSignal,
    first: { url: string; headers: Record<string, string> } | null,
  ): Promise<void> => {
    const item = find(id);
    if (!item?.assetId) throw new FatalError("Datos de subida incompletos.");
    const { assetId, file } = item;
    let lastPaint = 0;
    await withRetries(async (attempt) => {
      let target = attempt === 0 ? first : null;
      if (!target) {
        const res = await api.signSingleUpload({ assetId });
        if (!res.ok || !res.data) throw new FatalError(res.ok ? "Respuesta vacía" : res.message);
        target = res.data;
      }
      await putBlob({
        url: target.url,
        body: file,
        headers: target.headers,
        signal,
        onProgress: (loaded) => {
          const now = performance.now();
          if (now - lastPaint < 150) return;
          lastPaint = now;
          patch(id, { progress: Math.min(1, loaded / file.size) });
        },
      });
    }, signal);
    patch(id, { progress: 1 });
  };

  const uploadDerivatives = async (assetId: string, derivs: GeneratedDerivatives, signal: AbortSignal) => {
    for (const type of ["thumb", "web"] as const) {
      const blob = derivs[type];
      const init = await initDerivative({ assetId, type, size: blob.size });
      if (!init.ok || !init.data) continue; // los derivados son opcionales: el archivo ya está subido
      try {
        await withRetries(
          () => putBlob({ url: init.data!.url, body: blob, headers: init.data!.headers, signal }),
          signal,
          3,
        );
        await completeDerivative({ assetId, type });
      } catch (error) {
        if (error instanceof AbortedError) throw error;
      }
    }
  };

  const run = async (id: string) => {
    if (running.current.has(id)) return;
    running.current.add(id);
    const controller = new AbortController();
    controllers.current.set(id, controller);
    const { signal } = controller;

    const start = find(id);
    if (!start) {
      running.current.delete(id);
      return;
    }
    const file = start.file;
    const fp = fingerprint(file);
    patch(id, { status: "uploading", error: undefined, netError: false });

    try {
      // 1) Registro de la subida en el servidor (si es nueva)
      let first: { url: string; headers: Record<string, string> } | null = null;
      let fresh = false;
      if (!find(id)?.assetId) {
        const current = find(id)!;
        const res = await api.initUpload({
          filename: file.name,
          size: file.size,
          type: current.type,
          artistId: current.artistId,
          folderId: current.folderId,
          sessionId: current.sessionId ?? null,
          purpose: current.purpose,
          visibility: current.visibility,
        });
        if (!res.ok || !res.data) throw new FatalError(res.ok ? "Respuesta vacía" : res.message);
        const data = res.data;
        fresh = true;
        if (data.mode === "multipart") {
          patch(id, { assetId: data.assetId, mode: "multipart", uploadId: data.uploadId, partSize: data.partSize, totalParts: data.totalParts });
          writeStored(fp, { assetId: data.assetId, mode: "multipart", uploadId: data.uploadId, partSize: data.partSize, totalParts: data.totalParts, name: file.name, size: file.size, savedAt: Date.now() });
        } else {
          patch(id, { assetId: data.assetId, mode: "single" });
          first = { url: data.url, headers: data.headers };
          writeStored(fp, { assetId: data.assetId, mode: "single", name: file.name, size: file.size, savedAt: Date.now() });
        }
      }

      // 2) Bytes (+ cierre). Si al cerrar faltan partes, se vuelve a subir lo que falte (máx. 3 vueltas)
      let assetId = find(id)!.assetId!;
      let derivs: GeneratedDerivatives | null = null;
      for (let round = 0; round < 3; round++) {
        const mode = find(id)!.mode;
        if (mode === "single") await transferSingle(id, signal, first);
        else await transferParts(id, signal, !(fresh && round === 0));

        patch(id, { status: "finishing" });
        if (makeDerivatives && !derivs && find(id)!.type === "photo" && canGenerateDerivatives(extensionOf(file.name))) {
          derivs = await generateDerivatives(file);
        }
        assetId = find(id)!.assetId!;
        const done = await api.completeUpload({ assetId, width: derivs?.width, height: derivs?.height, avgColor: derivs?.avgColor ?? undefined });
        if (done.ok) break;
        if (/Faltan partes/.test(done.message) && round < 2) {
          patch(id, { status: "uploading" });
          continue;
        }
        throw new FatalError(done.message);
      }

      // 3) Derivados de foto (opcional)
      if (derivs && makeDerivatives) await uploadDerivatives(assetId, derivs, signal);

      clearStored(fp);
      patch(id, { status: "done", progress: 1, error: undefined });
    } catch (error) {
      if (error instanceof AbortedError || signal.aborted) {
        // pausa: se conserva todo para reanudar (la cancelación la gestiona cancel())
        if (find(id)?.status !== "canceled") patch(id, { status: "paused" });
      } else if (error instanceof FatalError) {
        patch(id, { status: "error", error: error.message, netError: false });
        if (/ya no (es válida|existe)|ya no se puede/i.test(error.message)) clearStored(fp);
      } else {
        patch(id, {
          status: "error",
          netError: true,
          error: "Se interrumpió la subida (red o servidor). Se reanudará al volver la conexión.",
        });
      }
    } finally {
      running.current.delete(id);
      controllers.current.delete(id);
      refreshPending();
      pump();
    }
  };

  const pump = () => {
    for (const item of itemsRef.current) {
      if (running.current.size >= FILE_CONCURRENCY) break;
      if (item.status === "queued" && !running.current.has(item.id)) void run(item.id);
    }
  };

  // --- API pública -------------------------------------------------------------------------------------

  const stage = useCallback(
    (files: File[]) => {
      const added: UploadItem[] = files.map((file) => {
        const classification = classifyFilename(file.name);
        const stored = readStored(fingerprint(file));
        let invalidReason: string | undefined;
        if (!classification) invalidReason = "Formato no permitido";
        else if (file.size <= 0) invalidReason = "El archivo está vacío";
        else if (file.size > maxBytes) invalidReason = "Supera el tamaño máximo";

        return {
          id: crypto.randomUUID(),
          file,
          type: defaultType && classification && CLASS_TO_UI[classification.cls] === defaultType ? defaultType : classification ? CLASS_TO_UI[classification.cls] : "file",
          artistId: defaultArtistId,
          folderId: defaultFolderId,
          sessionId,
          purpose,
          visibility: "private",
          status: stored && !invalidReason ? "queued" : "staged",
          progress: 0,
          invalidReason,
          ...(stored && !invalidReason
            ? {
                resumed: true,
                assetId: stored.assetId,
                mode: stored.mode,
                uploadId: stored.uploadId,
                partSize: stored.partSize,
                totalParts: stored.totalParts,
              }
            : {}),
        } satisfies UploadItem;
      });
      itemsRef.current = [...itemsRef.current, ...added];
      setItems(itemsRef.current);
      refreshPending();
      pump();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [maxBytes, defaultArtistId, sessionId, defaultType, purpose, defaultFolderId, refreshPending],
  );

  const update = useCallback(
    (id: string, changes: Partial<Pick<UploadItem, "type" | "artistId" | "folderId" | "visibility">>) => {
      const item = find(id);
      if (item?.status === "staged") patch(id, changes);
    },
    [patch],
  );

  /** Aplica un campo a todos los archivos aún sin subir. */
  const updateAll = useCallback(
    (changes: Partial<Pick<UploadItem, "artistId" | "folderId" | "visibility">>) => {
      itemsRef.current = itemsRef.current.map((i) => (i.status === "staged" ? { ...i, ...changes } : i));
      setItems(itemsRef.current);
    },
    [],
  );

  const remove = useCallback((id: string) => {
    itemsRef.current = itemsRef.current.filter((i) => i.id !== id);
    setItems(itemsRef.current);
  }, []);

  const start = useCallback(() => {
    itemsRef.current = itemsRef.current.map((i) =>
      i.status === "staged" && !i.invalidReason ? { ...i, status: "queued" } : i,
    );
    setItems(itemsRef.current);
    pump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pause = useCallback((id: string) => {
    const item = find(id);
    if (item?.status === "queued") patch(id, { status: "paused" });
    else controllers.current.get(id)?.abort("pause");
     
  }, [patch]);

  const resume = useCallback((id: string) => {
    const item = find(id);
    if (item && (item.status === "paused" || item.status === "error")) {
      patch(id, { status: "queued", error: undefined, netError: false });
      pump();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patch]);

  const cancel = useCallback(
    async (id: string) => {
      const item = find(id);
      if (!item) return;
      patch(id, { status: "canceled" });
      controllers.current.get(id)?.abort("cancel");
      if (item.assetId) {
        await api.abortUpload({ assetId: item.assetId });
        clearStored(fingerprint(item.file));
      }
      refreshPending();
    },
    [patch, refreshPending, api],
  );

  /** Descarta una subida guardada que no se va a reanudar (cancela en R2 y la borra). */
  const discardPending = useCallback(
    async (fp: string) => {
      const stored = readStored(fp);
      if (stored) await api.abortUpload({ assetId: stored.assetId });
      clearStored(fp);
      refreshPending();
    },
    [refreshPending, api],
  );

  // Reanuda solas las subidas interrumpidas por la red cuando vuelve la conexión
  useEffect(() => {
    const onOnline = () => {
      let changed = false;
      itemsRef.current = itemsRef.current.map((i) => {
        if (i.status === "error" && i.netError) {
          changed = true;
          return { ...i, status: "queued", error: undefined, netError: false };
        }
        return i;
      });
      if (changed) {
        setItems(itemsRef.current);
        pump();
      }
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Aviso al cerrar la pestaña con subidas en curso
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (running.current.size > 0) event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  return { items, pending, stage, update, updateAll, remove, start, pause, resume, cancel, retry: resume, discardPending };
}
