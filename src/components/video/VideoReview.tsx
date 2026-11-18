"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listComments } from "@/app/actions/comments";
import { getVideoStates, reprocessVideo } from "@/app/actions/video";
import { CommentsPanel } from "@/components/comments/CommentsPanel";
import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import type { CommentsData } from "@/lib/comments/types";
import type { VideoState } from "@/lib/video/jobs-types";
import { VideoPlayer, type PlayerHandle } from "./VideoPlayer";

/**
 * Página de revisión de un vídeo: reproductor grande a la izquierda y comentarios a la derecha (360 px); por debajo
 * de 1100 px el panel pasa debajo del reproductor. Mientras el vídeo se procesa muestra «Procesando…»; si falló,
 * «Error al procesar · Reprocesar» (solo para quien puede reprocesar).
 */
export function VideoReview({
  assetId,
  title,
  initialState,
  fps,
  canOriginal,
  canReprocess,
}: {
  assetId: string;
  title: string;
  initialState: VideoState;
  fps: number | null;
  canOriginal: boolean;
  canReprocess: boolean;
}) {
  const playerRef = useRef<PlayerHandle | null>(null);
  const [state, setState] = useState<VideoState>(initialState);
  const [data, setData] = useState<CommentsData>({ comments: [], canComment: false, canModerate: false });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await listComments(assetId);
    if (res.ok && res.data) setData(res.data);
  }, [assetId]);

  useEffect(() => {
    let cancelled = false;
    void listComments(assetId).then((res) => {
      if (!cancelled && res.ok && res.data) setData(res.data);
    });
    return () => {
      cancelled = true;
    };
  }, [assetId]);

  // Mientras se procesa, se consulta el estado cada 5 s hasta que termine
  useEffect(() => {
    if (state.status !== "queued" && state.status !== "processing") return;
    const timer = setInterval(() => {
      void getVideoStates([assetId]).then((res) => {
        const next = res.ok && res.data ? res.data[assetId] : undefined;
        if (next) setState(next);
      });
    }, 5000);
    return () => clearInterval(timer);
  }, [assetId, state.status]);

  const markers = useMemo(() => data.comments.filter((c) => !c.parentId && c.timecodeMs !== null).map((c) => ({ id: c.id, ms: c.timecodeMs as number })), [data.comments]);

  // «none»: vídeos anteriores a la Fase 6 (sin trabajo): se intenta reproducir el proxy igualmente y, si no existe, se ve el error
  const ready = state.status === "ready" || state.status === "none";

  return (
    <div className="grid min-w-0 gap-6 min-[1100px]:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0">
        {ready ? (
          <VideoPlayer
            assetId={assetId}
            title={title}
            fps={fps}
            canOriginal={canOriginal}
            markers={markers}
            playerRef={playerRef}
            onMarkerClick={(id) => {
              setActiveId(id);
              const marker = markers.find((m) => m.id === id);
              if (marker) playerRef.current?.seekMs(marker.ms);
            }}
          />
        ) : (
          <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded-card border border-line bg-surface px-6 text-center">
            {state.status === "failed" ? (
              <>
                <p className="text-body font-medium text-text">Error al procesar</p>
                {state.error ? <p className="max-w-md text-label text-text-2">{state.error}</p> : null}
                {canReprocess ? (
                  <Button
                    size="sm"
                    onClick={async () => {
                      const res = await reprocessVideo(assetId);
                      setMessage(res.message ?? (res.ok ? "Reprocesando…" : "No se pudo reprocesar."));
                      if (res.ok) setState({ status: "queued", error: null });
                    }}
                  >
                    Reprocesar
                  </Button>
                ) : null}
              </>
            ) : (
              <p className="text-body text-text-2" role="status">
                Procesando…
              </p>
            )}
          </div>
        )}
        {message ? <Notice variant="info" className="mt-3">{message}</Notice> : null}
        {ready && canReprocess ? (
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              className="rounded-control text-caption text-text-3 transition-colors duration-150 ease-ui hover:text-text"
              onClick={async () => {
                const res = await reprocessVideo(assetId);
                setMessage(res.message ?? (res.ok ? "Reprocesando…" : "No se pudo reprocesar."));
                if (res.ok) setState({ status: "queued", error: null });
              }}
            >
              Reprocesar
            </button>
          </div>
        ) : null}
      </div>

      <CommentsPanel
        assetId={assetId}
        data={data}
        activeId={activeId}
        getTimeMs={() => playerRef.current?.getTimeMs() ?? 0}
        pause={() => playerRef.current?.pause()}
        seekMs={(ms) => playerRef.current?.seekMs(ms)}
        onChanged={() => void refresh()}
      />
    </div>
  );
}
