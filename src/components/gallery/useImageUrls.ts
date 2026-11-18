"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getThumbUrls } from "@/app/actions/browse";

/**
 * URLs firmadas de miniaturas (400 px) o versión web (2048 px) PEDIDAS POR LOTES (una llamada firma hasta 50;
 * el servidor autoriza cada foto por separado) y CACHEADAS mientras no caduquen (las URLs valen 5 min; se
 * renuevan a los 4,5). Las fotos sin derivado (RAW sin vista previa, HEIC no decodificable…) se recuerdan
 * como «sin imagen» para no volver a pedirlas: la interfaz muestra su marcador de posición.
 */

const BATCH = 50;
const DEBOUNCE_MS = 40;
const FRESH_MS = 4.5 * 60 * 1000;

export function useImageUrls(variant: "thumb" | "web") {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const cache = useRef(new Map<string, { url: string; at: number }>());
  const inflight = useRef(new Set<string>());
  const absent = useRef(new Set<string>());
  const retries = useRef(new Map<string, number>());
  const queued = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null; // (en desarrollo el efecto se monta dos veces: no dejar un temporizador «fantasma»)
    };
  }, []);

  const flush = useCallback(async () => {
    timer.current = null;
    const ids = [...queued.current];
    queued.current.clear();
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      for (const id of chunk) inflight.current.add(id);
      const res = await getThumbUrls(chunk, variant).catch(() => null);
      for (const id of chunk) inflight.current.delete(id);
      if (!alive.current) return;
      if (res?.ok && res.data) {
        const next: Record<string, string> = {};
        const now = Date.now();
        for (const id of chunk) {
          const url = res.data[id];
          if (url) {
            cache.current.set(id, { url, at: now });
            next[id] = url;
          } else absent.current.add(id);
        }
        setUrls((current) => ({ ...current, ...next }));
      }
    }
  }, [variant]);

  /** Pide las URLs que falten o estén a punto de caducar. `force` ignora la caché (p. ej. tras un error de carga). */
  const ensure = useCallback(
    (ids: string[], force = false) => {
      const now = Date.now();
      for (const id of ids) {
        if (inflight.current.has(id) || queued.current.has(id)) continue;
        if (force) {
          // Un error de carga puede deberse a una URL caducada: se reintenta, pero no en bucle (p. ej. si el objeto no existe)
          const tries = retries.current.get(id) ?? 0;
          if (tries >= 2) continue;
          retries.current.set(id, tries + 1);
        } else {
          if (absent.current.has(id)) continue;
          const hit = cache.current.get(id);
          if (hit && now - hit.at < FRESH_MS) continue;
        }
        queued.current.add(id);
      }
      if (queued.current.size > 0 && !timer.current) timer.current = setTimeout(() => void flush(), DEBOUNCE_MS);
    },
    [flush],
  );

  const hasNone = useCallback((id: string) => absent.current.has(id), []);

  return { urls, ensure, hasNone };
}
