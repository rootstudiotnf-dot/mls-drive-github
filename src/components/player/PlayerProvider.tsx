"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getBeatPlayback, logBeatPlay, type Playback } from "@/app/actions/beats";

/**
 * Reproductor GLOBAL de beats: un solo `<audio>` que vive en el layout, así que sigue sonando al navegar entre
 * páginas y solo suena un beat a la vez. Reproduce SIEMPRE el preview (URL firmada de 15 min con Range); si la URL
 * caduca o falla se pide otra y se continúa en el mismo punto. Precarga el siguiente de la lista. Teclado (espacio,
 * ←/→ ±5 s) y Media Session (controles del sistema y de la pantalla bloqueada).
 */

export type Track = { id: string; title: string };

type PlayerState = {
  queue: Track[];
  index: number;
  playing: boolean;
  loading: boolean;
  error: string | null;
  current: number;
  duration: number;
  volume: number;
  waveform: number[] | null;
};

type PlayerApi = PlayerState & {
  track: Track | null;
  /** Empieza a sonar `queue[index]` (la lista actual del catálogo: «siguiente» y «anterior» la recorren). */
  playQueue: (queue: Track[], index: number, startAt?: number) => void;
  toggle: () => void;
  pause: () => void;
  next: () => void;
  prev: () => void;
  seek: (seconds: number) => void;
  setVolume: (value: number) => void;
};

const Ctx = createContext<PlayerApi | null>(null);

export function usePlayer(): PlayerApi {
  const value = useContext(Ctx);
  if (!value) throw new Error("usePlayer fuera de PlayerProvider");
  return value;
}

const FRESH_MS = 13 * 60 * 1000;
const MAX_RETRIES = 3;

export function PlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const cache = useRef(new Map<string, { playback: Playback; at: number }>());
  const token = useRef(0);
  const retries = useRef(0);
  const logged = useRef<string | null>(null);
  const [state, setState] = useState<PlayerState>({ queue: [], index: -1, playing: false, loading: false, error: null, current: 0, duration: 0, volume: 1, waveform: null });
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state; // (se lee solo desde manejadores de eventos, nunca durante el render)
  }, [state]);

  const fetchPlayback = useCallback(async (id: string): Promise<Playback | null> => {
    const hit = cache.current.get(id);
    if (hit && Date.now() - hit.at < FRESH_MS) return hit.playback;
    const res = await getBeatPlayback(id);
    if (!res.ok || !res.data) return null;
    cache.current.set(id, { playback: res.data, at: Date.now() });
    return res.data;
  }, []);

  /** Carga y (opcionalmente) reproduce un elemento de la lista, y precarga el siguiente. */
  const start = useCallback(
    async (queue: Track[], index: number, autoplay: boolean, resumeAt: number) => {
      const audio = audioRef.current;
      const track = queue[index];
      if (!audio || !track) return;
      const mine = ++token.current;
      setState((s) => ({ ...s, queue, index, loading: true, error: null, current: resumeAt, playing: false }));
      const playback = await fetchPlayback(track.id);
      if (mine !== token.current) return; // llegó una petición más nueva
      if (!playback) {
        setState((s) => ({ ...s, loading: false, error: "No se pudo cargar el preview." }));
        return;
      }
      audio.src = playback.url;
      audio.currentTime = resumeAt;
      setState((s) => ({ ...s, loading: false, duration: playback.durationSeconds ?? 0, waveform: playback.waveform }));
      if (autoplay) await audio.play().catch(() => undefined);
      // precarga del siguiente
      const upcoming = queue[index + 1];
      if (upcoming) {
        void fetchPlayback(upcoming.id).then((p) => {
          if (p) {
            const warm = new Audio();
            warm.preload = "auto";
            warm.src = p.url; // calienta la caché; la reproducción real usa el mismo elemento y la misma URL
          }
        });
      }
    },
    [fetchPlayback],
  );

  const playQueue = useCallback(
    (queue: Track[], index: number, startAt = 0) => {
      retries.current = 0;
      logged.current = null;
      void start(queue, index, true, startAt);
    },
    [start],
  );

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !audio.src) return;
    if (audio.paused) void audio.play().catch(() => undefined);
    else audio.pause();
  }, []);
  const pause = useCallback(() => audioRef.current?.pause(), []);
  const next = useCallback(() => {
    const s = stateRef.current;
    if (s.index + 1 < s.queue.length) {
      retries.current = 0;
      logged.current = null;
      void start(s.queue, s.index + 1, true, 0);
    }
  }, [start]);
  const prev = useCallback(() => {
    const s = stateRef.current;
    const audio = audioRef.current;
    if (audio && audio.currentTime > 3) {
      audio.currentTime = 0; // como en cualquier reproductor: «anterior» reinicia si ya avanzó
      return;
    }
    if (s.index > 0) {
      retries.current = 0;
      logged.current = null;
      void start(s.queue, s.index - 1, true, 0);
    }
  }, [start]);
  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (audio) audio.currentTime = Math.max(0, Math.min(seconds, audio.duration || seconds));
  }, []);
  const setVolume = useCallback((value: number) => {
    if (audioRef.current) audioRef.current.volume = value;
    setState((s) => ({ ...s, volume: value }));
  }, []);

  // URL caducada o error de red: nueva firma y seguir donde estaba
  const recover = useCallback(() => {
    const s = stateRef.current;
    const audio = audioRef.current;
    const track = s.queue[s.index];
    if (!audio || !track || retries.current >= MAX_RETRIES) {
      setState((cur) => ({ ...cur, error: "No se pudo reproducir el beat. Comprueba tu conexión.", playing: false }));
      return;
    }
    retries.current += 1;
    cache.current.delete(track.id);
    void start(s.queue, s.index, !audio.paused || s.playing, audio.currentTime);
  }, [start]);

  // Teclado global: espacio y ←/→ ±5 s (no actúa al escribir ni dentro del reproductor de vídeo)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const s = stateRef.current;
      if (s.index < 0 || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, button, a, [contenteditable=true], [role=slider], [role=group][aria-label^='Reproductor de vídeo'], dialog")) return;
      const audio = audioRef.current;
      if (!audio) return;
      if (event.key === " ") {
        event.preventDefault();
        toggle();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + 5);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        audio.currentTime = Math.max(0, audio.currentTime - 5);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [toggle]);

  // Media Session API (controles del sistema / pantalla bloqueada)
  const track = state.queue[state.index] ?? null;
  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator) || !track) return;
    navigator.mediaSession.metadata = new MediaMetadata({ title: track.title, artist: "MLS Drive" });
    navigator.mediaSession.playbackState = state.playing ? "playing" : "paused";
    const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        /* acción no soportada por este navegador */
      }
    };
    set("play", () => void audioRef.current?.play().catch(() => undefined));
    set("pause", () => audioRef.current?.pause());
    set("previoustrack", prev);
    set("nexttrack", next);
    set("seekbackward", () => seek((audioRef.current?.currentTime ?? 0) - 5));
    set("seekforward", () => seek((audioRef.current?.currentTime ?? 0) + 5));
    set("seekto", (d) => typeof d.seekTime === "number" && seek(d.seekTime));
  }, [track, state.playing, prev, next, seek]);

  const api = useMemo<PlayerApi>(() => ({ ...state, track, playQueue, toggle, pause, next, prev, seek, setVolume }), [state, track, playQueue, toggle, pause, next, prev, seek, setVolume]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <audio
        ref={audioRef}
        preload="auto"
        onPlay={() => {
          setState((s) => ({ ...s, playing: true }));
          const id = stateRef.current.queue[stateRef.current.index]?.id;
          if (id && logged.current !== id) {
            logged.current = id;
            void logBeatPlay(id); // como máximo una escucha por persona y beat cada hora (lo asegura el servidor)
          }
        }}
        onPause={() => setState((s) => ({ ...s, playing: false }))}
        onTimeUpdate={(e) => setState((s) => ({ ...s, current: e.currentTarget.currentTime }))}
        onLoadedMetadata={(e) => {
          retries.current = 0;
          const d = e.currentTarget.duration;
          if (Number.isFinite(d)) setState((s) => ({ ...s, duration: d }));
        }}
        onEnded={next}
        onError={recover}
      />
    </Ctx.Provider>
  );
}
