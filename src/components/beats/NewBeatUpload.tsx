"use client";

import { useEffect, useRef, useState } from "react";
import { findBeatForAsset } from "@/app/actions/beats";
import { Button } from "@/components/ui/Button";
import { ButtonLink } from "@/components/ui/ButtonLink";
import { Notice } from "@/components/ui/Notice";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { UploadDropzone } from "@/components/upload/UploadDropzone";
import { UploadQueue } from "@/components/upload/UploadQueue";
import { useUploader } from "@/components/upload/useUploader";
import { suggestFromFilename } from "@/lib/beats/types";
import { formatBytes } from "@/lib/format";

const AUDIO = /\.(wav|mp3|flac|aiff?|m4a)$/i;

type Draft = { id: string; title: string; bpm: number | null; key: string | null };

/**
 * Subida de beats: se suelta el audio (WAV, MP3, FLAC, AIFF o M4A) y la subida empieza sola, directamente a R2.
 * Al terminar, el servidor crea un BORRADOR con las sugerencias sacadas del nombre del archivo (`Nombre_140_Am.wav`);
 * son solo sugerencias editables, no se analiza el audio.
 */
export function NewBeatUpload({ maxBytes }: { maxBytes: number }) {
  const uploader = useUploader({ maxBytes, defaultType: "beat" });
  const [rejected, setRejected] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const looked = useRef(new Set<string>());

  const onFiles = (files: File[]) => {
    const good = files.filter((f) => AUDIO.test(f.name));
    setRejected(files.filter((f) => !AUDIO.test(f.name)).map((f) => f.name));
    if (good.length > 0) {
      uploader.stage(good);
      uploader.start();
    }
  };

  // Cuando una subida termina, se busca el borrador que creó el servidor
  useEffect(() => {
    for (const item of uploader.items) {
      if (item.status !== "done" || !item.assetId || looked.current.has(item.assetId)) continue;
      const assetId = item.assetId;
      looked.current.add(assetId);
      void findBeatForAsset(assetId).then((res) => {
        if (res.ok && res.data) setDrafts((d) => ({ ...d, [assetId]: res.data as Draft }));
      });
    }
  }, [uploader.items]);

  const invalid = uploader.items.filter((i) => i.status === "staged" && i.invalidReason);
  const queue = uploader.items.filter((i) => i.status !== "staged");
  const finished = uploader.items.filter((i) => i.status === "done" && i.assetId && drafts[i.assetId]);

  return (
    <div className="flex flex-col gap-8">
      {uploader.pending.length > 0 ? (
        <Notice variant="info">
          <p className="font-medium text-text">Hay subidas sin terminar</p>
          <p className="mt-1">Vuelve a elegir el mismo archivo para reanudarlas desde donde se quedaron.</p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {uploader.pending.map(({ fp, value }) => (
              <li key={fp} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate">
                  {value.name} · {formatBytes(value.size)}
                </span>
                <Button size="sm" variant="ghost" onClick={() => void uploader.discardPending(fp)}>
                  Descartar
                </Button>
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <UploadDropzone
        onFiles={onFiles}
        hint={`Audio WAV, MP3, FLAC, AIFF o M4A, hasta ${formatBytes(maxBytes)} por archivo. Si el nombre es «Nombre_140_Am.wav» se sugieren el título, el BPM y la tonalidad.`}
        className={queue.length > 0 ? "py-8" : undefined}
      />

      {rejected.length > 0 ? (
        <Notice variant="error">
          Solo se admite audio. Se ignoró: {rejected.slice(0, 5).join(", ")}
          {rejected.length > 5 ? ` y ${rejected.length - 5} más` : ""}.
        </Notice>
      ) : null}
      {invalid.length > 0 ? (
        <Notice variant="error">
          <ul className="flex flex-col gap-1">
            {invalid.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate">
                  {i.file.name}: {i.invalidReason}
                </span>
                <Button size="sm" variant="ghost" onClick={() => uploader.remove(i.id)}>
                  Quitar
                </Button>
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {queue.length > 0 ? (
        <section>
          <SectionHeader title="Subidas" />
          <UploadQueue
            items={queue}
            onPause={uploader.pause}
            onResume={uploader.resume}
            onCancel={(id) => void uploader.cancel(id)}
            onRetry={uploader.retry}
            onDismiss={uploader.remove}
          />
        </section>
      ) : null}

      {finished.length > 0 ? (
        <section>
          <SectionHeader title="Borradores creados" />
          <ul className="flex flex-col gap-2">
            {finished.map((item) => {
              const draft = drafts[item.assetId as string] as Draft;
              const suggestion = suggestFromFilename(item.file.name);
              return (
                <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-body font-medium text-text">{draft.title}</p>
                    <p className="truncate text-label text-text-2">
                      {[draft.bpm ? `${draft.bpm} BPM` : "Sin BPM", draft.key ?? "Sin tonalidad"].join(" · ")}
                      {suggestion.bpm || suggestion.key ? " (sugerido por el nombre del archivo)" : ""}
                    </p>
                  </div>
                  <ButtonLink href={`/beats/${draft.id}`} size="sm">
                    Completar datos
                  </ButtonLink>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-caption text-text-3">
            El preview se genera en segundo plano; para publicar hacen falta título, BPM, tonalidad, género y el preview listo.
          </p>
        </section>
      ) : null}
    </div>
  );
}
