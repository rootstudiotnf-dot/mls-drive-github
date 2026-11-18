"use client";

import { useRef, useState } from "react";
import { UploadIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

export type UploadDropzoneProps = {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  /** Texto de ayuda bajo el botón (formatos y tamaño máximo). */
  hint?: string;
  className?: string;
};

/** Zona de arrastre + selector de archivos. Teclado: el botón «Elegir archivos» abre el selector. */
export function UploadDropzone({ onFiles, disabled, hint, className }: UploadDropzoneProps) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        if (disabled) return;
        const files = Array.from(event.dataTransfer.files);
        if (files.length > 0) onFiles(files);
      }}
      className={cn(
        "flex flex-col items-center justify-center rounded-block border border-dashed px-6 py-14 text-center",
        "transition-colors duration-150 ease-ui",
        over ? "border-text bg-active" : "border-line-hover bg-surface",
        disabled && "opacity-50",
        className,
      )}
    >
      <span className="mb-5 flex size-12 items-center justify-center rounded-pill bg-tone-3 text-text-2">
        <UploadIcon size={22} />
      </span>
      <p className="text-heading text-text">Suelta tus archivos aquí</p>
      <p className="mt-1 text-body text-text-2">o elígelos desde tu equipo</p>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-label="Elegir archivos"
        disabled={disabled}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length > 0) onFiles(files);
          event.target.value = ""; // permite volver a elegir el mismo archivo
        }}
      />
      <Button className="mt-6" disabled={disabled} onClick={() => inputRef.current?.click()}>
        Elegir archivos
      </Button>
      {hint ? <p className="mt-4 max-w-md text-caption text-text-3">{hint}</p> : null}
    </div>
  );
}
