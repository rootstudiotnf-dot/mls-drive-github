"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PhotoComments } from "@/components/comments/PhotoComments";
import { ChevronIcon, CloseIcon, DownloadIcon, HeartIcon } from "@/components/icons";
import { formatBytes } from "@/lib/format";
import type { SessionPhoto } from "@/lib/sessions/types";
import { cn } from "@/lib/cn";
import { useImageUrls } from "./useImageUrls";

/**
 * Visor a pantalla completa con `<dialog>` modal (el navegador atrapa el foco y gestiona Esc).
 *  · ← → cambian de foto; deslizar en móvil; Esc cierra.
 *  · Usa la versión web (2048 px) y, mientras carga, la miniatura ya descargada sobre el color medio.
 *  · Precarga la foto anterior y la siguiente.
 *  · Descargar y favorita desde el visor (solo si se permite).
 *  · Transiciones de 180 ms con la Web Animations API; con `prefers-reduced-motion` no hay movimiento.
 */

const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const SWIPE_PX = 60;

export function PhotoViewer({
  photos,
  index,
  thumbUrls,
  favorites,
  canDownload,
  downloadLabel,
  onClose,
  onIndex,
  onFavorite,
  onDownload,
  canComment = false,
}: {
  /** Cosmética: ofrece el panel de comentarios (el servidor decide quién lee y escribe). */
  canComment?: boolean;
  photos: SessionPhoto[];
  index: number;
  /** Miniaturas ya cargadas por la galería (se muestran al instante mientras llega la versión web). */
  thumbUrls: Record<string, string>;
  favorites: ReadonlySet<string>;
  canDownload: (photo: SessionPhoto) => boolean;
  downloadLabel: string;
  onClose: () => void;
  onIndex: (next: number) => void;
  onFavorite: (photo: SessionPhoto) => void;
  onDownload: (photo: SessionPhoto) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ x: number; y: number; id: number; moved: boolean } | null>(null);
  const direction = useRef<1 | -1>(1);
  const { urls, ensure } = useImageUrls("web");
  const [loaded, setLoaded] = useState<string | null>(null);
  const [showComments, setShowComments] = useState(false);

  const photo = photos[index];
  const previous = photos[index - 1];
  const next = photos[index + 1];

  // Abrir como modal (foco atrapado, Esc nativo) y avisar al cerrar
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    if (!reduced()) dialog.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: "ease-out" });
    closeRef.current?.focus();
    // En desarrollo (StrictMode) el efecto se ejecuta dos veces y el cierre de la primera pasada llega tarde:
    // solo cuenta si el diálogo está realmente cerrado.
    const onCloseEvent = () => {
      if (!dialog.open) onClose();
    };
    dialog.addEventListener("close", onCloseEvent);
    return () => {
      dialog.removeEventListener("close", onCloseEvent);
      if (dialog.open) dialog.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Versión web de la foto actual y precarga de las vecinas
  useEffect(() => {
    if (!photo) return;
    ensure([photo.id, ...(previous ? [previous.id] : []), ...(next ? [next.id] : [])]);
  }, [photo, previous, next, ensure]);

  useEffect(() => {
    for (const neighbour of [previous, next]) {
      const url = neighbour ? urls[neighbour.id] : undefined;
      if (url) {
        const image = new Image();
        image.decoding = "async";
        image.src = url; // calienta la caché del navegador
      }
    }
  }, [previous, next, urls]);

  const go = useCallback(
    (delta: 1 | -1) => {
      const target = index + delta;
      if (target < 0 || target >= photos.length) return;
      direction.current = delta;
      onIndex(target);
    },
    [index, photos.length, onIndex],
  );

  // Transición suave al cambiar de foto
  useEffect(() => {
    const img = imageRef.current;
    if (!img || reduced()) return;
    img.animate(
      [{ opacity: 0.2, transform: `translateX(${direction.current * 24}px)` }, { opacity: 1, transform: "translateX(0)" }],
      { duration: 180, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
  }, [photo?.id]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    // Escribiendo un comentario, las flechas son del texto, no del visor
    if ((event.target as HTMLElement).closest("textarea, input")) return;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      go(1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      go(-1);
    }
  };

  // Deslizar (táctil): la foto sigue al dedo y, al soltar, cambia o vuelve
  const onPointerDown = (event: React.PointerEvent) => {
    if (event.pointerType === "mouse") return;
    drag.current = { x: event.clientX, y: event.clientY, id: event.pointerId, moved: false };
    try {
      stageRef.current?.setPointerCapture(event.pointerId);
    } catch {
      /* puntero ya liberado: el gesto sigue funcionando sin captura */
    }
  };
  const onPointerMove = (event: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    const dx = event.clientX - d.x;
    if (!d.moved && Math.abs(dx) < 8) return;
    d.moved = true;
    const edge = (dx > 0 && !previous) || (dx < 0 && !next);
    if (imageRef.current) imageRef.current.style.transform = `translateX(${edge ? dx / 4 : dx}px)`; // resistencia en los extremos
  };
  const onPointerUp = (event: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.id !== event.pointerId) return;
    const dx = event.clientX - d.x;
    const img = imageRef.current;
    if (Math.abs(dx) > SWIPE_PX && ((dx < 0 && next) || (dx > 0 && previous))) {
      if (img) img.style.transform = "";
      go(dx < 0 ? 1 : -1);
    } else if (img) {
      if (reduced()) img.style.transform = "";
      else img.animate([{ transform: img.style.transform || "none" }, { transform: "none" }], { duration: 160, easing: "ease-out" }).onfinish = () => (img.style.transform = "");
    }
  };

  if (!photo) return null;
  const webUrl = urls[photo.id];
  const thumbUrl = thumbUrls[photo.id];
  const fav = favorites.has(photo.id);
  const downloadable = canDownload(photo);

  return (
    <dialog
      ref={dialogRef}
      aria-label={`Foto ${index + 1} de ${photos.length}: ${photo.title}`}
      onKeyDown={onKeyDown}
      className="fixed inset-0 m-0 h-dvh max-h-none w-dvw max-w-none overflow-hidden border-0 bg-bg p-0 text-text backdrop:bg-bg"
    >
      <div className="flex h-full w-full flex-col">
        {/* Barra superior */}
        <div className="flex h-14 shrink-0 items-center justify-between gap-3 px-4 sm:px-6">
          <p className="min-w-0 truncate text-label text-text-2">
            <span className="font-medium text-text">{photo.filename}</span>
            <span className="hidden sm:inline">
              {" "}
              · {formatBytes(photo.sizeBytes)}
              {photo.width && photo.height ? ` · ${photo.width}×${photo.height}` : ""}
            </span>
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="mr-2 text-caption text-text-3" aria-hidden="true">
              {index + 1} / {photos.length}
            </span>
            <ViewerButton label={fav ? "Quitar de favoritas" : "Marcar como favorita"} pressed={fav} onClick={() => onFavorite(photo)}>
              <HeartIcon size={20} fill={fav ? "currentColor" : "none"} />
            </ViewerButton>
            {canComment ? (
              <button type="button" aria-pressed={showComments} onClick={() => setShowComments((v) => !v)} className={cn("h-10 rounded-pill px-3 text-label font-medium transition-colors duration-150 ease-ui hover:bg-hover hover:text-text", showComments ? "text-text" : "text-text-2")}>
                Comentarios
              </button>
            ) : null}
            {downloadable ? (
              <ViewerButton label={downloadLabel} onClick={() => onDownload(photo)}>
                <DownloadIcon size={20} />
              </ViewerButton>
            ) : null}
            <button
              ref={closeRef}
              type="button"
              aria-label="Cerrar visor"
              onClick={() => dialogRef.current?.close()}
              className="flex size-10 items-center justify-center rounded-pill text-text-2 transition-colors duration-150 ease-ui hover:bg-hover hover:text-text"
            >
              <CloseIcon size={20} />
            </button>
          </div>
        </div>

        {/* Escenario */}
        <div
          ref={stageRef}
          className="relative flex min-h-0 flex-1 touch-pan-y items-center justify-center px-2 pb-4 sm:px-16"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div className="relative flex size-full items-center justify-center" style={{ backgroundColor: loaded === photo.id ? undefined : (photo.avgColor ?? undefined) }}>
            {thumbUrl && loaded !== photo.id ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={thumbUrl} alt="" aria-hidden="true" className="absolute max-h-full max-w-full object-contain opacity-80" draggable={false} />
            ) : null}
            {webUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                ref={imageRef}
                key={photo.id}
                src={webUrl}
                alt={photo.title}
                draggable={false}
                onLoad={() => setLoaded(photo.id)}
                onError={() => ensure([photo.id], true)}
                className={cn("relative max-h-full max-w-full object-contain select-none", loaded !== photo.id && "opacity-0")}
              />
            ) : (
              <div ref={imageRef as unknown as React.RefObject<HTMLDivElement>} className="flex size-full items-center justify-center text-label text-text-3">
                {thumbUrl ? null : "Cargando…"}
              </div>
            )}
          </div>

          {previous ? (
            <button
              type="button"
              aria-label="Foto anterior"
              onClick={() => go(-1)}
              className="absolute top-1/2 left-2 hidden size-11 -translate-y-1/2 items-center justify-center rounded-pill border border-line bg-surface text-text transition-colors duration-150 ease-ui hover:border-line-hover sm:flex"
            >
              <ChevronIcon size={20} className="rotate-90" />
            </button>
          ) : null}
          {next ? (
            <button
              type="button"
              aria-label="Foto siguiente"
              onClick={() => go(1)}
              className="absolute top-1/2 right-2 hidden size-11 -translate-y-1/2 items-center justify-center rounded-pill border border-line bg-surface text-text transition-colors duration-150 ease-ui hover:border-line-hover sm:flex"
            >
              <ChevronIcon size={20} className="-rotate-90" />
            </button>
          ) : null}
          {showComments && canComment ? (
            <aside aria-label="Comentarios de la foto" className="absolute inset-y-0 right-0 z-10 w-full overflow-y-auto border-l border-line bg-surface p-4 sm:w-96">
              <PhotoComments key={photo.id} assetId={photo.id} />
            </aside>
          ) : null}
        </div>
      </div>
    </dialog>
  );
}

function ViewerButton({
  label,
  onClick,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "flex size-10 items-center justify-center rounded-pill transition-colors duration-150 ease-ui hover:bg-hover hover:text-text",
        pressed ? "text-text" : "text-text-2",
      )}
    >
      {children}
    </button>
  );
}
