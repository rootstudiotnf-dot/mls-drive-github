"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import {
  abortVaultUpload,
  completeVaultUpload,
  getVaultUrl,
  initVaultUpload,
  listVaultItems,
  listVaultParts,
  purgeVaultItem,
  restoreVaultItems,
  signVaultPart,
  signVaultSingle,
  trashVaultItems,
  type VaultItem,
  type VaultItemsPage,
} from "@/app/actions/vault";
import { BackIcon, DownloadIcon, LockIcon, TrashIcon } from "@/components/icons";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { DataList, DataRow } from "@/components/ui/DataRow";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { Select } from "@/components/ui/Select";
import { UploadDropzone } from "@/components/upload/UploadDropzone";
import { UploadQueue } from "@/components/upload/UploadQueue";
import { useUploader, type UploaderApi } from "@/components/upload/useUploader";
import { formatBytes } from "@/lib/format";
import { VaultKeepAlive } from "./VaultKeepAlive";
import { VaultMoveOutDialog } from "./VaultMoveOutDialog";
import { VaultPreviewDialog } from "./VaultPreviewDialog";

const when = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", year: "numeric", timeZone: "Atlantic/Canary" });
const KIND: Record<string, string> = { photo: "Foto", video: "Vídeo", audio: "Audio", document: "Documento", other: "Archivo" };

/** Contenido de una carpeta del Vault: lista, subida (misma cola, bucket del Vault), vista previa, descarga, papelera y sacar. */
export function VaultFolderView({ folderId, artists, maxBytes, isOwner }: { folderId: string; artists: { id: string; name: string }[]; maxBytes: number; isOwner: boolean }) {
  const [page, setPage] = useState<VaultItemsPage | null>(null);
  const [items, setItems] = useState<VaultItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [trash, setTrash] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [artistId, setArtistId] = useState("");
  const [preview, setPreview] = useState<VaultItem | null>(null);
  const [moveOut, setMoveOut] = useState<VaultItem | null>(null);
  const [purge, setPurge] = useState<VaultItem | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [pending, startTransition] = useTransition();

  const api = useMemo<UploaderApi>(
    () => ({
      initUpload: (input) => initVaultUpload({ filename: input.filename, size: input.size, folderId, artistId: input.artistId }),
      signSingleUpload: signVaultSingle,
      signPart: signVaultPart,
      listUploadedParts: listVaultParts,
      completeUpload: completeVaultUpload,
      abortUpload: abortVaultUpload,
    }),
    [folderId],
  );
  const uploader = useUploader({ maxBytes, api, defaultFolderId: folderId, defaultArtistId: artistId || null, derivatives: false });

  const apply = useCallback((res: Awaited<ReturnType<typeof listVaultItems>>, reset: boolean) => {
    setLoading(false);
    if (!res.ok || !res.data) {
      setFailed(true);
      return;
    }
    const data = res.data;
    setFailed(false);
    setPage(data);
    setItems((current) => (reset ? data.items : [...current, ...data.items]));
    setCursor(data.nextCursor);
  }, []);

  // Carga (y recarga al cambiar de vista, tras una acción o cuando termina una subida)
  const finished = uploader.items.filter((i) => i.status === "done").length;
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void listVaultItems({ folderId, cursor: null, trash }).then((res) => {
      if (!cancelled) apply(res, true);
    });
    return () => {
      cancelled = true;
    };
  }, [folderId, trash, reloadKey, finished, apply]);

  const loadMore = () => {
    setLoading(true);
    void listVaultItems({ folderId, cursor, trash }).then((res) => apply(res, false));
  };

  const download = async (item: VaultItem) => {
    const res = await getVaultUrl({ assetId: item.id, mode: "download" });
    if (!res.ok || !res.data) return setMessage({ kind: "error", text: res.ok ? "No se pudo descargar." : res.message });
    const a = document.createElement("a");
    a.href = res.data.url;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const act = (fn: () => Promise<{ ok: boolean; message?: string }>) =>
    startTransition(async () => {
      const res = await fn();
      setMessage({ kind: res.ok ? "success" : "error", text: res.message ?? (res.ok ? "Hecho." : "No se pudo completar la acción.") });
      if (res.ok) setReloadKey((n) => n + 1);
    });

  const queue = uploader.items.filter((i) => i.status !== "staged");
  const invalid = uploader.items.filter((i) => i.status === "staged" && i.invalidReason);

  if (failed && !page) {
    return (
      <div className="flex flex-col gap-6">
        <VaultKeepAlive />
        <Link href="/vault" className="inline-flex items-center gap-1.5 self-start text-label text-text-2 hover:text-text">
          <BackIcon size={16} /> Vault
        </Link>
        <EmptyState icon={<LockIcon size={22} />} title="No se puede abrir esta carpeta" description="No existe, no tienes acceso o el Vault se ha bloqueado. Vuelve al Vault para continuar." />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <VaultKeepAlive />
      <Link href="/vault" className="inline-flex items-center gap-1.5 self-start rounded-control text-label text-text-2 transition-colors duration-150 ease-ui hover:text-text">
        <BackIcon size={16} /> Vault
      </Link>
      <PageHeader
        title={page?.folder.name ?? "Carpeta"}
        description={trash ? "Papelera de la carpeta: se conserva 30 días." : "Todo lo que se abre, se descarga o se sube aquí queda registrado."}
        actions={
          page?.can.delete ? (
            <Button variant="ghost" size="sm" onClick={() => {
                setLoading(true);
                setTrash(!trash);
              }}>
              {trash ? "Volver a la carpeta" : "Papelera"}
            </Button>
          ) : null
        }
      />
      {message ? <Notice variant={message.kind}>{message.text}</Notice> : null}

      {!trash && page?.can.upload ? (
        <section className="flex flex-col gap-4" aria-label="Subir al Vault">
          {artists.length > 0 ? (
            <div className="w-64 max-w-full">
              <Select label="Relacionado con (opcional, informativo)" value={artistId} onChange={(e) => setArtistId(e.target.value)} options={[{ value: "", label: "Ninguno" }, ...artists.map((a) => ({ value: a.id, label: a.name }))]} />
            </div>
          ) : null}
          <UploadDropzone
            onFiles={(files) => {
              uploader.stage(files);
              uploader.start();
            }}
            hint={`Se envía directamente al bucket del Vault. Hasta ${formatBytes(maxBytes)} por archivo. No se generan miniaturas.`}
            className={queue.length > 0 ? "py-8" : undefined}
          />
          {invalid.length > 0 ? (
            <Notice variant="error">
              <ul>
                {invalid.map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-3">
                    <span className="truncate">{i.file.name}: {i.invalidReason}</span>
                    <Button size="sm" variant="ghost" onClick={() => uploader.remove(i.id)}>Quitar</Button>
                  </li>
                ))}
              </ul>
            </Notice>
          ) : null}
          {queue.length > 0 ? (
            <UploadQueue items={queue} onPause={uploader.pause} onResume={uploader.resume} onCancel={(id) => void uploader.cancel(id)} onRetry={uploader.retry} onDismiss={uploader.remove} />
          ) : null}
        </section>
      ) : null}

      {loading && items.length === 0 ? (
        <p className="text-label text-text-2" role="status">Cargando…</p>
      ) : items.length === 0 ? (
        <EmptyState icon={<LockIcon size={22} />} title={trash ? "La papelera está vacía" : "Esta carpeta está vacía"} description={trash ? "Lo que borres aquí se conserva 30 días." : "Sube archivos o muévelos al Vault desde el espacio del artista."} />
      ) : (
        <DataList>
          {items.map((item) => (
            <DataRow
              key={item.id}
              title={item.name}
              subtitle={[KIND[item.kind] ?? "Archivo", formatBytes(item.sizeBytes), item.artistName ? `Relacionado con ${item.artistName}` : null, item.uploaderName ? `Subido por ${item.uploaderName}` : null, when.format(new Date(item.createdAt))].filter(Boolean).join(" · ")}
              trailing={
                trash ? (
                  <>
                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(() => restoreVaultItems([item.id]))}>Restaurar</Button>
                    {isOwner ? <Button size="sm" variant="ghost" disabled={pending} onClick={() => { setPurge(item); setConfirmText(""); }}>Eliminar definitivamente</Button> : null}
                  </>
                ) : (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setPreview(item)}>Ver</Button>
                    {page?.can.download ? <Button size="icon" variant="ghost" aria-label={`Descargar ${item.name}`} onClick={() => void download(item)}><DownloadIcon size={16} /></Button> : null}
                    {page?.can.edit ? <Button size="sm" variant="ghost" onClick={() => setMoveOut(item)}>Sacar del Vault</Button> : null}
                    {page?.can.delete ? <Button size="icon" variant="ghost" aria-label={`Enviar ${item.name} a la papelera`} disabled={pending} onClick={() => act(() => trashVaultItems([item.id]))}><TrashIcon size={16} /></Button> : null}
                  </>
                )
              }
            />
          ))}
        </DataList>
      )}
      {cursor ? (
        <div className="flex justify-center">
          <Button variant="ghost" size="sm" disabled={loading} onClick={loadMore}>Cargar más</Button>
        </div>
      ) : null}
      {page ? <Badge variant="outline" className="self-start">{page.can.download ? "Puedes descargar" : "Sin descarga"}</Badge> : null}

      <VaultPreviewDialog item={preview} onClose={() => setPreview(null)} />
      <VaultMoveOutDialog item={moveOut} onClose={() => setMoveOut(null)} onDone={() => { setMoveOut(null); setReloadKey((n) => n + 1); }} />
      <Modal open={purge !== null} onClose={() => setPurge(null)} title="Eliminar definitivamente" description={purge ? `«${purge.name}» se borrará del Vault y no se podrá recuperar.` : undefined}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!purge) return;
            const target = purge;
            setPurge(null);
            act(() => purgeVaultItem({ assetId: target.id, confirm: confirmText }));
          }}
        >
          <Input label="Escribe ELIMINAR para confirmar" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setPurge(null)}>Cancelar</Button>
            <Button type="submit" size="sm" disabled={confirmText !== "ELIMINAR"}>Eliminar</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
