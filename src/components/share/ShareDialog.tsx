"use client";

import { useState, useTransition } from "react";
import { createShareLink, type ShareTarget } from "@/app/actions/share";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { Toggle } from "@/components/ui/Toggle";

/**
 * Modal «Compartir» (UNA sola implementación: sesiones, carpetas, selecciones de fotos y de beats).
 * Crea un enlace externo con caducidad obligatoria (1, 7 o 30 días), contraseña opcional, descarga y comentarios
 * opcionales y límite de descargas. El enlace completo se muestra UNA vez: en la base de datos solo queda su hash.
 */
export function ShareDialog({ open, onClose, target, defaultTitle }: { open: boolean; onClose: () => void; target: ShareTarget | null; defaultTitle: string }) {
  return (
    <Modal open={open} onClose={onClose} title="Compartir por enlace" description="Cualquier persona con el enlace verá solo esta selección, sin crear cuenta.">
      {target ? <Form key={JSON.stringify(target)} target={target} defaultTitle={defaultTitle} onClose={onClose} /> : null}
    </Modal>
  );
}

function Form({ target, defaultTitle, onClose }: { target: ShareTarget; defaultTitle: string; onClose: () => void }) {
  const [title, setTitle] = useState(defaultTitle);
  const [message, setMessage] = useState("");
  const [days, setDays] = useState("7");
  const [password, setPassword] = useState("");
  const [canDownload, setCanDownload] = useState(false);
  const [canComment, setCanComment] = useState(false);
  const [maxDownloads, setMaxDownloads] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  const submit = () =>
    startTransition(async () => {
      setError(null);
      const limit = maxDownloads.trim() === "" ? null : Number(maxDownloads);
      const res = await createShareLink({ target, title, message, days: Number(days), password: password || undefined, canDownload, canComment, maxDownloads: limit });
      setPassword("");
      if (res.ok && res.data) setCreated(res.data.url);
      else setError(res.ok ? "No se pudo crear el enlace." : res.message);
    });

  if (created) {
    return (
      <div className="flex flex-col gap-4">
        <Notice variant="success">Enlace creado. Cópialo ahora: <span className="font-medium text-text">no se vuelve a mostrar</span>. Podrás revocarlo cuando quieras en Accesos → Enlaces.</Notice>
        <input readOnly value={created} aria-label="Enlace para compartir" onFocus={(e) => e.currentTarget.select()} className="h-10 w-full rounded-control border border-line bg-surface px-3 text-label text-text" />
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(created);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? "Copiado" : "Copiar enlace"}
          </Button>
          <Button size="sm" onClick={onClose}>
            Listo
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Input label="Título" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} required />
      <Textarea label="Mensaje (opcional)" value={message} maxLength={1000} onChange={(e) => setMessage(e.target.value)} />
      <Select label="Caduca en" value={days} onChange={(e) => setDays(e.target.value)} options={[{ value: "1", label: "1 día" }, { value: "7", label: "7 días" }, { value: "30", label: "30 días" }]} />
      <Input label="Contraseña (opcional)" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} hint="Mínimo 6 caracteres. Compártela por otro canal." />
      <div className="flex items-center justify-between gap-3">
        <span className="text-body text-text">Permitir descargar</span>
        <Toggle label="Permitir descargar" checked={canDownload} onChange={setCanDownload} />
      </div>
      {canDownload ? <Input label="Límite de descargas (opcional)" type="number" min={1} value={maxDownloads} onChange={(e) => setMaxDownloads(e.target.value)} className="w-40" /> : null}
      <div className="flex items-center justify-between gap-3">
        <span className="text-body text-text">Permitir comentarios (con nombre)</span>
        <Toggle label="Permitir comentarios" checked={canComment} onChange={setCanComment} />
      </div>
      {error ? <Notice variant="error">{error}</Notice> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Cancelar
        </Button>
        <Button type="submit" size="sm" disabled={pending || !title.trim()}>
          Crear enlace
        </Button>
      </div>
    </form>
  );
}
