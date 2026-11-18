"use client";

import { useEffect, useState } from "react";
import { getVaultUrl, type VaultItem } from "@/app/actions/vault";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";

/**
 * Vista previa con URLs de 2 minutos: fotos, vídeo y audio nativos. La URL se pide al abrir y se vuelve a pedir si
 * caduca (el servidor registra cada petición). Otros formatos no tienen vista previa: se descargan.
 */
export function VaultPreviewDialog({ item, onClose }: { item: VaultItem | null; onClose: () => void }) {
  return (
    <Modal open={item !== null} onClose={onClose} title={item?.name ?? "Vista previa"} className="max-w-3xl">
      {item ? <Preview key={item.id} item={item} /> : null}
    </Modal>
  );
}

function Preview({ item }: { item: VaultItem }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const previewable = item.kind === "photo" || item.kind === "video" || item.kind === "audio";

  useEffect(() => {
    if (!previewable) return;
    let cancelled = false;
    void getVaultUrl({ assetId: item.id, mode: "view" }).then((res) => {
      if (cancelled) return;
      if (res.ok && res.data) {
        setUrl(res.data.url);
        setError(null);
      } else setError(res.ok ? "No se pudo cargar." : res.message);
    });
    return () => {
      cancelled = true;
    };
  }, [item.id, previewable, round]);

  if (!previewable) return <Notice variant="info">Este formato no tiene vista previa. Descárgalo desde la lista.</Notice>;
  if (error) return <Notice variant="error">{error}</Notice>;
  if (!url) return <p className="text-label text-text-2" role="status">Cargando…</p>;
  const renew = () => {
    setUrl(null);
    setRound((n) => n + 1);
  };
  return (
    <div className="flex flex-col gap-3">
      {item.kind === "photo" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={item.name} onError={renew} className="max-h-[70vh] w-full rounded-card object-contain" />
      ) : item.kind === "video" ? (
        <video src={url} controls onError={renew} className="max-h-[70vh] w-full rounded-card bg-bg" />
      ) : (
        <audio src={url} controls onError={renew} className="w-full" />
      )}
      <div className="flex items-center justify-between gap-3">
        <p className="text-caption text-text-3">El enlace dura 2 minutos. Si se corta, se renueva.</p>
        <Button size="sm" variant="ghost" onClick={renew}>Renovar</Button>
      </div>
    </div>
  );
}
