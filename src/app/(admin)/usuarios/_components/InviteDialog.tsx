"use client";

import { useActionState, useState } from "react";
import { PlusIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import { Select } from "@/components/ui/Select";
import { inviteUser } from "../actions";
import type { RoleOption } from "./types";

function InviteForm({ roles, onClose }: { roles: RoleOption[]; onClose: () => void }) {
  const [state, action, pending] = useActionState(inviteUser, null);

  if (state?.ok) {
    return (
      <div className="flex flex-col gap-5">
        <Notice variant="success">{state.message}</Notice>
        <Button onClick={onClose} className="self-end">
          Listo
        </Button>
      </div>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      {state ? <Notice variant="error">{state.message}</Notice> : null}
      <Input
        label="Correo"
        name="email"
        type="email"
        autoComplete="off"
        inputMode="email"
        placeholder="persona@correo.com"
        required
        autoFocus
      />
      <Select label="Rol" name="role" options={roles} defaultValue={roles[0]?.value} />
      <p className="text-caption text-text-3">
        Recibirá un correo con un enlace de un solo uso, válido durante 7 días.
      </p>
      <div className="mt-1 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Enviando…" : "Enviar invitación"}
        </Button>
      </div>
    </form>
  );
}

export function InviteDialog({ roles }: { roles: RoleOption[] }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} disabled={roles.length === 0}>
        <PlusIcon size={16} />
        Invitar usuario
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Invitar usuario"
        description="La cuenta solo se crea cuando la persona acepta la invitación."
      >
        <InviteForm roles={roles} onClose={() => setOpen(false)} />
      </Modal>
    </>
  );
}
