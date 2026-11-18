"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";

const VIEW = 320; // lado del recuadro de edición (px CSS)
const OUTPUT = 1000; // lado de la portada final (px)

/**
 * Recorte 1:1 de la portada, en el navegador (la imagen original nunca sale sin recortar). Se arrastra para encuadrar y
 * el deslizador acerca. Devuelve un JPEG cuadrado de 1000 px; la subida la hace el motor de subidas normal.
 */
export function CoverCropModal({ file, onCancel, onDone }: { file: File | null; onCancel: () => void; onDone: (cropped: File) => void }) {
  return (
    <Modal open={file !== null} onClose={onCancel} title="Recortar portada" description="Arrastra para encuadrar. La portada es cuadrada (1:1).">
      {file ? <Editor file={file} onCancel={onCancel} onDone={onDone} /> : null}
    </Modal>
  );
}

function Editor({ file, onCancel, onDone }: { file: File; onCancel: () => void; onDone: (cropped: File) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0.5, y: 0.5 }); // 0-1: qué parte de la imagen sobrante queda a la vista

  useEffect(() => {
    let cancelled = false;
    createImageBitmap(file).then(
      (b) => !cancelled && setBitmap(b),
      () => !cancelled && setError("No se pudo leer la imagen. Usa JPG, PNG o WebP."),
    );
    return () => {
      cancelled = true;
    };
  }, [file]);

  const geometry = (side: number) => {
    if (!bitmap) return null;
    const scale = Math.max(side / bitmap.width, side / bitmap.height) * zoom;
    const w = bitmap.width * scale;
    const h = bitmap.height * scale;
    return { w, h, x: (side - w) * pan.x, y: (side - h) * pan.y };
  };

  useEffect(() => {
    const el = canvas.current;
    const g = geometry(VIEW);
    if (!el || !g || !bitmap) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = VIEW * dpr;
    el.height = VIEW * dpr;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, VIEW, VIEW);
    ctx.drawImage(bitmap, g.x, g.y, g.w, g.h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bitmap, zoom, pan]);

  const move = (dx: number, dy: number) => {
    const g = geometry(VIEW);
    if (!g) return;
    setPan((p) => ({
      x: g.w - VIEW > 1 ? Math.min(1, Math.max(0, p.x + dx / (VIEW - g.w))) : p.x,
      y: g.h - VIEW > 1 ? Math.min(1, Math.max(0, p.y + dy / (VIEW - g.h))) : p.y,
    }));
  };

  const confirm = () => {
    const g = geometry(OUTPUT);
    if (!g || !bitmap) return;
    const out = document.createElement("canvas");
    out.width = OUTPUT;
    out.height = OUTPUT;
    out.getContext("2d")?.drawImage(bitmap, g.x, g.y, g.w, g.h);
    out.toBlob(
      (blob) => {
        if (!blob) return setError("No se pudo recortar la imagen.");
        onDone(new File([blob], "portada.jpg", { type: "image/jpeg" }));
      },
      "image/jpeg",
      0.9,
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {error ? <Notice variant="error">{error}</Notice> : null}
      <canvas
        ref={canvas}
        role="img"
        aria-label="Vista previa del recorte; arrastra para mover la imagen"
        style={{ width: VIEW, height: VIEW }}
        className="mx-auto max-w-full cursor-grab touch-none rounded-card border border-line bg-tone-2 active:cursor-grabbing"
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, y: e.clientY };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          move(e.clientX - drag.current.x, e.clientY - drag.current.y);
          drag.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerUp={() => (drag.current = null)}
      />
      <label className="flex items-center gap-3 text-label text-text-2">
        Zoom
        <input type="range" min={1} max={3} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="w-full accent-[var(--text)]" />
      </label>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancelar
        </Button>
        <Button size="sm" disabled={!bitmap} onClick={confirm}>
          Usar esta portada
        </Button>
      </div>
    </div>
  );
}
