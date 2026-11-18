"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { resetMfaWithRecoveryCode } from "@/app/(admin)/cuenta/actions";
import { unlockVault } from "@/app/actions/vault";
import { LockIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Notice } from "@/components/ui/Notice";

/**
 * Desbloqueo del Vault: contraseña (reautenticación) y, si la sesión aún no pasó la verificación en dos pasos,
 * el código de 6 dígitos. Tras 5 fallos seguidos el servidor bloquea 15 minutos. «He perdido mi dispositivo» usa un
 * código de recuperación para retirar el factor actual (después hay que activarlo de nuevo).
 */
export function UnlockForm({ needsCode }: { needsCode: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  const submit = () =>
    startTransition(async () => {
      const res = recovery ? await resetMfaWithRecoveryCode({ password, recoveryCode }) : await unlockVault({ password, code });
      setPassword("");
      setCode("");
      setRecoveryCode("");
      if (res.ok) {
        setMessage(recovery ? { kind: "success", text: res.message ?? "Listo." } : null);
        router.refresh();
      } else {
        setMessage({ kind: "error", text: res.message });
      }
    });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="mx-auto flex w-full max-w-sm flex-col gap-5 rounded-block border border-line bg-surface p-6"
    >
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-control bg-tone-3 text-text-2">
          <LockIcon size={20} />
        </span>
        <div>
          <h2 className="text-heading text-text">Vault bloqueado</h2>
          <p className="text-label text-text-2">{recovery ? "Usa un código de recuperación." : "Vuelve a confirmar que eres tú."}</p>
        </div>
      </div>
      {message ? <Notice variant={message.kind}>{message.text}</Notice> : null}
      <Input label="Contraseña" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      {recovery ? (
        <Input label="Código de recuperación" autoComplete="off" value={recoveryCode} onChange={(e) => setRecoveryCode(e.target.value)} placeholder="XXXX-XXXX" required />
      ) : needsCode ? (
        <Input label="Código de verificación (6 dígitos)" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} required />
      ) : null}
      <Button type="submit" disabled={pending || !password}>
        {recovery ? "Retirar verificación en dos pasos" : "Abrir el Vault"}
      </Button>
      <button
        type="button"
        onClick={() => {
          setRecovery(!recovery);
          setMessage(null);
        }}
        className="self-start rounded-control text-label text-text-2 underline transition-colors duration-150 ease-ui hover:text-text"
      >
        {recovery ? "Volver al código de verificación" : "He perdido mi dispositivo"}
      </button>
    </form>
  );
}
