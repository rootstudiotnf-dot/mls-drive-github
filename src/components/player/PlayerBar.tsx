"use client";

import { PauseIcon, PlayIcon, VolumeIcon } from "@/components/icons";
import { formatTimecode } from "@/lib/comments/types";
import { cn } from "@/lib/cn";
import { usePlayer } from "./PlayerProvider";
import { WaveformCanvas } from "./WaveformCanvas";

/** Barra fija inferior (sólida, sin transparencias) del reproductor global. No aparece hasta que suena algo. */
export function PlayerBar({ withSidebar = false }: { withSidebar?: boolean }) {
  const p = usePlayer();
  if (!p.track) return null;
  const progress = p.duration > 0 ? p.current / p.duration : 0;
  const button =
    "flex size-10 shrink-0 items-center justify-center rounded-pill text-text-2 transition-colors duration-150 ease-ui hover:bg-hover hover:text-text disabled:opacity-40";

  return (
    <>
      <div aria-hidden="true" className="h-24" />
      <div
        role="region"
        aria-label="Reproductor"
        className={cn("fixed inset-x-0 bottom-0 z-40 border-t border-line-hover bg-surface", withSidebar && "nav:pl-60")}
      >
        <div className="mx-auto flex max-w-[1400px] flex-col gap-1 px-4 py-2.5 sm:px-8">
          <div className="flex items-center gap-2 sm:gap-3">
            <div className="flex items-center gap-1">
              <button type="button" aria-label="Beat anterior" onClick={p.prev} disabled={p.index <= 0 && p.current <= 3} className={button}>
                <span aria-hidden="true" className="text-body leading-none">
                  ⏮
                </span>
              </button>
              <button
                type="button"
                aria-label={p.playing ? "Pausar" : "Reproducir"}
                onClick={p.toggle}
                className={cn(button, "bg-text text-bg hover:bg-text-2 hover:text-bg")}
              >
                {p.playing ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
              </button>
              <button type="button" aria-label="Beat siguiente" onClick={p.next} disabled={p.index + 1 >= p.queue.length} className={button}>
                <span aria-hidden="true" className="text-body leading-none">
                  ⏭
                </span>
              </button>
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-label font-medium text-text">{p.track.title}</p>
              <p className="truncate text-caption text-text-3" role="status">
                {p.error ?? (p.loading ? "Cargando…" : `${formatTimecode(p.current * 1000)} / ${formatTimecode(p.duration * 1000)}`)}
              </p>
            </div>
            <div className="hidden items-center gap-2 sm:flex">
              <VolumeIcon size={18} className="text-text-3" />
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={p.volume}
                aria-label="Volumen"
                onChange={(e) => p.setVolume(Number(e.target.value))}
                className="h-1 w-24 accent-[var(--text)]"
              />
            </div>
          </div>
          <WaveformCanvas
            peaks={p.waveform}
            progress={progress}
            height={36}
            label="Posición del beat"
            onSeek={p.duration > 0 ? (f) => p.seek(f * p.duration) : undefined}
          />
        </div>
      </div>
    </>
  );
}
