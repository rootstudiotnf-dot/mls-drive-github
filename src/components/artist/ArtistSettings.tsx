"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { archiveArtist, setArtistAvatar, updateArtist } from "@/app/actions/artists";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Textarea } from "@/components/ui/Textarea";
import { AVATAR_MAX_BYTES, uploadArtistAvatar } from "@/components/upload/avatar";
import type { ActionResult } from "@/lib/action-result";
import { formatBytes } from "@/lib/format";

/** Ajustes del artista: nombre, biografía, avatar y archivado. Todo exige `artists.manage` en servidor. */
export function ArtistSettings({
  artistId,
  name: initialName,
  bio: initialBio,
  archived,
  avatarUrl,
  hasAvatar,
}: {
  artistId: string;
  name: string;
  bio: string;
  archived: boolean;
  avatarUrl?: string;
  hasAvatar: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [bio, setBio] = useState(initialBio);
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [pending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  const report = (res: ActionResult<unknown> | { ok: boolean; message?: string }) => {
    setNotice({ ok: res.ok, message: res.message ?? (res.ok ? "Hecho." : "No se pudo completar la acción.") });
    if (res.ok) router.refresh();
  };

  const dirty = name.trim() !== initialName || bio.trim() !== initialBio;

  return (
    <div className="flex max-w-2xl flex-col gap-10">
      <div aria-live="polite" className="empty:hidden">
        {notice ? <Notice variant={notice.ok ? "success" : "error"}>{notice.message}</Notice> : null}
      </div>

      <section>
        <SectionHeader title="Datos" />
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            startTransition(async () => report(await updateArtist(artistId, { name, bio })));
          }}
        >
          <Input label="Nombre" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
          <Textarea label="Biografía" value={bio} onChange={(e) => setBio(e.target.value)} maxLength={600} />
          <Button type="submit" className="self-start" disabled={pending || !dirty || name.trim().length < 2}>
            {pending ? "Guardando…" : "Guardar cambios"}
          </Button>
        </form>
      </section>

      <section>
        <SectionHeader title="Avatar" />
        <div className="flex flex-wrap items-center gap-5">
          <Avatar name={initialName} imageUrl={avatarUrl} size="xl" />
          <div className="flex flex-col gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              aria-label="Elegir foto de avatar"
              className="text-label text-text-2 file:mr-3 file:rounded-pill file:border file:border-line file:bg-transparent file:px-3.5 file:py-1.5 file:text-label file:text-text"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                startTransition(async () => {
                  report(await uploadArtistAvatar(file, artistId));
                  if (fileRef.current) fileRef.current.value = "";
                });
              }}
            />
            <p className="text-caption text-text-3">JPEG, PNG o WebP, hasta {formatBytes(AVATAR_MAX_BYTES)}.</p>
            {hasAvatar ? (
              <Button
                size="sm"
                variant="ghost"
                className="self-start"
                disabled={pending}
                onClick={() => startTransition(async () => report(await setArtistAvatar(artistId, null)))}
              >
                Quitar avatar
              </Button>
            ) : null}
          </div>
        </div>
      </section>

      <section>
        <SectionHeader title={archived ? "Artista archivado" : "Archivar artista"} />
        <p className="mb-4 max-w-xl text-label text-text-2">
          {archived
            ? "Está archivado: sigue existiendo pero no aparece entre los activos. Puedes reactivarlo cuando quieras."
            : "Archivar no borra nada: el espacio se conserva con todo su contenido y solo se oculta de los activos."}
        </p>
        {archived ? (
          <Button variant="ghost" disabled={pending} onClick={() => startTransition(async () => report(await archiveArtist(artistId, false)))}>
            Reactivar artista
          </Button>
        ) : (
          <Button variant="ghost" disabled={pending} onClick={() => setConfirmArchive(true)}>
            Archivar artista
          </Button>
        )}
      </section>

      <Modal open={confirmArchive} onClose={() => setConfirmArchive(false)} title="Archivar artista" description="Su contenido y sus accesos se conservan. Podrás reactivarlo cuando quieras.">
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmArchive(false)}>
            Cancelar
          </Button>
          <Button
            disabled={pending}
            onClick={() => {
              setConfirmArchive(false);
              startTransition(async () => report(await archiveArtist(artistId, true)));
            }}
          >
            Archivar
          </Button>
        </div>
      </Modal>
    </div>
  );
}
