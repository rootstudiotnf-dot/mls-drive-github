"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createFolder, deleteFolder, renameFolder, reorderFolder } from "@/app/actions/artists";
import { FolderIcon, PlusIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Menu } from "@/components/ui/Menu";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Select } from "@/components/ui/Select";
import type { ActionResult } from "@/lib/action-result";

type AnyResult = ActionResult<unknown>;
import type { FolderNode } from "@/lib/artists/data";

/** Pestaña de la URL que lista el contenido de cada tipo de carpeta. */
export const TAB_OF_FOLDER_KIND: Record<FolderNode["kind"], string> = {
  photos: "fotos",
  videos: "videos",
  files: "archivos",
  general: "todo",
};

type Dialog =
  | { type: "create" }
  | { type: "rename"; folder: FolderNode }
  | { type: "delete"; folder: FolderNode };

const plural = (n: number) => `${n} ${n === 1 ? "elemento" : "elementos"}`;

/**
 * Carpetas del artista: árbol con contadores, filtro por carpeta (enlaces) y gestión (crear, renombrar,
 * ordenar, borrar). La gestión solo se pinta con permiso de edición; el servidor lo comprueba en cada acción.
 */
export function FolderPanel({
  slug,
  folders,
  canManage,
}: {
  slug: string;
  folders: FolderNode[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [notice, setNotice] = useState<AnyResult | null>(null);
  const [pending, startTransition] = useTransition();

  const finish = (result: AnyResult) => {
    setNotice(result);
    if (result.ok) {
      setDialog(null);
      router.refresh();
    }
  };

  const run = (fn: () => Promise<AnyResult>) => startTransition(async () => finish(await fn()));

  const siblingsOf = (folder: FolderNode) => folders.filter((f) => f.parentId === folder.parentId);

  return (
    <section>
      <SectionHeader
        title="Carpetas"
        action={
          canManage ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setName("");
                setParentId(folders[0]?.id ?? "");
                setNotice(null);
                setDialog({ type: "create" });
              }}
            >
              <PlusIcon size={16} />
              Nueva carpeta
            </Button>
          ) : undefined
        }
      />
      <div aria-live="polite" className="mb-4 empty:hidden">
        {notice ? <Notice variant={notice.ok ? "success" : "error"}>{notice.message ?? "Hecho."}</Notice> : null}
      </div>

      {folders.length === 0 ? (
        <EmptyState
          icon={<FolderIcon size={22} />}
          title="Sin carpetas"
          description="Las carpetas base (Fotos, Vídeos y Archivos) se crean con el artista."
        />
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
          {folders.map((folder) => {
            const siblings = siblingsOf(folder);
            const index = siblings.findIndex((f) => f.id === folder.id);
            const isRoot = folder.parentId === null;
            const items = [
              ...(canManage && !isRoot ? [{ label: "Renombrar", onSelect: () => { setName(folder.name); setNotice(null); setDialog({ type: "rename", folder }); } }] : []),
              ...(canManage && index > 0 ? [{ label: "Subir", onSelect: () => run(() => reorderFolder(folder.id, "up")) }] : []),
              ...(canManage && index < siblings.length - 1 ? [{ label: "Bajar", onSelect: () => run(() => reorderFolder(folder.id, "down")) }] : []),
              ...(canManage && !isRoot ? [{ label: "Borrar", destructive: true, onSelect: () => { setNotice(null); setDialog({ type: "delete", folder }); } }] : []),
            ];
            return (
              <li key={folder.id} className="flex min-h-14 items-center gap-3 px-4 py-2.5 transition-colors duration-150 ease-ui hover:bg-hover">
                <span style={{ paddingLeft: `${folder.depth * 1.25}rem` }} className="flex min-w-0 flex-1 items-center gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-tone-3 text-text-2">
                    <FolderIcon size={18} />
                  </span>
                  <Link
                    href={`/artistas/${slug}?tab=${TAB_OF_FOLDER_KIND[folder.kind]}&carpeta=${folder.id}`}
                    className="min-w-0 rounded-control"
                  >
                    <span className="block truncate text-body font-medium text-text">{folder.name}</span>
                    <span className="block truncate text-label text-text-2">
                      {plural(folder.total)}
                      {folder.total !== folder.items ? ` · ${folder.items} aquí` : ""}
                    </span>
                  </Link>
                </span>
                {items.length > 0 ? <Menu label={`Acciones de la carpeta ${folder.name}`} items={items} /> : null}
              </li>
            );
          })}
        </ul>
      )}

      <Modal open={dialog?.type === "create"} onClose={() => setDialog(null)} title="Nueva carpeta" description="Se crea dentro de la carpeta que elijas y hereda su tipo.">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            run(() => createFolder({ parentId, name }));
          }}
        >
          {notice && !notice.ok ? <Notice variant="error">{notice.message}</Notice> : null}
          <Input label="Nombre" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required autoFocus />
          <Select
            label="Dentro de"
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
            options={folders.map((f) => ({ value: f.id, label: `${"— ".repeat(f.depth)}${f.name}` }))}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setDialog(null)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={pending || name.trim().length === 0 || !parentId}>
              {pending ? "Creando…" : "Crear carpeta"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal open={dialog?.type === "rename"} onClose={() => setDialog(null)} title="Renombrar carpeta">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (dialog?.type === "rename") {
              const id = dialog.folder.id;
              run(() => renameFolder(id, name));
            }
          }}
        >
          {notice && !notice.ok ? <Notice variant="error">{notice.message}</Notice> : null}
          <Input label="Nombre" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required autoFocus />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setDialog(null)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={pending || name.trim().length === 0}>
              Guardar
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
            ? dialog.folder.total > 0
              ? `«${dialog.folder.name}» no está vacía. Mueve o envía a la papelera su contenido antes de borrarla.`
              : `«${dialog.folder.name}» se borrará. Esta acción no afecta a ningún archivo.`
            : undefined
        }
      >
        {notice && !notice.ok ? <Notice variant="error">{notice.message}</Notice> : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDialog(null)}>
            Cancelar
          </Button>
          <Button
            disabled={pending || (dialog?.type === "delete" && dialog.folder.total > 0)}
            onClick={() => {
              if (dialog?.type === "delete") {
                const id = dialog.folder.id;
                run(() => deleteFolder(id));
              }
            }}
          >
            Borrar carpeta
          </Button>
        </div>
      </Modal>
    </section>
  );
}
