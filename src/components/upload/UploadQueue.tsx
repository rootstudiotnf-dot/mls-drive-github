"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Progress } from "@/components/ui/Progress";
import { formatBytes } from "@/lib/format";
import { UI_TYPE_LABEL } from "@/lib/storage/validate";
import type { UploadItem, UploadStatus } from "./useUploader";

export type UploadQueueProps = {
  items: UploadItem[];
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
};

const STATUS_LABEL: Record<UploadStatus, string> = {
  staged: "Pendiente",
  queued: "En cola",
  uploading: "Subiendo",
  paused: "En pausa",
  finishing: "Finalizando…",
  done: "Subido",
  error: "Error",
  canceled: "Cancelada",
};

/** Cola de subidas: progreso por archivo, pausar, reanudar, cancelar y reintentar. */
export function UploadQueue({ items, onPause, onResume, onCancel, onRetry, onDismiss }: UploadQueueProps) {
  if (items.length === 0) return null;

  return (
    <ul className="divide-y divide-line rounded-card border border-line bg-surface" aria-label="Cola de subidas">
      {items.map((item) => {
        const active = item.status === "uploading" || item.status === "queued" || item.status === "finishing";
        return (
          <li key={item.id} className="flex flex-col gap-3 p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="truncate text-body font-medium text-text" title={item.file.name}>
                  {item.file.name}
                </p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-label text-text-2">
                  {UI_TYPE_LABEL[item.type]} · {formatBytes(item.file.size)}
                  {item.resumed ? <Badge variant="outline">Reanudada</Badge> : null}
                  {item.type === "beat" ? <Badge variant="outline">Faltan datos del beat</Badge> : null}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {active ? (
                  <Button size="sm" variant="ghost" onClick={() => onPause(item.id)} disabled={item.status === "finishing"}>
                    Pausar
                  </Button>
                ) : null}
                {item.status === "paused" ? (
                  <Button size="sm" variant="ghost" onClick={() => onResume(item.id)}>
                    Reanudar
                  </Button>
                ) : null}
                {item.status === "error" ? (
                  <Button size="sm" variant="ghost" onClick={() => onRetry(item.id)}>
                    Reintentar
                  </Button>
                ) : null}
                {item.status === "done" && item.assetId ? (
                  <Link
                    href={`/archivo/${item.assetId}`}
                    className="rounded-control text-label font-medium text-text-2 transition-colors duration-150 ease-ui hover:text-text"
                  >
                    Ver ficha
                  </Link>
                ) : null}
                {item.status === "done" || item.status === "canceled" ? (
                  <Button size="sm" variant="ghost" onClick={() => onDismiss(item.id)}>
                    Quitar
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => onCancel(item.id)}>
                    Cancelar
                  </Button>
                )}
              </div>
            </div>

            {item.status === "done" || item.status === "canceled" ? (
              <p className="text-label text-text-2">{STATUS_LABEL[item.status]}</p>
            ) : (
              <>
                <Progress value={item.progress} label={`Progreso de ${item.file.name}`} />
                <p role={item.status === "error" ? "alert" : undefined} className="text-label text-text-2">
                  {item.status === "error"
                    ? (item.error ?? STATUS_LABEL.error)
                    : `${STATUS_LABEL[item.status]}${item.status === "uploading" ? ` · ${Math.round(item.progress * 100)} %` : ""}`}
                </p>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}
