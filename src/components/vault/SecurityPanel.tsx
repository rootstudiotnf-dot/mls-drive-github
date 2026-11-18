"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { confirmTotpEnrollment, regenerateRecoveryCodes, startTotpEnrollment, type Enrollment, type MfaStatus } from "@/app/(admin)/cuenta/actions";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Notice } from "@/components/ui/Notice";
import { SectionHeader } from "@/components/ui/SectionHeader";

/**
 * Verificación en dos pasos (TOTP): activar con QR y confirmar con un código; códigos de recuperación (se muestran
 * UNA vez; si se pierden, se generan nuevos). Cualquier persona con acceso al Vault necesita tenerla activada.
 */
export function SecurityPanel({ initial }: { initial: MfaStatus }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState(initial);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  const start = () =>
    startTransition(async () => {
      const res = await startTotpEnrollment();
      if (res.ok && res.data) {
        setEnrollment(res.data);
        setMessage(null);
      } else setMessage({ kind: "error", text: res.ok ? "No se pudo empezar." : res.message });
    });

  const confirm = () =>
    startTransition(async () => {
      if (!enrollment) return;
      const res = await confirmTotpEnrollment({ factorId: enrollment.factorId, code });
      if (res.ok && res.data) {
        setCodes(res.data.recoveryCodes);
        setStatus({ enrolled: true, recoveryLeft: res.data.recoveryCodes.length });
        setEnrollment(null);
        setCode("");
        setMessage({ kind: "success", text: res.message ?? "Activada." });
        router.refresh();
      } else setMessage({ kind: "error", text: res.ok ? "No se pudo confirmar." : res.message });
    });

  const regenerate = () =>
    startTransition(async () => {
      const res = await regenerateRecoveryCodes({ password });
      setPassword("");
      if (res.ok && res.data) {
        setCodes(res.data.recoveryCodes);
        setStatus((s) => ({ ...s, recoveryLeft: res.data!.recoveryCodes.length }));
        setMessage({ kind: "success", text: res.message ?? "Listo." });
      } else setMessage({ kind: "error", text: res.ok ? "No se pudo generar." : res.message });
    });

  const download = () => {
    if (!codes) return;
    const blob = new Blob([`Códigos de recuperación de MLS Drive\r\nCada código sirve una sola vez.\r\n\r\n${codes.join("\r\n")}\r\n`], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "codigos-recuperacion-mls-drive.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };

  return (
    <div className="flex max-w-xl flex-col gap-8">
      {message ? <Notice variant={message.kind}>{message.text}</Notice> : null}

      <section>
        <SectionHeader title="Verificación en dos pasos" />
        {status.enrolled ? (
          <p className="text-body text-text-2">Activada. Al abrir el Vault se te pedirá, además de la contraseña, el código de tu aplicación (Google Authenticator, 1Password, Authy…).</p>
        ) : enrollment ? (
          <div className="flex flex-col gap-4">
            <ol className="list-decimal pl-5 text-body text-text-2">
              <li>Abre tu aplicación de verificación y escanea el código QR.</li>
              <li>Escribe el código de 6 dígitos que muestra.</li>
            </ol>
            {/* El QR es un SVG que genera Supabase; se pinta como imagen (nunca se inserta como HTML) */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={enrollment.qr} alt="Código QR para la aplicación de verificación" width={192} height={192} className="rounded-card border border-line bg-text p-2" />
            <p className="text-label text-text-2">
              ¿No puedes escanearlo? Introduce esta clave a mano: <code className="select-all break-all text-text">{enrollment.secret}</code>
            </p>
            <form
              className="flex items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                confirm();
              }}
            >
              <Input label="Código de 6 dígitos" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} className="w-40" />
              <Button type="submit" disabled={pending || code.replace(/\s/g, "").length !== 6}>
                Activar
              </Button>
            </form>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-body text-text-2">Necesitas activarla para abrir el Vault. Solo hace falta una vez.</p>
            <Button className="self-start" disabled={pending} onClick={start}>
              Activar verificación en dos pasos
            </Button>
          </div>
        )}
      </section>

      {codes ? (
        <section aria-labelledby="recovery-codes">
          <SectionHeader title="Códigos de recuperación" />
          <Notice variant="info">
            Guárdalos ahora en un lugar seguro: <span className="font-medium text-text">no se vuelven a mostrar</span>. Cada uno sirve una sola vez si pierdes tu dispositivo.
          </Notice>
          <ul id="recovery-codes" className="mt-4 grid grid-cols-2 gap-2 rounded-card border border-line bg-surface p-4 font-mono text-body text-text">
            {codes.map((c) => (
              <li key={c} className="select-all">{c}</li>
            ))}
          </ul>
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="ghost" onClick={download}>Descargar .txt</Button>
            <Button size="sm" variant="ghost" onClick={() => setCodes(null)}>Ya los he guardado</Button>
          </div>
        </section>
      ) : status.enrolled ? (
        <section>
          <SectionHeader title="Códigos de recuperación" />
          <p className="mb-3 text-body text-text-2">Te quedan {status.recoveryLeft} sin usar. Si los pierdes, genera nuevos (los anteriores dejan de valer). Necesitas haber abierto el Vault en esta sesión.</p>
          <form
            className="flex items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              regenerate();
            }}
          >
            <Input label="Tu contraseña" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <Button type="submit" variant="ghost" disabled={pending || !password}>
              Generar nuevos
            </Button>
          </form>
        </section>
      ) : null}
    </div>
  );
}
