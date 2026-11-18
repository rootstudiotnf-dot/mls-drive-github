"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { LockIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Notice } from "@/components/ui/Notice";
import { shareUnlock } from "./actions";

/** Pantalla de contraseña de un enlace: no muestra título ni contenido hasta acertar. */
export function PasswordGate({ token }: { token: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <main className="flex min-h-dvh items-center justify-center px-5 py-10">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          startTransition(async () => {
            const res = await shareUnlock({ token, password });
            setPassword("");
            if (res.ok) router.refresh();
            else setError(res.message);
          });
        }}
        className="flex w-full max-w-sm flex-col gap-5 rounded-block border border-line bg-surface p-6"
      >
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-control bg-tone-3 text-text-2">
            <LockIcon size={20} />
          </span>
          <div>
            <h1 className="text-heading text-text">Enlace protegido</h1>
            <p className="text-label text-text-2">Introduce la contraseña que te han dado.</p>
          </div>
        </div>
        {error ? <Notice variant="error">{error}</Notice> : null}
        <Input label="Contraseña" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <Button type="submit" disabled={pending || !password}>
          Ver contenido
        </Button>
      </form>
    </main>
  );
}
