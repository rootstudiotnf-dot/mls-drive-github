"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { PlusIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import { createRole } from "../actions";

function NewRoleForm({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const name = String(new FormData(event.currentTarget).get("name") ?? "");
        startTransition(async () => {
          // Nace sin permisos y con el alcance más restrictivo: después se edita.
          const result = await createRole({ name, description: "", scope: "assigned", permissions: [] });
          if (result.ok && result.data) {
            onClose();
            router.push(`/usuarios/roles?role=${encodeURIComponent(result.data.key)}`);
          } else if (!result.ok) {
            setError(result.message);
          }
        });
      }}
    >
      {error ? <Notice variant="error">{error}</Notice> : null}
      <Input label="Nombre del rol" name="name" placeholder="Editor de vídeo" maxLength={40} required autoFocus />
      <p className="text-caption text-text-3">
        Empieza sin permisos y con acceso solo a artistas asignados. Podrás ajustarlo a continuación.
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Creando…" : "Crear rol"}
        </Button>
      </div>
    </form>
  );
}

export function NewRoleButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <PlusIcon size={16} />
        Nuevo rol
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Nuevo rol">
        <NewRoleForm onClose={() => setOpen(false)} />
      </Modal>
    </>
  );
}
