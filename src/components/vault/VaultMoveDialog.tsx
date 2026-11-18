"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { beginMoveIntoVault, listMoveTargets, type MoveTarget } from "@/app/actions/vault-move";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import { Progress } from "@/components/ui/Progress";
import { Select } from "@/components/ui/Select";
import { moveAsset } from "./moveClient";

type Row = { id: string; name: string; state: "waiting" | "moving" | "done" | "error"; progress: number; message?: string };

/**
 * «Mover al Vault» (espacio del artista, sesiones y ficha del archivo). Pide confirmación explícita: el archivo se
 * copia al bucket del Vault, se verifica y SOLO entonces se borra el original; al terminar deja de verse al instante
 * en todas las demás vistas y para todos los demás usuarios.
 */
export function VaultMoveDialog({ items, open, onClose, onDone }: { items: { id: string; name: string }[]; open: boolean; onClose: () => void; onDone: () => void }) {
  const [targets, setTargets] = useState<MoveTarget[] | null>(null);
  const [folderId, setFolderId] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void listMoveTargets().then((res) => {
      if (cancelled) return;
      if (res.ok && res.data) {
        setTargets(res.data);
        setFolderId(res.data[0]?.id ?? "");
        setError(res.data.length === 0 ? "No tienes acceso de subida a ninguna carpeta del Vault." : null);
      } else {
        setTargets([]);
        setError("No se puede mover al Vault ahora. Comprueba que tienes acceso y que lo has desbloqueado.");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const patch = (id: string, changes: Partial<Row>) => setRows((current) => current.map((r) => (r.id === id ? { ...r, ...changes } : r)));

  const run = async () => {
    setBusy(true);
    setError(null);
    const abort = new AbortController();
    controller.current = abort;
    setRows(items.map((i) => ({ id: i.id, name: i.name, state: "waiting", progress: 0 })));
    let failures = 0;
    for (const item of items) {
      patch(item.id, { state: "moving" });
      const begin = await beginMoveIntoVault({ assetId: item.id, folderId });
      if (!begin.ok || !begin.data) {
        failures++;
        patch(item.id, { state: "error", message: begin.ok ? "No se pudo empezar." : begin.message });
        continue;
      }
      const result = await moveAsset(begin.data, abort.signal, (f) => patch(item.id, { progress: f }));
      if (result.ok) patch(item.id, { state: "done", progress: 1 });
      else {
        failures++;
        patch(item.id, { state: "error", message: result.message });
      }
    }
    setBusy(false);
    controller.current = null;
    if (failures < items.length) onDone();
  };

  const finished = rows.length > 0 && !busy;

  return (
    <Modal open={open} onClose={() => (busy ? undefined : onClose())} title="Mover al Vault" description={`${items.length === 1 ? "Este archivo" : `Estos ${items.length} archivos`} dejará${items.length === 1 ? "" : "n"} de verse al instante en el espacio normal, en las búsquedas y en los contadores.`}>
      <div className="flex flex-col gap-4">
        {rows.length === 0 ? (
          <>
            <Notice variant="info">
              Se copia al bucket del Vault, se comprueba la copia y solo después se borra el original (y sus miniaturas y versiones).
              Si algo falla, no se pierde nada y no cambia la visibilidad.
            </Notice>
            {targets && targets.length > 0 ? <Select label="Carpeta del Vault" value={folderId} onChange={(e) => setFolderId(e.target.value)} options={targets.map((t) => ({ value: t.id, label: t.name }))} /> : null}
            {error ? (
              <Notice variant="error">
                {error} <Link href="/vault" className="underline">Abrir el Vault</Link>
              </Notice>
            ) : null}
          </>
        ) : (
          <ul className="flex flex-col gap-3" aria-live="polite">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-3 text-label">
                  <span className="min-w-0 truncate text-text">{r.name}</span>
                  <span className="shrink-0 text-text-2">{r.state === "done" ? "En el Vault" : r.state === "error" ? "No movido" : r.state === "moving" ? `${Math.round(r.progress * 100)} %` : "En espera"}</span>
                </div>
                {r.state === "moving" ? <Progress value={r.progress} label={`Moviendo ${r.name}`} /> : null}
                {r.message ? <p className="text-caption text-text-2">{r.message}</p> : null}
              </li>
            ))}
          </ul>
        )}
        <div className="flex justify-end gap-2">
          {busy ? (
            <Button variant="ghost" size="sm" onClick={() => controller.current?.abort()}>
              Cancelar
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={onClose}>
              {finished ? "Cerrar" : "Cancelar"}
            </Button>
          )}
          {!finished ? (
            <Button size="sm" disabled={busy || !folderId || !targets || targets.length === 0} onClick={() => void run()}>
              Mover al Vault
            </Button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
