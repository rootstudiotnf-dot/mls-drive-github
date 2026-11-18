"use client";

import { useEffect, useRef, useState } from "react";
import type { VaultItem } from "@/app/actions/vault";
import { beginMoveOutOfVault, getMoveOutTargets, type OutTarget } from "@/app/actions/vault-move";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import { Progress } from "@/components/ui/Progress";
import { Select } from "@/components/ui/Select";
import { moveAsset } from "./moveClient";

/**
 * «Sacar del Vault»: exige permiso de edición en el Vault Y en el destino. Por defecto devuelve el archivo a su
 * artista y carpeta de origen; el destino se puede cambiar. Vuelve como PRIVADO (hay que publicarlo de nuevo).
 */
export function VaultMoveOutDialog({ item, onClose, onDone }: { item: VaultItem | null; onClose: () => void; onDone: () => void }) {
  return (
    <Modal open={item !== null} onClose={onClose} title="Sacar del Vault" description={item ? `«${item.name}» volverá al espacio normal como privado.` : undefined}>
      {item ? <Body key={item.id} item={item} onClose={onClose} onDone={onDone} /> : null}
    </Modal>
  );
}

function Body({ item, onClose, onDone }: { item: VaultItem; onClose: () => void; onDone: () => void }) {
  const [targets, setTargets] = useState<OutTarget | null>(null);
  const [artistId, setArtistId] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getMoveOutTargets(item.id).then((res) => {
      if (cancelled) return;
      if (res.ok && res.data) {
        setTargets(res.data);
        const origin = res.data.origin.artistId;
        setArtistId(origin && res.data.artists.some((a) => a.id === origin) ? origin : (res.data.artists[0]?.id ?? ""));
      } else setError("No tienes permiso para sacar este archivo.");
    });
    return () => {
      cancelled = true;
    };
  }, [item.id]);

  const run = async () => {
    setError(null);
    setProgress(0);
    const abort = new AbortController();
    controller.current = abort;
    const folderId = targets && artistId === targets.origin.artistId ? targets.origin.folderId : null;
    const begin = await beginMoveOutOfVault({ assetId: item.id, artistId, folderId });
    if (!begin.ok || !begin.data) {
      setProgress(null);
      return setError(begin.ok ? "No se pudo empezar." : begin.message);
    }
    const result = await moveAsset(begin.data, abort.signal, setProgress);
    controller.current = null;
    if (result.ok) onDone();
    else {
      setProgress(null);
      setError(result.message);
    }
  };

  const busy = progress !== null;
  return (
    <div className="flex flex-col gap-4">
      {targets && targets.artists.length > 0 ? (
        <Select label="Destino (artista)" value={artistId} disabled={busy} onChange={(e) => setArtistId(e.target.value)} options={targets.artists.map((a) => ({ value: a.id, label: a.name }))} />
      ) : targets ? (
        <Notice variant="error">No tienes permiso de edición sobre ningún artista de destino.</Notice>
      ) : null}
      {targets?.origin.folderId && artistId === targets.origin.artistId ? <p className="text-caption text-text-3">Volverá a su carpeta de origen.</p> : null}
      {busy ? <Progress value={progress} label="Copiando al espacio normal" /> : null}
      {error ? <Notice variant="error">{error}</Notice> : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => (busy ? controller.current?.abort() : onClose())}>
          Cancelar
        </Button>
        <Button size="sm" disabled={busy || !artistId} onClick={() => void run()}>
          Sacar del Vault
        </Button>
      </div>
    </div>
  );
}
