"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type RefObject } from "react";
import { getAssetUrl } from "@/app/actions/uploads";
import { ExpandIcon, MuteIcon, PauseIcon, PlayIcon, VolumeIcon } from "@/components/icons";
import { cn } from "@/lib/cn";
import { formatTimecode } from "@/lib/comments/types";

/**
 * Reproductor propio sobre `<video>` nativo. Reproduce el PROXY (H.264 1080p con faststart) y, si la persona puede
 * descargar o editar, ofrece «Original». Las URLs firmadas valen 5 minutos: si caduca una a mitad de reproducción
 * se pide otra y se continúa en el mismo punto (sin cortar si está en pausa; si está reproduciendo, al primer
 * fallo de red). Atajos: espacio/K, J/L (±10 s), ←/→ (±5 s), `,` y `.` (fotograma), F, M.
 */

export type PlayerHandle = { getTimeMs: () => number; seekMs: (ms: number) => void; pause: () => void };
export type Marker = { id: string; ms: number };

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
const RESIGN_AFTER_MS = 4 * 60 * 1000;

type Quality = "web" | "original";

export function VideoPlayer({
  assetId,
  title,
  fps,
  canOriginal,
  markers,
  playerRef,
  onMarkerClick,
  onTime,
}: {
  assetId: string;
  title: string;
  fps: number | null;
  canOriginal: boolean;
  markers: Marker[];
  playerRef?: RefObject<PlayerHandle | null>;
  onMarkerClick?: (id: string) => void;
  onTime?: (ms: number) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const signedAt = useRef(0);
  const retries = useRef(0);
  const resume = useRef<{ time: number; play: boolean } | null>(null);
  const scrubbing = useRef(false);

  const [quality, setQuality] = useState<Quality>("web");
  const [src, setSrc] = useState<string | null>(null);
  const [poster, setPoster] = useState<string | undefined>();
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [hover, setHover] = useState<{ x: number; ms: number } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  const frameRate = fps && fps > 1 && fps < 241 ? fps : 30;

  useImperativeHandle(playerRef, () => ({
    getTimeMs: () => Math.round((videoRef.current?.currentTime ?? 0) * 1000),
    seekMs: (ms: number) => {
      const v = videoRef.current;
      if (!v) return;
      v.currentTime = Math.max(0, ms / 1000);
      setCurrent(v.currentTime);
    },
    pause: () => videoRef.current?.pause(),
  }));

  // --- Firma de URLs ------------------------------------------------------------------------------------------
  const sign = useCallback(
    async (variant: "proxy" | "original" | "poster") => {
      const res = await getAssetUrl(assetId, variant, "view");
      if (!res.ok || !res.data) throw new Error(res.ok ? "sin url" : res.message);
      return res.data.url;
    },
    [assetId],
  );

  const load = useCallback(
    async (target: Quality, keep?: { time: number; play: boolean }) => {
      setPhase("loading");
      setMessage(null);
      try {
        const url = await sign(target === "web" ? "proxy" : "original");
        signedAt.current = Date.now();
        resume.current = keep ?? null;
        setSrc(url);
      } catch {
        setPhase("error");
        setMessage("No se pudo cargar el vídeo.");
      }
    },
    [sign],
  );

  useEffect(() => {
    let cancelled = false;
    void sign("poster").then((url) => !cancelled && setPoster(url)).catch(() => undefined);
    void sign("proxy")
      .then((url) => {
        if (cancelled) return;
        signedAt.current = Date.now();
        setSrc(url);
      })
      .catch(() => {
        if (cancelled) return;
        setPhase("error");
        setMessage("No se pudo cargar el vídeo.");
      });
    return () => {
      cancelled = true;
    };
  }, [sign]);

  // Renovación silenciosa de la firma cuando está en pausa y se acerca la caducidad
  useEffect(() => {
    const timer = setInterval(() => {
      const v = videoRef.current;
      if (!v || !src || v.paused === false) return;
      if (Date.now() - signedAt.current > RESIGN_AFTER_MS) void load(quality, { time: v.currentTime, play: false });
    }, 30_000);
    return () => clearInterval(timer);
  }, [src, quality, load]);

  // Recuperación ante un error de red o una URL caducada: nueva firma y seguir donde estaba
  const recover = useCallback(() => {
    const v = videoRef.current;
    if (retries.current >= 3) {
      setPhase("error");
      setMessage("No se pudo reproducir el vídeo. Comprueba tu conexión.");
      return;
    }
    retries.current += 1;
    void load(quality, { time: v?.currentTime ?? 0, play: v ? !v.paused : false });
  }, [load, quality]);

  // --- Acciones ---------------------------------------------------------------------------------------------------
  const toggle = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => undefined);
    else v.pause();
  }, []);

  const seekBy = useCallback((seconds: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.min(Math.max(0, v.currentTime + seconds), v.duration || Infinity);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void boxRef.current?.requestFullscreen?.();
  }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === boxRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select")) return; // escribiendo: los atajos no actúan
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const onButton = target.closest("button") !== null;
    switch (event.key) {
      case " ":
        if (onButton) return; // el botón enfocado conserva su acción
        event.preventDefault();
        toggle();
        break;
      case "k":
      case "K":
        event.preventDefault();
        toggle();
        break;
      case "j":
      case "J":
        event.preventDefault();
        seekBy(-10);
        break;
      case "l":
      case "L":
        event.preventDefault();
        seekBy(10);
        break;
      case "ArrowLeft":
        event.preventDefault();
        seekBy(-5);
        break;
      case "ArrowRight":
        event.preventDefault();
        seekBy(5);
        break;
      case ",":
      case ".": {
        event.preventDefault();
        const v = videoRef.current;
        if (!v) break;
        v.pause();
        seekBy(event.key === "," ? -1 / frameRate : 1 / frameRate);
        break;
      }
      case "f":
      case "F":
        event.preventDefault();
        toggleFullscreen();
        break;
      case "m":
      case "M":
        event.preventDefault();
        setMuted((m) => !m);
        break;
    }
  };

  // --- Barra de progreso ------------------------------------------------------------------------------------------------
  const msAt = (clientX: number) => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect || !duration) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * duration * 1000;
  };
  const scrubTo = (clientX: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = msAt(clientX) / 1000;
    setCurrent(v.currentTime);
  };

  const pct = (value: number) => (duration > 0 ? `${Math.min(100, (value / duration) * 100)}%` : "0%");
  const changeQuality = (next: Quality) => {
    if (next === quality) return;
    const v = videoRef.current;
    setQuality(next);
    retries.current = 0;
    void load(next, { time: v?.currentTime ?? 0, play: v ? !v.paused : false });
  };

  const buttonClass =
    "flex size-9 shrink-0 items-center justify-center rounded-pill text-text-2 transition-colors duration-150 ease-ui hover:bg-hover hover:text-text";

  return (
    <div
      ref={boxRef}
      tabIndex={0}
      role="group"
      aria-label={`Reproductor de vídeo: ${title}`}
      onKeyDown={onKeyDown}
      className={cn("flex min-w-0 flex-col overflow-hidden rounded-card border border-line bg-bg outline-offset-2", fullscreen && "h-full justify-center rounded-none border-0")}
    >
      <div className="relative bg-tone-1">
        <video
          ref={videoRef}
          src={src ?? undefined}
          poster={poster}
          preload="metadata"
          playsInline
          onClick={toggle}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            setDuration(v.duration);
            setPhase("ready");
            if (resume.current) {
              v.currentTime = resume.current.time;
              if (resume.current.play) void v.play().catch(() => undefined);
              resume.current = null;
            }
            v.playbackRate = rate;
          }}
          onCanPlay={() => {
            retries.current = 0;
            setPhase("ready");
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onTimeUpdate={(e) => {
            if (scrubbing.current) return;
            setCurrent(e.currentTarget.currentTime);
            onTime?.(Math.round(e.currentTarget.currentTime * 1000));
          }}
          onProgress={(e) => {
            const v = e.currentTarget;
            for (let i = 0; i < v.buffered.length; i++) {
              if (v.buffered.start(i) <= v.currentTime && v.currentTime <= v.buffered.end(i)) setBuffered(v.buffered.end(i));
            }
          }}
          onVolumeChange={(e) => {
            setVolume(e.currentTarget.volume);
          }}
          onError={recover}
          className={cn("block aspect-video w-full bg-tone-1 object-contain", fullscreen && "aspect-auto h-full max-h-[calc(100dvh-7rem)]")}
        />
        {phase === "loading" ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-label text-text-2" role="status">
            Cargando…
          </div>
        ) : null}
        {phase === "error" ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-bg px-6 text-center" role="alert">
            <p className="text-body text-text">{message ?? "No se pudo reproducir el vídeo."}</p>
            <button
              type="button"
              onClick={() => {
                retries.current = 0;
                void load(quality);
              }}
              className="h-9 rounded-pill border border-line px-5 text-label font-medium text-text transition-colors duration-150 ease-ui hover:border-line-hover"
            >
              Reintentar
            </button>
          </div>
        ) : null}
      </div>

      {/* Controles: barra sólida debajo del vídeo (sin superposiciones) */}
      <div className="flex flex-col gap-1 border-t border-line bg-surface px-3 pt-3 pb-2">
        <div className="relative px-1.5">
          {hover ? (
            <span className="pointer-events-none absolute -top-7 -translate-x-1/2 rounded-control border border-line bg-bg px-2 py-0.5 text-caption text-text" style={{ left: hover.x }}>
              {formatTimecode(hover.ms)}
            </span>
          ) : null}
          <div
            ref={barRef}
            role="slider"
            tabIndex={-1}
            aria-label="Posición del vídeo"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(current)}
            aria-valuetext={`${formatTimecode(current * 1000)} de ${formatTimecode(duration * 1000)}`}
            className="relative flex h-5 cursor-pointer touch-none items-center"
            onPointerDown={(e) => {
              scrubbing.current = true;
              e.currentTarget.setPointerCapture(e.pointerId);
              scrubTo(e.clientX);
            }}
            onPointerMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setHover({ x: e.clientX - rect.left, ms: msAt(e.clientX) });
              if (scrubbing.current) scrubTo(e.clientX);
            }}
            onPointerUp={() => {
              scrubbing.current = false;
            }}
            onPointerLeave={() => setHover(null)}
          >
            <div className="relative h-1.5 w-full overflow-hidden rounded-pill bg-tone-4">
              <div className="absolute inset-y-0 left-0 bg-tone-5" style={{ width: pct(buffered) }} />
              <div className="absolute inset-y-0 left-0 bg-text" style={{ width: pct(current) }} />
            </div>
            {markers.map((marker) => (
              <button
                key={marker.id}
                type="button"
                aria-label={`Ir al comentario de ${formatTimecode(marker.ms)}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onMarkerClick?.(marker.id)}
                className="absolute top-0 h-5 w-2 -translate-x-1/2 rounded-sm after:absolute after:top-0.5 after:left-1/2 after:h-1.5 after:w-1 after:-translate-x-1/2 after:rounded-sm after:bg-text after:content-['']"
                style={{ left: pct(marker.ms / 1000) }}
              />
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
          <button type="button" aria-label={playing ? "Pausar" : "Reproducir"} onClick={toggle} className={buttonClass}>
            {playing ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
          </button>
          <span className="px-1 text-label text-text-2 tabular-nums" aria-live="off">
            {formatTimecode(current * 1000)} / {formatTimecode(duration * 1000)}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <button type="button" aria-label={muted || volume === 0 ? "Activar sonido" : "Silenciar"} onClick={() => setMuted((m) => !m)} className={buttonClass}>
              {muted || volume === 0 ? <MuteIcon size={20} /> : <VolumeIcon size={20} />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              aria-label="Volumen"
              onChange={(e) => {
                const value = Number(e.target.value);
                setMuted(false);
                setVolume(value);
                if (videoRef.current) videoRef.current.volume = value;
              }}
              className="hidden h-1 w-20 accent-[var(--text)] sm:block"
            />
            <select
              aria-label="Velocidad de reproducción"
              value={rate}
              onChange={(e) => {
                const value = Number(e.target.value);
                setRate(value);
                if (videoRef.current) videoRef.current.playbackRate = value;
              }}
              className="h-8 rounded-control border border-line bg-surface px-2 text-label text-text-2 hover:border-line-hover"
            >
              {RATES.map((r) => (
                <option key={r} value={r}>
                  {r}×
                </option>
              ))}
            </select>
            {canOriginal ? (
              <select
                aria-label="Calidad"
                value={quality}
                onChange={(e) => changeQuality(e.target.value as Quality)}
                className="h-8 rounded-control border border-line bg-surface px-2 text-label text-text-2 hover:border-line-hover"
              >
                <option value="web">Web</option>
                <option value="original">Original</option>
              </select>
            ) : null}
            <button type="button" aria-label={fullscreen ? "Salir de pantalla completa" : "Pantalla completa"} onClick={toggleFullscreen} className={buttonClass}>
              <ExpandIcon size={20} />
            </button>
          </div>
        </div>
      </div>
      <MutedSync videoRef={videoRef} muted={muted} />
    </div>
  );
}

/** Mantiene `muted` del elemento sincronizado con el estado (sin leer refs durante el render). */
function MutedSync({ videoRef, muted }: { videoRef: RefObject<HTMLVideoElement | null>; muted: boolean }) {
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
  }, [videoRef, muted]);
  return null;
}
