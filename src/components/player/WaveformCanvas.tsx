"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";

/**
 * Forma de onda (≈800 picos 0-255) dibujada en un canvas: la parte reproducida en el color de texto y el resto atenuado.
 * Interactiva: pulsar o arrastrar busca ese punto (`onSeek` recibe una fracción 0-1). Los colores salen de los tokens.
 */
export function WaveformCanvas({
  peaks,
  progress,
  onSeek,
  height = 48,
  label,
  className,
}: {
  peaks: number[] | null;
  /** 0-1 */
  progress: number;
  onSeek?: (fraction: number) => void;
  height?: number;
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drag = useRef(false);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.round(height * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      const styles = getComputedStyle(canvas);
      const played = styles.getPropertyValue("--text").trim() || "#fff";
      const rest = styles.getPropertyValue("--tone-5").trim() || "#444";
      const bar = 3;
      const gap = 2;
      const count = Math.max(1, Math.floor(width / (bar + gap)));
      const data = peaks && peaks.length > 0 ? peaks : new Array(count).fill(40);
      ctx.clearRect(0, 0, width, height);
      for (let i = 0; i < count; i++) {
        // cada barra toma el pico máximo de su tramo
        const from = Math.floor((i / count) * data.length);
        const to = Math.max(from + 1, Math.floor(((i + 1) / count) * data.length));
        let peak = 0;
        for (let k = from; k < to; k++) peak = Math.max(peak, data[k] as number);
        const h = Math.max(2, (peak / 255) * (height - 4));
        ctx.fillStyle = i / count <= progress ? played : rest;
        ctx.fillRect(i * (bar + gap), (height - h) / 2, bar, h);
      }
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [peaks, progress, height]);

  const seekAt = (clientX: number) => {
    const rect = ref.current?.getBoundingClientRect();
    if (rect && onSeek) onSeek(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)));
  };

  return (
    <canvas
      ref={ref}
      role={onSeek ? "slider" : "img"}
      aria-label={label}
      aria-valuemin={onSeek ? 0 : undefined}
      aria-valuemax={onSeek ? 100 : undefined}
      aria-valuenow={onSeek ? Math.round(progress * 100) : undefined}
      tabIndex={onSeek ? 0 : -1}
      style={{ height }}
      className={cn("w-full touch-none", onSeek && "cursor-pointer", className)}
      onPointerDown={(e) => {
        if (!onSeek) return;
        drag.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        seekAt(e.clientX);
      }}
      onPointerMove={(e) => drag.current && seekAt(e.clientX)}
      onPointerUp={() => (drag.current = false)}
      onKeyDown={(e) => {
        if (!onSeek) return;
        if (e.key === "ArrowRight") onSeek(Math.min(1, progress + 0.02));
        else if (e.key === "ArrowLeft") onSeek(Math.max(0, progress - 0.02));
      }}
    />
  );
}
