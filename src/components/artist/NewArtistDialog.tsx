"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { createArtist } from "@/app/actions/artists";
import { PlusIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import { Textarea } from "@/components/ui/Textarea";
import { AVATAR_MAX_BYTES, uploadArtistAvatar } from "@/components/upload/avatar";
import { formatBytes } from "@/lib/format";

function NewArtistForm({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const created = await createArtist({ name, bio });
      if (!created.ok || !created.data) {
        setError(created.ok ? "No se pudo crear el artista." : created.message);
        return;
      }
      const file = fileRef.current?.files?.[0];
      if (file) {
        const uploaded = await uploadArtistAvatar(file, created.data.id);
        if (!uploaded.ok) {
          // El artista ya existe: se avisa y se puede poner el avatar luego desde sus ajustes
          setWarning(`Artista creado, pero el avatar no se subió: ${uploaded.message} Puedes añadirlo en Ajustes.`);
          router.refresh();
          return;
        }
      }
      onClose();
      router.push(`/artistas/${created.data.slug}`);
    });
  };

  if (warning) {
    return (
      <div className="flex flex-col gap-5">
        <Notice variant="info">{warning}</Notice>
        <Button className="self-end" onClick={onClose}>
          Cerrar
        </Button>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {error ? <Notice variant="error">{error}</Notice> : null}
      <Input label="Nombre" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required autoFocus />
      <Textarea label="Biografía (opcional)" value={bio} onChange={(e) => setBio(e.target.value)} maxLength={600} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor="avatar-nuevo" className="text-label font-medium text-text-2">
          Avatar (opcional)
        </label>
        <input
          id="avatar-nuevo"
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="text-label text-text-2 file:mr-3 file:rounded-pill file:border file:border-line file:bg-transparent file:px-3.5 file:py-1.5 file:text-label file:text-text"
        />
        <p className="text-caption text-text-3">JPEG, PNG o WebP, hasta {formatBytes(AVATAR_MAX_BYTES)}.</p>
      </div>
      <p className="text-caption text-text-3">
        Se crean automáticamente las carpetas base: Fotos, Vídeos y Archivos.
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
        <Button type="submit" disabled={pending || name.trim().length < 2}>
          {pending ? "Creando…" : "Crear artista"}
        </Button>
      </div>
    </form>
  );
}

export function NewArtistDialog() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <PlusIcon size={16} />
        Nuevo artista
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Nuevo artista">
        <NewArtistForm onClose={() => setOpen(false)} />
      </Modal>
    </>
  );
}
