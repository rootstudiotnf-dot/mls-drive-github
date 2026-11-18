"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { purgeAssets, restoreAssets, type TrashItem } from "@/app/actions/browse";
import { TrashIcon } from "@/components/icons";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { DataList, DataRow } from "@/components/ui/DataRow";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import { formatBytes } from "@/lib/format";

const KIND_LABEL: Record<TrashItem["kind"], string> = {
  photo: "Foto",
  video: "Vídeo",
  audio: "Audio",
  document: "Documento",
  other: "Archivo",
};

const day = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", timeZone: "Atlantic/Canary" });

/** Papelera del artista: restaurar (cualquiera con edición) o eliminar definitivamente (con permiso de borrado). */
export function TrashPanel({ items }: { items: TrashItem[] }) {
  const router = useRouter();
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const [confirm, setConfirm] = useState<TrashItem | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (fn: () => ReturnType<typeof restoreAssets>) =>
    startTransition(async () => {
      const res = await fn();
      setNotice({ ok: res.ok, message: res.message ?? (res.ok ? "Hecho." : "No se pudo completar la acción.") });
      if (res.ok) router.refresh();
    });

  return (
    <section className="flex flex-col gap-5" aria-label="Papelera">
      <p className="max-w-2xl text-label text-text-2">
        Lo que envías a la papelera deja de ser visible para todos. Se elimina definitivamente a los 30 días.
      </p>
      <div aria-live="polite" className="empty:hidden">
        {notice ? <Notice variant={notice.ok ? "success" : "error"}>{notice.message}</Notice> : null}
      </div>
      {items.length === 0 ? (
        <EmptyState icon={<TrashIcon size={22} />} title="La papelera está vacía" description="Lo que borres aparecerá aquí durante 30 días." />
      ) : (
        <DataList>
          {items.map((item) => (
            <DataRow
              key={item.id}
              title={item.title}
              subtitle={`${KIND_LABEL[item.kind]} · ${formatBytes(item.sizeBytes)} · borrado el ${day.format(new Date(item.deletedAt))}`}
              trailing={
                <>
                  {!item.canRestore && !item.canPurge ? <Badge variant="outline">Solo lectura</Badge> : null}
                  {item.canRestore ? (
                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => restoreAssets([item.id]))}>
                      Restaurar
                    </Button>
                  ) : null}
                  {item.canPurge ? (
                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirm(item)}>
                      Eliminar
                    </Button>
                  ) : null}
                </>
              }
            />
          ))}
        </DataList>
      )}

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title="Eliminar definitivamente"
        description={confirm ? `«${confirm.title}» se borrará para siempre, también de R2. No se puede deshacer.` : undefined}
      >
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirm(null)}>
            Cancelar
          </Button>
          <Button
            disabled={pending}
            onClick={() => {
              const target = confirm;
              setConfirm(null);
              if (target) run(() => purgeAssets([target.id]));
            }}
          >
            Eliminar para siempre
          </Button>
        </div>
      </Modal>
    </section>
  );
}
