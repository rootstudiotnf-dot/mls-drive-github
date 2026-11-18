"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createSessionFolder, deleteSessionFolder, renameSessionFolder } from "@/app/actions/sessions";
import { PlusIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Menu } from "@/components/ui/Menu";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import type { ActionResult } from "@/lib/action-result";
import type { SessionFolder } from "@/lib/sessions/types";

type Dialog = { type: "create" } | { type: "rename"; folder: SessionFolder } | { type: "delete"; folder: SessionFolder } | null;

/** Carpetas de la sesión (p. ej. «Selección», «Detrás de cámaras»): crear, renombrar y borrar las vacías. */
export function SessionFolders({ sessionId, folders, canEdit }: { sessionId: string; folders: SessionFolder[]; canEdit: boolean }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [name, setName] = useState("");
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();

  if (!canEdit && folders.length === 0) return null;

  const run = (fn: () => Promise<ActionResult<unknown>>) =>
    startTransition(async () => {
      const res = await fn();
      setResult(res);
      if (res.ok) {
        setDialog(null);
        router.refresh();
      }
    });

  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="Carpetas de la sesión">
      {folders.map((folder) => (
        <span key={folder.id} className="inline-flex items-center gap-1 rounded-pill border border-line py-0.5 pr-0.5 pl-3.5 text-label text-text-2">
          {folder.name} · {folder.photos}
          {canEdit ? (
            <Menu
              label={`Acciones de la carpeta ${folder.name}`}
              items={[
                {
                  label: "Renombrar",
                  onSelect: () => {
                    setName(folder.name);
                    setResult(null);
                    setDialog({ type: "rename", folder });
                  },
                },
                {
                  label: "Borrar",
                  destructive: true,
                  onSelect: () => {
                    setResult(null);
                    setDialog({ type: "delete", folder });
                  },
                },
              ]}
            />
          ) : null}
        </span>
      ))}
      {canEdit ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setName("");
            setResult(null);
            setDialog({ type: "create" });
          }}
        >
          <PlusIcon size={16} />
          Nueva carpeta
        </Button>
      ) : null}

      <Modal
        open={dialog?.type === "create" || dialog?.type === "rename"}
        onClose={() => setDialog(null)}
        title={dialog?.type === "rename" ? "Renombrar carpeta" : "Nueva carpeta"}
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (dialog?.type === "rename") {
              const id = dialog.folder.id;
              run(() => renameSessionFolder(id, name));
            } else run(() => createSessionFolder({ sessionId, name }));
          }}
        >
          {result && !result.ok ? <Notice variant="error">{result.message}</Notice> : null}
          <Input label="Nombre" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required autoFocus />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setDialog(null)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={pending || name.trim().length === 0}>
              {dialog?.type === "rename" ? "Guardar" : "Crear carpeta"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={dialog?.type === "delete"}
        onClose={() => setDialog(null)}
        title="Borrar carpeta"
        description={
          dialog?.type === "delete"
            ? dialog.folder.photos > 0
              ? `«${dialog.folder.name}» tiene fotos: muévelas antes de borrarla.`
              : `«${dialog.folder.name}» se borrará. Ninguna foto se ve afectada.`
            : undefined
        }
      >
        {result && !result.ok ? <Notice variant="error">{result.message}</Notice> : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDialog(null)}>
            Cancelar
          </Button>
          <Button
            disabled={pending || (dialog?.type === "delete" && dialog.folder.photos > 0)}
            onClick={() => {
              if (dialog?.type === "delete") {
                const id = dialog.folder.id;
                run(() => deleteSessionFolder(id));
              }
            }}
          >
            Borrar carpeta
          </Button>
        </div>
      </Modal>
    </div>
  );
}
