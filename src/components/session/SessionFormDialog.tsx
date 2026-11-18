"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createSession, updateSession } from "@/app/actions/sessions";
import { PlusIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { DOWNLOAD_MODE_LABEL, type DownloadMode } from "@/lib/assets/variants";

export type SessionFormValues = {
  id?: string;
  name: string;
  date: string;
  description: string;
  artistId: string;
  participantIds: string[];
  downloadMode: DownloadMode;
};

const MODE_HINT: Record<DownloadMode, string> = {
  off: "Los artistas ven la sesión pero no pueden descargar nada.",
  web: "Pueden descargar la versión web (2048 px).",
  original: "Pueden descargar los originales (y la versión web).",
};

function SessionForm({
  initial,
  artists,
  canChangeMode,
  onClose,
}: {
  initial: SessionFormValues;
  artists: { id: string; name: string }[];
  canChangeMode: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const editing = Boolean(initial.id);
  const set = <K extends keyof SessionFormValues>(key: K, value: SessionFormValues[K]) => setValues((v) => ({ ...v, [key]: value }));

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const payload = { ...values, participantIds: values.participantIds.filter((id) => id !== values.artistId) };
      if (editing && initial.id) {
        const res = await updateSession(initial.id, payload);
        if (!res.ok) return setError(res.message);
        onClose();
        router.refresh();
      } else {
        const res = await createSession(payload);
        if (!res.ok || !res.data) return setError(res.ok ? "No se pudo crear la sesión." : res.message);
        onClose();
        router.push(`/sesiones/${res.data.id}`);
      }
    });
  };

  const others = artists.filter((a) => a.id !== values.artistId);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {error ? <Notice variant="error">{error}</Notice> : null}
      <Input label="Nombre" value={values.name} onChange={(e) => set("name", e.target.value)} maxLength={80} required autoFocus />
      <Input label="Fecha" type="date" value={values.date} onChange={(e) => set("date", e.target.value)} />
      <Textarea label="Descripción (opcional)" value={values.description} onChange={(e) => set("description", e.target.value)} maxLength={1000} />
      <Select
        label="Artista principal"
        value={values.artistId}
        disabled={editing}
        onChange={(e) => set("artistId", e.target.value)}
        options={[{ value: "", label: "Elige un artista…" }, ...artists.map((a) => ({ value: a.id, label: a.name }))]}
      />
      {others.length > 0 ? (
        <fieldset>
          <legend className="mb-2 text-label font-medium text-text-2">Artistas participantes</legend>
          <div className="flex max-h-36 flex-col gap-1 overflow-y-auto rounded-control border border-line p-2">
            {others.map((artist) => (
              <label key={artist.id} className="flex items-center gap-2.5 rounded-control px-2 py-1.5 text-body text-text hover:bg-hover">
                <input
                  type="checkbox"
                  checked={values.participantIds.includes(artist.id)}
                  onChange={(e) =>
                    set("participantIds", e.target.checked ? [...values.participantIds, artist.id] : values.participantIds.filter((id) => id !== artist.id))
                  }
                  className="size-4"
                />
                {artist.name}
              </label>
            ))}
          </div>
          <p className="mt-1.5 text-caption text-text-3">Además del principal, estos artistas ven las fotos publicadas de la sesión.</p>
        </fieldset>
      ) : null}
      <div>
        <Select
          label="Descarga"
          value={values.downloadMode}
          disabled={!canChangeMode}
          onChange={(e) => set("downloadMode", e.target.value as DownloadMode)}
          options={(Object.keys(DOWNLOAD_MODE_LABEL) as DownloadMode[]).map((m) => ({ value: m, label: DOWNLOAD_MODE_LABEL[m] }))}
        />
        <p className="mt-1.5 text-caption text-text-3">{canChangeMode ? MODE_HINT[values.downloadMode] : "Cambiar la descarga exige permiso de publicar."}</p>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
        <Button type="submit" disabled={pending || values.name.trim().length < 2 || !values.artistId}>
          {pending ? "Guardando…" : editing ? "Guardar" : "Crear sesión"}
        </Button>
      </div>
    </form>
  );
}

/** Crear o editar una sesión. Sin `initial.id` crea; con él, edita. */
export function SessionFormDialog({
  initial,
  artists,
  canChangeMode,
  trigger = "create",
}: {
  initial: SessionFormValues;
  artists: { id: string; name: string }[];
  canChangeMode: boolean;
  trigger?: "create" | "edit";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {trigger === "create" ? (
        <Button size="sm" onClick={() => setOpen(true)}>
          <PlusIcon size={16} />
          Nueva sesión
        </Button>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          Editar
        </Button>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title={trigger === "create" ? "Nueva sesión" : "Editar sesión"}>
        {open ? <SessionForm initial={initial} artists={artists} canChangeMode={canChangeMode} onClose={() => setOpen(false)} /> : null}
      </Modal>
    </>
  );
}
