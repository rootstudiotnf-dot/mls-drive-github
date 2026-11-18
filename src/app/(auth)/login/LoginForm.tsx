"use client";

import { useActionState, useState } from "react";
import { sendMagicLink, signInWithPassword } from "@/lib/auth/actions";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Notice } from "@/components/ui/Notice";

export function LoginForm({ initialError }: { initialError?: string }) {
  const [mode, setMode] = useState<"password" | "link">("password");
  const [passwordState, passwordAction, passwordPending] = useActionState(
    signInWithPassword,
    null,
  );
  const [linkState, linkAction, linkPending] = useActionState(sendMagicLink, null);

  if (mode === "link") {
    return (
      <form action={linkAction} className="flex flex-col gap-4" noValidate>
        {linkState ? (
          <Notice variant={linkState.ok ? "success" : "error"}>{linkState.message}</Notice>
        ) : null}
        <Input
          label="Correo"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          placeholder="tu@correo.com"
          defaultValue={linkState?.values?.email}
          required
          autoFocus
        />
        <Button type="submit" className="w-full" disabled={linkPending}>
          {linkPending ? "Enviando…" : "Enviar enlace"}
        </Button>
        <Button type="button" variant="ghost" className="w-full" onClick={() => setMode("password")}>
          Volver a contraseña
        </Button>
      </form>
    );
  }

  const error = passwordState?.message ?? initialError;

  return (
    <form action={passwordAction} className="flex flex-col gap-4" noValidate>
      {error ? <Notice variant="error">{error}</Notice> : null}
      <Input
        label="Correo"
        name="email"
        type="email"
        autoComplete="email"
        inputMode="email"
        placeholder="tu@correo.com"
        defaultValue={passwordState?.values?.email}
        required
        autoFocus
      />
      <Input
        label="Contraseña"
        name="password"
        type="password"
        autoComplete="current-password"
        required
      />
      <Button type="submit" className="mt-1 w-full" disabled={passwordPending}>
        {passwordPending ? "Entrando…" : "Entrar"}
      </Button>
      <button
        type="button"
        onClick={() => setMode("link")}
        className="rounded-control text-label font-medium text-text-2 transition-colors duration-150 ease-ui hover:text-text"
      >
        Recibir un enlace por correo
      </button>
    </form>
  );
}
