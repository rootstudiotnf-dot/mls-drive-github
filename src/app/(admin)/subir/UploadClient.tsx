"use client";

import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { ClassifyTable, type FolderOption } from "@/components/upload/ClassifyTable";
import { UploadDropzone } from "@/components/upload/UploadDropzone";
import { UploadQueue } from "@/components/upload/UploadQueue";
import { useUploader } from "@/components/upload/useUploader";
import { formatBytes } from "@/lib/format";
import type { UiType } from "@/lib/storage/validate";

export type UploadClientProps = {
  artists: { id: string; name: string }[];
  folders: FolderOption[];
  allowedTypes: Record<UiType, boolean>;
  publishableTypes: Record<UiType, boolean>;
  canUploadWithoutArtist: boolean;
  maxBytes: number;
  /** Artista elegido de antemano (llegando desde su espacio). */
  preselectArtistId?: string | null;
  /** Sesión de destino: artista y sesión van fijados y la categoría «Foto» queda preseleccionada. */
  session?: { id: string; name: string } | null;
};

export function UploadClient({
  artists,
  folders,
  allowedTypes,
  publishableTypes,
  canUploadWithoutArtist,
  maxBytes,
  preselectArtistId = null,
  session = null,
}: UploadClientProps) {
  const uploader = useUploader({
    maxBytes,
    defaultArtistId:
      preselectArtistId && artists.some((a) => a.id === preselectArtistId)
        ? preselectArtistId
        : artists.length === 1
          ? (artists[0]?.id ?? null)
          : null,
    sessionId: session?.id ?? null,
    defaultType: session ? "photo" : null,
  });

  const staged = uploader.items.filter((i) => i.status === "staged");
  const queue = uploader.items.filter((i) => i.status !== "staged");
  const startable = staged.filter((i) => !i.invalidReason);
  const incomplete = startable.filter(
    (i) =>
      !allowedTypes[i.type] ||
      (i.artistId === null && !(i.type === "beat" && canUploadWithoutArtist)),
  );
  const canStart = startable.length > 0 && incomplete.length === 0;

  return (
    <div className="flex flex-col gap-8">
      {session ? (
        <Notice variant="info">
          Subiendo a la sesión <span className="font-medium text-text">{session.name}</span>. Las fotos se procesan en tu
          navegador (miniatura y versión web) mientras se suben.
        </Notice>
      ) : null}
      {uploader.pending.length > 0 ? (
        <Notice variant="info">
          <p className="font-medium text-text">Hay subidas sin terminar</p>
          <p className="mt-1">
            Vuelve a elegir el mismo archivo para reanudarlas desde donde se quedaron (solo se envían las partes
            que faltan).
          </p>
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
        onFiles={uploader.stage}
        hint={`Fotos (incluye RAW y HEIC), vídeo, audio (beats) y documentos. Hasta ${formatBytes(maxBytes)} por archivo. Los archivos se envían directamente al almacenamiento seguro.`}
        className={staged.length + queue.length > 0 ? "py-8" : undefined}
      />

      {staged.length > 0 ? (
        <section>
          <SectionHeader
            title={`Clasificar (${staged.length})`}
            action={
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => staged.forEach((i) => uploader.remove(i.id))}
                >
                  Quitar todo
                </Button>
                <Button size="sm" disabled={!canStart} onClick={uploader.start}>
                  Subir {startable.length === 1 ? "1 archivo" : `${startable.length} archivos`}
                </Button>
              </div>
            }
          />
          {incomplete.length > 0 ? (
            <Notice variant="info" className="mb-4">
              Elige un artista (y un tipo permitido) para cada archivo antes de subir.
            </Notice>
          ) : null}
          <ClassifyTable
            items={staged}
            artists={artists}
            folders={folders}
            allowedTypes={allowedTypes}
            publishableTypes={publishableTypes}
            canUploadWithoutArtist={canUploadWithoutArtist}
            onChange={uploader.update}
            onApplyAll={uploader.updateAll}
            onRemove={uploader.remove}
          />
          <p className="mt-3 text-caption text-text-3">
            Lo que subes queda «Solo yo» hasta que alguien con permiso de publicar lo publique.
          </p>
        </section>
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
    </div>
  );
}
