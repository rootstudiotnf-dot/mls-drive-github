"use client";

import { useActionState } from "react";
import { acceptInvitation } from "@/lib/auth/actions";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Notice } from "@/components/ui/Notice";

export function InvitationForm({ email }: { email: string }) {
  const [state, action, pending] = useActionState(acceptInvitation, null);

  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      {state && !state.ok ? <Notice variant="error">{state.message}</Notice> : null}
      <Input label="Correo" type="email" value={email} readOnly disabled autoComplete="off" />
      <Input
        label="Tu nombre"
        name="name"
        type="text"
        autoComplete="name"
        placeholder="Nombre y apellidos"
        defaultValue={state?.values?.name}
        required
        autoFocus
        maxLength={80}
      />
      <Input
        label="Contraseña"
        name="password"
        type="password"
        autoComplete="new-password"
        hint="Mínimo 10 caracteres."
        required
        minLength={10}
        maxLength={72}
      />
      <Button type="submit" className="mt-1 w-full" disabled={pending}>
        {pending ? "Creando cuenta…" : "Crear cuenta y entrar"}
      </Button>
    </form>
  );
}
