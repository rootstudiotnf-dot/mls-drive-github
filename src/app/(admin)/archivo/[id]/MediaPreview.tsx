"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getAssetUrl } from "@/app/actions/uploads";
import type { AssetVariant } from "@/lib/assets/variants";
import { ImageIcon, MusicIcon, PlayIcon } from "@/components/icons";

/** Las URLs de ver duran 5 min: se renuevan a los 4 para que el streaming con Range no caduque. */
const REFRESH_MS = 4 * 60 * 1000;

export type MediaPreviewProps = {
  assetId: string;
  kind: "photo" | "video" | "audio" | "document" | "other";
  /** Extensión del original (para saber si el navegador puede mostrarlo directamente). */
  ext: string;
  title: string;
};

function Placeholder({ kind, text }: { kind: MediaPreviewProps["kind"]; text: string }) {
  const Icon = kind === "audio" ? MusicIcon : kind === "video" ? PlayIcon : ImageIcon;
  return (
    <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded-block border border-line bg-tone-2 text-text-3">
      <Icon size={32} />
      <p className="text-label">{text}</p>
    </div>
  );
}

function useSignedUrl(assetId: string, variant: AssetVariant, enabled: boolean, autoRefresh = true) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async () => {
    const res = await getAssetUrl(assetId, variant, "view");
    if (res.ok && res.data) {
      setUrl(res.data.url);
      setFailed(false);
      return res.data.url;
    }
    setFailed(true);
    return null;
  }, [assetId, variant]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      const res = await getAssetUrl(assetId, variant, "view");
      if (cancelled) return;
      if (res.ok && res.data) setUrl(res.data.url);
      else setFailed(true);
    })();
    const timer = autoRefresh ? setInterval(() => void refresh(), REFRESH_MS) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [assetId, variant, enabled, autoRefresh, refresh]);

  return { url, failed, refresh };
}

function TimedMedia({
  assetId,
  tag,
  title,
}: {
  assetId: string;
  tag: "video" | "audio";
  title: string;
}) {
  const { url, failed, refresh } = useSignedUrl(assetId, "original", true, false);
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const resume = useRef<{ time: number; playing: boolean } | null>(null);

  // Renueva la URL conservando la posición y el estado de reproducción (se guardan ANTES de cambiar el src)
  const swap = useCallback(async () => {
    const el = ref.current;
    if (el) resume.current = { time: el.currentTime, playing: !el.paused };
    await refresh();
  }, [refresh]);

  useEffect(() => {
    const timer = setInterval(() => void swap(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [swap]);

  const onLoadedMetadata = () => {
    const el = ref.current;
    const saved = resume.current;
    if (!el || !saved) return;
    el.currentTime = saved.time;
    if (saved.playing) void el.play().catch(() => undefined);
    resume.current = null;
  };

  if (failed) return <Placeholder kind={tag === "video" ? "video" : "audio"} text="No se pudo cargar la reproducción" />;
  if (!url) return <Placeholder kind={tag === "video" ? "video" : "audio"} text="Cargando…" />;

  const common = {
    ref,
    src: url,
    controls: true,
    preload: "metadata" as const,
    "aria-label": title,
    onLoadedMetadata,
    // si la URL caducó a mitad de reproducción, se firma otra y se sigue
    onError: () => void swap(),
  };

  return tag === "video" ? (
    <video {...common} className="max-h-[70vh] w-full rounded-block border border-line bg-bg" playsInline />
  ) : (
    <audio {...common} className="w-full" />
  );
}

function PhotoPreview({ assetId, ext, title }: { assetId: string; ext: string; title: string }) {
  // Versión web (WebP 1600 px). Si no existe (RAW, HEIC, o aún no generada) y el navegador puede mostrar
  // el original (JPEG/PNG/WebP), se usa el original; si no, marcador de posición.
  const viewable = ext === "jpg" || ext === "jpeg" || ext === "png" || ext === "webp";
  const web = useSignedUrl(assetId, "web", true);
  const original = useSignedUrl(assetId, "original", web.failed && viewable);

  const url = web.url ?? (web.failed && viewable ? original.url : null);
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt={title} className="max-h-[70vh] w-full rounded-block border border-line bg-tone-1 object-contain" />;
  }
  if (web.failed && (!viewable || original.failed)) {
    return <Placeholder kind="photo" text="Vista previa no disponible (RAW, HEIC o aún sin procesar)" />;
  }
  return <Placeholder kind="photo" text="Cargando…" />;
}

export function MediaPreview({ assetId, kind, ext, title }: MediaPreviewProps) {
  if (kind === "photo") return <PhotoPreview assetId={assetId} ext={ext} title={title} />;
  if (kind === "video") return <TimedMedia assetId={assetId} tag="video" title={title} />;
  if (kind === "audio") return <TimedMedia assetId={assetId} tag="audio" title={title} />;
  return <Placeholder kind={kind} text="Sin vista previa para este tipo de archivo" />;
}
