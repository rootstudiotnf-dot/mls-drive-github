"use client";

import { VaultMoveDialog } from "@/components/vault/VaultMoveDialog";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { getAssetUrl } from "@/app/actions/uploads";
import { moveAsset, trashAsset, updateAsset } from "@/app/actions/assets";
import { BackIcon, DownloadIcon } from "@/components/icons";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import { Select } from "@/components/ui/Select";
import { Toggle } from "@/components/ui/Toggle";
import { formatBytes } from "@/lib/format";
import { UI_TYPE_LABEL, CLASS_TO_UI, type UploadClass } from "@/lib/storage/validate";
import { VideoReview } from "@/components/video/VideoReview";
import type { VideoState } from "@/lib/video/jobs-types";
import { MediaPreview } from "./MediaPreview";

export type AssetDetailProps = {
  asset: {
    id: string;
    kind: UploadClass | "other";
    title: string;
    filename: string;
    ext: string;
    sizeBytes: number;
    width: number | null;
    height: number | null;
    durationSeconds: number | null;
    status: string;
    visibility: "private" | "published";
    downloadable: boolean;
    artistId: string | null;
    folderId: string | null;
    vault: boolean;
    createdAt: string;
  };
  artistName: string | null;
  folderName: string | null;
  uploaderName: string | null;
  tags: string[];
  permissions: { edit: boolean; publish: boolean; download: boolean };
  /** Cosmética: se ofrece «Mover al Vault». */
  canVault?: boolean;
  artists: { id: string; name: string }[];
  folders: { id: string; artistId: string; name: string; kind: string }[];
  /** Solo vídeos listos: estado de procesado y fotogramas por segundo (para el reproductor). */
  video?: { state: VideoState; fps: number | null };
};

const FOLDER_KIND_FOR: Record<string, string> = { photo: "photos", video: "videos", audio: "files", document: "files", other: "files" };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5 text-body">
      <dt className="text-text-2">{label}</dt>
      <dd className="min-w-0 truncate text-right text-text">{children}</dd>
    </div>
  );
}

export function AssetDetail({ asset, artistName, folderName, uploaderName, tags, permissions, canVault = false, artists, folders, video }: AssetDetailProps) {
  const router = useRouter();
  const [title, setTitle] = useState(asset.title);
  const [tagText, setTagText] = useState(tags.join(", "));
  const [visibility, setVisibility] = useState(asset.visibility);
  const [downloadable, setDownloadable] = useState(asset.downloadable);
  const [artistId, setArtistId] = useState(asset.artistId ?? "");
  const [folderId, setFolderId] = useState(asset.folderId ?? "");
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const [confirmTrash, setConfirmTrash] = useState(false);
  const [vaulting, setVaulting] = useState(false);
  const [pending, startTransition] = useTransition();

  const typeLabel = asset.kind === "other" ? "Archivo" : UI_TYPE_LABEL[CLASS_TO_UI[asset.kind]];
  const edit = permissions.edit && asset.status === "ready";

  const dirty =
    title !== asset.title ||
    tagText.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean).sort().join(",") !== tags.join(",") ||
    visibility !== asset.visibility ||
    downloadable !== asset.downloadable;
  const moved = artistId !== (asset.artistId ?? "") || folderId !== (asset.folderId ?? "");

  const folderOptions = folders.filter(
    (f) => f.artistId === artistId && (f.kind === "general" || f.kind === FOLDER_KIND_FOR[asset.kind]),
  );

  const run = (fn: () => Promise<{ ok: boolean; message?: string }>, after?: () => void) =>
    startTransition(async () => {
      const result = await fn();
      setNotice({ ok: result.ok, message: result.message ?? (result.ok ? "Hecho." : "No se pudo completar la acción.") });
      if (result.ok) {
        after?.();
        router.refresh();
      }
    });

  const download = () =>
    startTransition(async () => {
      const res = await getAssetUrl(asset.id, "original", "download");
      if (res.ok && res.data) window.location.assign(res.data.url); // Content-Disposition: attachment
      else setNotice({ ok: false, message: res.ok ? "No se pudo descargar." : res.message });
    });

  return (
    <div className="flex flex-col gap-8">
      <div>
        <Link
          href="/"
          className="mb-4 inline-flex items-center gap-1.5 rounded-control text-label font-medium text-text-2 transition-colors duration-150 ease-ui hover:text-text"
        >
          <BackIcon size={16} />
          Volver
        </Link>
        <h1 className="text-title text-text">{asset.title}</h1>
        <p className="mt-2 flex flex-wrap items-center gap-2 text-body text-text-2">
          {typeLabel}
          <Badge variant={asset.visibility === "published" ? "neutral" : "outline"}>
            {asset.visibility === "published" ? "Visible para el artista" : "Solo yo y el equipo"}
          </Badge>
          {asset.vault ? <Badge variant="outline">Vault</Badge> : null}
        </p>
      </div>

      {video ? (
        <VideoReview
          assetId={asset.id}
          title={asset.title}
          initialState={video.state}
          fps={video.fps}
          canOriginal={permissions.download || permissions.edit}
          canReprocess={permissions.publish}
        />
      ) : null}

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0">
          {video ? null : asset.status === "ready" ? (
            <MediaPreview
              assetId={asset.id}
              kind={asset.kind}
              ext={asset.ext}
              title={asset.title}
            />
          ) : (
            <Notice variant="info">Este archivo aún se está subiendo.</Notice>
          )}
          {permissions.download ? (
            <Button className="mt-4" variant="ghost" size="sm" onClick={download} disabled={pending}>
              <DownloadIcon size={16} />
              Descargar original
            </Button>
          ) : null}
        </div>

        <aside className="flex flex-col gap-6" aria-label="Detalles del archivo">
          {notice ? (
            <div aria-live="polite">
              <Notice variant={notice.ok ? "success" : "error"}>{notice.message}</Notice>
            </div>
          ) : null}
          {!edit ? (
            <Notice variant="info">Solo puedes ver este archivo: no tienes permiso para editarlo.</Notice>
          ) : null}

          <Input label="Nombre" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} disabled={!edit} />
          <Input
            label="Etiquetas"
            value={tagText}
            onChange={(e) => setTagText(e.target.value)}
            hint="Separadas por comas (máximo 10)."
            disabled={!edit}
          />

          <div className="rounded-card border border-line bg-surface">
            <div className="divide-y divide-line">
              <div className="flex items-center justify-between gap-4 px-4 py-3.5">
                <div className="min-w-0">
                  <p className="text-body font-medium text-text">Visible para el artista</p>
                  <p className="text-label text-text-2">
                    {permissions.publish ? "Publicado = lo ven quienes tienen acceso." : "Publicar requiere permiso de publicación."}
                  </p>
                </div>
                <Toggle
                  label="Visible para el artista"
                  checked={visibility === "published"}
                  onChange={(on) => setVisibility(on ? "published" : "private")}
                  disabled={!edit || !permissions.publish}
                />
              </div>
              <div className="flex items-center justify-between gap-4 px-4 py-3.5">
                <div className="min-w-0">
                  <p className="text-body font-medium text-text">Permitir descarga</p>
                  <p className="text-label text-text-2">Si está desactivado, nadie puede descargar el original.</p>
                </div>
                <Toggle label="Permitir descarga" checked={downloadable} onChange={setDownloadable} disabled={!edit} />
              </div>
            </div>
          </div>

          <Button
            disabled={!edit || !dirty || pending}
            onClick={() =>
              run(() =>
                updateAsset(asset.id, {
                  title,
                  tags: tagText.split(",").map((t) => t.trim()).filter(Boolean),
                  visibility,
                  downloadable,
                }),
              )
            }
          >
            {pending ? "Guardando…" : "Guardar cambios"}
          </Button>

          {edit ? (
            <div className="rounded-card border border-line bg-surface p-4">
              <h2 className="mb-3 text-body font-medium text-text">Mover</h2>
              <div className="flex flex-col gap-3">
                <Select
                  label="Artista"
                  value={artistId}
                  options={[
                    { value: "", label: asset.kind === "audio" ? "Sin artista (biblioteca)" : "Elige un artista…" },
                    ...artists.map((a) => ({ value: a.id, label: a.name })),
                  ]}
                  onChange={(e) => {
                    setArtistId(e.target.value);
                    setFolderId("");
                  }}
                />
                <Select
                  label="Categoría / carpeta"
                  value={folderId}
                  options={[{ value: "", label: "Sin carpeta" }, ...folderOptions.map((f) => ({ value: f.id, label: f.name }))]}
                  onChange={(e) => setFolderId(e.target.value)}
                  disabled={!artistId}
                />
                <Button
                  variant="ghost"
                  disabled={!moved || pending || (!artistId && asset.kind !== "audio")}
                  onClick={() => run(() => moveAsset(asset.id, { artistId: artistId || null, folderId: folderId || null }))}
                >
                  Mover archivo
                </Button>
                <p className="text-caption text-text-3">Mover solo cambia la organización: el archivo no se vuelve a subir.</p>
              </div>
            </div>
          ) : null}

          <dl className="divide-y divide-line rounded-card border border-line bg-surface px-4">
            <Row label="Archivo">{asset.filename}</Row>
            <Row label="Tipo">{typeLabel}</Row>
            <Row label="Tamaño">{formatBytes(asset.sizeBytes)}</Row>
            {asset.width && asset.height ? <Row label="Dimensiones">{`${asset.width} × ${asset.height}`}</Row> : null}
            <Row label="Artista">{artistName ?? "—"}</Row>
            <Row label="Carpeta">{folderName ?? "—"}</Row>
            <Row label="Subido por">{uploaderName ?? "—"}</Row>
            <Row label="Fecha">
              {new Intl.DateTimeFormat("es-ES", { dateStyle: "medium", timeStyle: "short", timeZone: "Atlantic/Canary" }).format(
                new Date(asset.createdAt),
              )}
            </Row>
          </dl>

          {edit && canVault ? (
            <Button variant="ghost" onClick={() => setVaulting(true)} disabled={pending}>
              Mover al Vault…
            </Button>
          ) : null}
          {edit ? (
            <Button variant="ghost" onClick={() => setConfirmTrash(true)} disabled={pending}>
              Enviar a la papelera
            </Button>
          ) : null}
        </aside>
      </div>

      {canVault ? (
        <VaultMoveDialog open={vaulting} items={[{ id: asset.id, name: asset.title }]} onClose={() => setVaulting(false)} onDone={() => router.push("/vault")} />
      ) : null}
      <Modal
        open={confirmTrash}
        onClose={() => setConfirmTrash(false)}
        title="Enviar a la papelera"
        description="El archivo dejará de ser visible para todos. Se eliminará definitivamente pasados 30 días."
      >
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmTrash(false)}>
            Cancelar
          </Button>
          <Button
            disabled={pending}
            onClick={() => {
              setConfirmTrash(false);
              run(
                () => trashAsset(asset.id),
                () => router.push("/"),
              );
            }}
          >
            Enviar a la papelera
          </Button>
        </div>
      </Modal>
    </div>
  );
}
